"""
ACE-Step music generation connector.

ACE-Step 1.5 runs as an independent local service exposing an OpenAI
Chat-Completions-compatible API (the "OpenRouter" adapter):

  POST /v1/chat/completions  → generate music, returns audio as a base64 data URL
  GET  /v1/models            → list models
  GET  /health               → health check

Vocals: provide `lyrics` (with [verse]/[chorus] structure) and set
audio_config.instrumental = false. The `messages` text is then the style caption.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Optional

import httpx

from app.config import ACESTEP_API_URL

ACESTEP_TIMEOUT_S = 600.0


class AceStepConnector:
    def __init__(self, base_url: str = ACESTEP_API_URL):
        self.base_url = base_url.rstrip("/")

    async def is_available(self) -> bool:
        for path in ("/health", "/v1/models"):
            try:
                async with httpx.AsyncClient(timeout=3.0) as c:
                    r = await c.get(f"{self.base_url}{path}")
                    if r.status_code == 200:
                        return True
            except Exception:
                continue
        return False

    async def generate(
        self,
        caption: str,
        lyrics: str = "",
        duration_sec: float = 30.0,
        vocal_language: str = "en",
        instrumental: Optional[bool] = None,
        seed: int = -1,
        guidance_scale: float = 7.0,
        audio_format: str = "wav",   # wav avoids the optional torchcodec MP3 encoder
    ) -> bytes:
        """
        Generate a song and return the raw audio bytes.

        caption:      style/genre/mood description (the "prompt").
        lyrics:       lyrics for vocals; empty + instrumental=True → instrumental.
        instrumental: None → auto-detected from whether lyrics are present.
        """
        audio_config: dict = {
            "duration": duration_sec,
            "vocal_language": vocal_language,
            "format": audio_format,
        }
        if instrumental is not None:
            audio_config["instrumental"] = instrumental

        payload: dict = {
            "messages": [{"role": "user", "content": caption or "a song"}],
            "lyrics": lyrics,
            "audio_config": audio_config,
            "guidance_scale": guidance_scale,
            # We supply caption + lyrics directly; skip LLM rewriting for speed/determinism.
            "use_cot_caption": False,
            "use_cot_language": False,
            "sample_mode": False,
            "stream": False,
        }
        if seed is not None and seed >= 0:
            payload["seed"] = seed

        async with httpx.AsyncClient(timeout=ACESTEP_TIMEOUT_S) as c:
            r = await c.post(f"{self.base_url}/v1/chat/completions", json=payload)
            r.raise_for_status()
            data = r.json()

        try:
            audio = data["choices"][0]["message"]["audio"][0]["audio_url"]["url"]
        except (KeyError, IndexError, TypeError) as e:
            raise RuntimeError(f"ACE-Step のレスポンスに音声が含まれていません: {e}")

        # audio is a data URL: "data:audio/mpeg;base64,<b64>"
        if "," in audio:
            audio = audio.split(",", 1)[1]
        return base64.b64decode(audio)


# Module-level singleton
acestep = AceStepConnector()
