"""
Runtime settings — user-editable overrides persisted to data/settings.json.

config.py holds defaults (from env/.env); this store lets the Settings UI change
keys / provider selections at runtime without restarting. get() returns the
stored value if present, else the config/env default. Secret values are never
returned in full to the UI (masked), but ARE used server-side.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path

from app import config

_PATH = Path(__file__).parent.parent.parent / "data" / "settings.json"
_LOCK = threading.Lock()
_CACHE: dict | None = None

# keys the UI may set; () marks secrets (masked on read-back)
KEYS = {
    "LLM_PROVIDER": False,
    "ANTHROPIC_API_KEY": True, "OPENAI_API_KEY": True, "GEMINI_API_KEY": True,
    "OPENAI_MODEL": False, "GEMINI_MODEL": False, "OLLAMA_MODEL": False,
    "TTS_DEFAULT_VOICE": False,
    "TTS_LORA_VOICE": False, "TTS_LORA_ADAPTER": False,
    "EN_TTS_PROVIDER": False, "EN_TTS_VOICE": False,
    "COMPANION_BASE_PROMPT": False,   # fixed base prompt for generating 杏子 images
    "COMPANION_GEN_SCENE": False,     # scene/quality tail (editable, decomposition-friendly)
    "COMPANION_GEN_NEGATIVE": False,  # negative prompt for generation
    "RENDER_ENCODER": False,          # auto|nvenc|x264 — video render encoder
}
SECRET = {k for k, sec in KEYS.items() if sec}


def _load() -> dict:
    global _CACHE
    if _CACHE is None:
        try:
            _CACHE = json.loads(_PATH.read_text(encoding="utf-8"))
        except Exception:
            _CACHE = {}
    return _CACHE


def get(key: str, default=None):
    """Stored override, else config/env default, else `default`."""
    v = _load().get(key)
    if v not in (None, ""):
        return v
    return getattr(config, key, default)


def set_many(updates: dict) -> None:
    with _LOCK:
        cur = _load()
        for k, v in updates.items():
            if k not in KEYS:
                continue
            if v == "":            # empty → remove override (fall back to default)
                cur.pop(k, None)
            else:
                cur[k] = v
        _PATH.parent.mkdir(parents=True, exist_ok=True)
        _PATH.write_text(json.dumps(cur, ensure_ascii=False, indent=1), encoding="utf-8")


def public_view() -> dict:
    """Settings for the UI — secrets shown only as set/unset (•••)."""
    out = {}
    for k, sec in KEYS.items():
        v = get(k, "")
        if sec:
            out[k] = "•••設定済み" if v else ""
        else:
            out[k] = v
    return out
