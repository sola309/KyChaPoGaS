"""
LLM provider — one chat() call routed to a selectable backend.

Providers (the platform's `llm` capability):
  anthropic — Anthropic SDK (cloud)
  openai    — OpenAI Chat Completions (cloud)
  gemini    — Gemini via its OpenAI-compatible endpoint (cloud)
  local     — Ollama (local, OpenAI-compatible /v1; auto-unloads when idle so it
              doesn't hog VRAM from ComfyUI / See-Through)

'auto' prefers an explicitly-configured LLM_PROVIDER, else the first available,
preferring local (no key, no cost) over cloud.
"""
from __future__ import annotations

import httpx

from app import config
from app.services import settings_store as S

_MODELS = {
    "anthropic": lambda: S.get("LLM_MODEL", config.LLM_MODEL),
    "openai":    lambda: S.get("OPENAI_MODEL", "gpt-4o-mini"),
    "gemini":    lambda: S.get("GEMINI_MODEL", "gemini-2.0-flash"),
    "local":     lambda: S.get("OLLAMA_MODEL", config.OLLAMA_MODEL),
}


def local_models() -> list[str]:
    """Installed local (Ollama) model names, for the settings switcher."""
    try:
        r = httpx.get(f"{config.OLLAMA_URL}/api/tags", timeout=2.0)
        r.raise_for_status()
        return sorted(m["name"] for m in r.json().get("models", []))
    except Exception:
        return []


def _ollama_up() -> bool:
    try:
        return httpx.get(f"{config.OLLAMA_URL}/api/version", timeout=1.5).status_code == 200
    except Exception:
        return False


def available_providers() -> list[str]:
    out = []
    ak = S.get("ANTHROPIC_API_KEY", "")
    if ak and len(ak) > 20:
        out.append("anthropic")
    if S.get("OPENAI_API_KEY", ""):
        out.append("openai")
    if S.get("GEMINI_API_KEY", ""):
        out.append("gemini")
    if _ollama_up():
        out.append("local")
    return out


def resolve(provider: str = "auto") -> str:
    if provider and provider != "auto":
        return provider
    lp = S.get("LLM_PROVIDER", "auto")
    if lp and lp != "auto":
        return lp
    avail = available_providers()
    for pref in ("local", "anthropic", "openai", "gemini"):
        if pref in avail:
            return pref
    return "local"


import re as _re

def _strip_think(text: str) -> str:
    """Remove any <think>…</think> reasoning trace a model may inline in content."""
    return _re.sub(r"<think>.*?</think>", "", text or "", flags=_re.S).strip()


def chat(messages: list[dict], system: str = "", max_tokens: int = 400,
         provider: str = "auto", model: str = "", temperature: float | None = None) -> str:
    """Return the assistant reply text. messages = [{role, content}, ...]."""
    prov = resolve(provider)
    mdl = model or _MODELS.get(prov, _MODELS["local"])()

    if prov == "anthropic":
        import anthropic
        ak = S.get("ANTHROPIC_API_KEY", "")
        if not (ak and len(ak) > 20):
            raise RuntimeError("ANTHROPIC_API_KEY 未設定")
        c = anthropic.Anthropic(api_key=ak)
        r = c.messages.create(model=mdl, max_tokens=max_tokens, system=system, messages=messages,
                              **({"temperature": temperature} if temperature is not None else {}))
        return "".join(b.text for b in r.content if getattr(b, "type", "") == "text")

    if prov == "local":
        # Ollama native API with think disabled: reasoning models (e.g. Nemotron-3
        # Nano) otherwise spend the whole token budget on a hidden <think> block and
        # return empty content. think:false is a harmless no-op for non-reasoning
        # models (e.g. Gemma). _strip_think clears any inlined trace as a fallback.
        msgs = ([{"role": "system", "content": system}] if system else []) + messages
        r = httpx.post(f"{config.OLLAMA_URL}/api/chat", timeout=120.0,
                       json={"model": mdl, "messages": msgs, "stream": False,
                             "think": False, "options": {"num_predict": max_tokens,
                                         **({"temperature": temperature} if temperature is not None else {})}})
        r.raise_for_status()
        return _strip_think(r.json().get("message", {}).get("content", ""))

    # OpenAI-compatible cloud providers (openai / gemini)
    if prov == "openai":
        base, key = config.OPENAI_BASE_URL, S.get("OPENAI_API_KEY", "")
    else:  # gemini
        base, key = config.GEMINI_BASE_URL, S.get("GEMINI_API_KEY", "")

    msgs = ([{"role": "system", "content": system}] if system else []) + messages
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    r = httpx.post(f"{base}/chat/completions", headers=headers, timeout=120.0,
                   json={"model": mdl, "messages": msgs, "max_tokens": max_tokens, **({"temperature": temperature} if temperature is not None else {})})
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]
