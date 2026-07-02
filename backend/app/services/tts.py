"""
TTS provider — OpenAI-compatible speech synthesis with language routing.

Japanese → Irodori-TTS (great Japanese, weak English). English → an English-
capable TTS (OpenAI TTS). For mixed text (e.g. an English lesson narrated in
Japanese) the text is split by language, each run synthesized by the right
engine, and the wavs concatenated. Engine-agnostic: swap endpoints/voices via
settings without touching callers.
"""
from __future__ import annotations

import io
import re
import wave

import httpx

from app import config
from app.config import TTS_API_URL
from app.services import settings_store as S

_JA = re.compile(r"[぀-ヿ㐀-鿿ぁ-んァ-ヶー、。「」]")
_EN = re.compile(r"[A-Za-z]")


def _is_japanese(seg: str) -> bool:
    return len(_JA.findall(seg)) >= len(_EN.findall(seg))


def split_by_language(text: str) -> list[tuple[str, str]]:
    """[(lang, segment)] — adjacent 'ja'/'en' runs split at sentence boundaries."""
    parts = re.split(r"(?<=[。．.!?！？\n])\s*", text)
    out: list[tuple[str, str]] = []
    for p in parts:
        if not p.strip():
            continue
        lang = "ja" if _is_japanese(p) else "en"
        if out and out[-1][0] == lang:
            out[-1] = (lang, out[-1][1] + p)
        else:
            out.append((lang, p))
    return out or [("ja", text)]


async def _irodori(text: str, voice: str, emoji_style: str) -> bytes:
    import os
    chosen = voice or S.get("TTS_DEFAULT_VOICE", config.TTS_DEFAULT_VOICE)
    payload = {
        "model": S.get("TTS_MODEL", config.TTS_MODEL),
        "input": (emoji_style + " " + text).strip() if emoji_style else text,
        "voice": chosen,
        "response_format": "wav",
    }
    # Apply the fine-tuned Kyoko LoRA when her voice is requested (the Irodori
    # server loads the adapter per request on top of the base checkpoint).
    lora_voice = S.get("TTS_LORA_VOICE", config.TTS_LORA_VOICE)
    lora_path = S.get("TTS_LORA_ADAPTER", config.TTS_LORA_ADAPTER)
    if lora_voice and chosen == lora_voice and lora_path and os.path.isdir(lora_path):
        payload["lora_adapter"] = lora_path
    async with httpx.AsyncClient(timeout=120.0) as c:
        r = await c.post(f"{TTS_API_URL}/v1/audio/speech", json=payload)
        r.raise_for_status()
        return r.content


async def _kokoro(text: str) -> bytes:
    """Local native English TTS (Kokoro). Returns 48kHz/PCM16 WAV (matches Irodori)
    so mixed JA+EN replies concatenate cleanly."""
    async with httpx.AsyncClient(timeout=120.0) as c:
        r = await c.post(f"{config.KOKORO_API_URL}/tts",
                         json={"text": text, "voice": S.get("EN_TTS_VOICE", config.EN_TTS_VOICE)})
        r.raise_for_status()
        return r.content


async def _english(text: str) -> bytes:
    provider = S.get("EN_TTS_PROVIDER", config.EN_TTS_PROVIDER)
    if provider == "kokoro":
        return await _kokoro(text)
    if provider != "openai":
        raise RuntimeError("英語TTS未設定")
    key = S.get("OPENAI_API_KEY", "")
    if not key:
        raise RuntimeError("OPENAI_API_KEY 未設定（英語TTSに必要）")
    async with httpx.AsyncClient(timeout=120.0) as c:
        r = await c.post(f"{config.OPENAI_BASE_URL}/audio/speech",
                         headers={"Authorization": f"Bearer {key}"},
                         json={"model": config.EN_TTS_MODEL, "input": text,
                               "voice": S.get("EN_TTS_VOICE", config.EN_TTS_VOICE),
                               "response_format": "wav"})
        r.raise_for_status()
        return r.content


def _concat_wav(chunks: list[bytes]) -> bytes:
    chunks = [c for c in chunks if c]
    if len(chunks) <= 1:
        return chunks[0] if chunks else b""
    out = io.BytesIO()
    writer: wave.Wave_write | None = None
    for c in chunks:
        try:
            w = wave.open(io.BytesIO(c), "rb")
        except Exception:
            continue
        if writer is None:
            writer = wave.open(out, "wb")
            writer.setnchannels(w.getnchannels())
            writer.setsampwidth(w.getsampwidth())
            writer.setframerate(w.getframerate())
        writer.writeframes(w.readframes(w.getnframes()))
    if writer:
        writer.close()
    return out.getvalue() or chunks[0]


async def synthesize(text: str, voice: str = "", response_format: str = "wav",
                     model: str = "", emoji_style: str = "", multilang: bool = True) -> bytes:
    """Synthesize speech. multilang=True routes JA→Irodori, EN→English TTS and
    concatenates; False forces Irodori (single Japanese voice)."""
    if not multilang:
        return await _irodori(text, voice, emoji_style)
    audio: list[bytes] = []
    for lang, seg in split_by_language(text):
        if lang == "en":
            try:
                audio.append(await _english(seg))
                continue
            except Exception:
                pass   # no English TTS → let Irodori read it (weak but no crash)
        audio.append(await _irodori(seg, voice, emoji_style))
    return _concat_wav(audio)


async def available() -> bool:
    try:
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(f"{TTS_API_URL}/health")
            return r.status_code == 200
    except Exception:
        return False
