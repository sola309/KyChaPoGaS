import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
LLM_MODEL: str         = os.getenv("LLM_MODEL", "claude-sonnet-4-6")
COMFYUI_URL: str       = os.getenv("COMFYUI_URL", "http://localhost:8188")
