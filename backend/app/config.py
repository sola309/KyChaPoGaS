import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
LLM_MODEL: str         = os.getenv("LLM_MODEL", "claude-sonnet-4-6")
COMFYUI_URL: str       = os.getenv("COMFYUI_URL", "http://localhost:8188")
ACESTEP_API_URL: str   = os.getenv("ACESTEP_API_URL", "http://localhost:7867")
TTS_API_URL: str       = os.getenv("TTS_API_URL", "http://localhost:8088")
TTS_MODEL: str         = os.getenv("TTS_MODEL", "irodori-tts")
TTS_DEFAULT_VOICE: str = os.getenv("TTS_DEFAULT_VOICE", "kyoko_ref")
