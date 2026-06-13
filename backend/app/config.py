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

# ── LLM providers (capability: llm) ───────────────────────────────────────────
LLM_PROVIDER: str      = os.getenv("LLM_PROVIDER", "auto")   # auto|anthropic|openai|gemini|local
OPENAI_API_KEY: str    = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL: str   = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_MODEL: str      = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
GEMINI_API_KEY: str    = os.getenv("GEMINI_API_KEY", "")
GEMINI_BASE_URL: str   = os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai")
GEMINI_MODEL: str      = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
OLLAMA_URL: str        = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL: str      = os.getenv("OLLAMA_MODEL", "qwen2.5:7b")
