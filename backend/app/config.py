import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
LLM_MODEL: str         = os.getenv("LLM_MODEL", "claude-sonnet-4-6")
COMFYUI_URL: str       = os.getenv("COMFYUI_URL", "http://localhost:8188")
ACESTEP_API_URL: str   = os.getenv("ACESTEP_API_URL", "http://localhost:7867")
TTS_API_URL: str       = os.getenv("TTS_API_URL", "http://localhost:8088")
ASR_API_URL: str       = os.getenv("ASR_API_URL", "http://localhost:8089")   # 音声入力(Whisper)
TTS_MODEL: str         = os.getenv("TTS_MODEL", "irodori-tts")
TTS_DEFAULT_VOICE: str = os.getenv("TTS_DEFAULT_VOICE", "kyoko")

# Fixed base prompt prepended when generating new 杏子 character images (editable
# from the companion settings panel; outfit/scene text is appended after it).
COMPANION_BASE_PROMPT: str = os.getenv(
    "COMPANION_BASE_PROMPT",
    "1girl, sakura kyoko, mahou shoujo madoka magica, aoki ume, masterpiece, best quality, solo, ")
# Scene/quality tail appended after base+outfit. Kept full-body / simple-background /
# flat so See-Through can decompose cleanly; the user can edit or trim it in the UI.
COMPANION_GEN_SCENE: str = os.getenv(
    "COMPANION_GEN_SCENE",
    "flat color, vibrant colors, even lighting, full body, standing, looking at viewer, "
    "arms at sides, straight-on view, symmetrical, simple background, light grey background")
# Video render encoder: auto (NVENC if available, else x264) | nvenc | x264.
RENDER_ENCODER: str    = os.getenv("RENDER_ENCODER", "auto")

COMPANION_GEN_NEGATIVE: str = os.getenv(
    "COMPANION_GEN_NEGATIVE",
    "greyscale, monochrome, sepia, desaturated, sketch, lineart, depth of field, blurry, "
    "multiple views, crossed arms, complex background, hat, headwear, "
    "(worst quality, low quality:1.2), bad anatomy, bad hands, extra limbs, cropped")

# Fine-tuned Kyoko voice LoRA: when the requested voice == TTS_LORA_VOICE, the
# adapter at TTS_LORA_ADAPTER is applied on top of the base Irodori checkpoint
# (the server loads it per request). Trained from training-data/ (gitignored).
_REPO_ROOT = Path(__file__).parent.parent.parent
TTS_LORA_VOICE: str    = os.getenv("TTS_LORA_VOICE", "kyoko")
TTS_LORA_ADAPTER: str  = os.getenv(
    "TTS_LORA_ADAPTER",
    str(_REPO_ROOT / "training-data" / "irodori-tts" / "kyoko" / "lora_best"),
)

# ── LLM providers (capability: llm) ───────────────────────────────────────────
LLM_PROVIDER: str      = os.getenv("LLM_PROVIDER", "auto")   # auto|anthropic|openai|gemini|local
OPENAI_API_KEY: str    = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL: str   = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_MODEL: str      = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
GEMINI_API_KEY: str    = os.getenv("GEMINI_API_KEY", "")
GEMINI_BASE_URL: str   = os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai")
GEMINI_MODEL: str      = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
OLLAMA_URL: str        = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL: str      = os.getenv("OLLAMA_MODEL", "nemotron-nano")   # 主: Nemotron-3 Nano 30B-A3B(Q4)

# ── English TTS (capability: tts, language=en) ────────────────────────────────
EN_TTS_PROVIDER: str   = os.getenv("EN_TTS_PROVIDER", "kokoro")   # kokoro|openai|none
EN_TTS_VOICE: str      = os.getenv("EN_TTS_VOICE", "af_heart")     # kokoro voice (af_heart/am_michael/…)
EN_TTS_MODEL: str      = os.getenv("EN_TTS_MODEL", "tts-1")
# Local native English TTS (Kokoro-82M) — used as the "native example" voice for the
# English-tutor mode (杏子=JA teacher via Irodori, examples in native EN via Kokoro).
KOKORO_API_URL: str    = os.getenv("KOKORO_API_URL", "http://localhost:8090")
