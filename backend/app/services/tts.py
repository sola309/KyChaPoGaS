"""
TTS provider — OpenAI-compatible speech synthesis.

Talks to any server exposing POST /v1/audio/speech (Irodori-TTS-Server, or any
OpenAI-compatible TTS). The platform stays engine-agnostic: swap the endpoint /
voice without touching callers. Irodori adds emoji-driven style control and
per-request LoRA (for the user's future fine-tuned voices).
"""
from __future__ import annotations

import httpx

from app.config import TTS_API_URL, TTS_MODEL, TTS_DEFAULT_VOICE


async def synthesize(text: str, voice: str = "", response_format: str = "wav",
                     model: str = "", emoji_style: str = "") -> bytes:
    """Return synthesized audio bytes. Irodori clones the reference voice given by
    `voice` (a file stem in the server's voices/). emoji_style is prepended
    (Irodori reads emojis in the input as style/emotion cues)."""
    payload = {
        "model": model or TTS_MODEL,
        "input": (emoji_style + " " + text).strip() if emoji_style else text,
        "voice": voice or TTS_DEFAULT_VOICE,
        "response_format": response_format,
    }
    async with httpx.AsyncClient(timeout=120.0) as c:
        r = await c.post(f"{TTS_API_URL}/v1/audio/speech", json=payload)
        r.raise_for_status()
        return r.content


async def available() -> bool:
    try:
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(f"{TTS_API_URL}/health")
            return r.status_code == 200
    except Exception:
        return False
