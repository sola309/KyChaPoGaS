"""
Engine Supervisor — start/stop/status the local engines (ComfyUI, ACE-Step,
Irodori-TTS, Ollama) on demand, so you only run what an app needs (VRAM-friendly).

Start/stop shell out to scripts/serve.sh <start|stop> <engine> (which daemonizes
via setsid). Status is a port probe.
"""
from __future__ import annotations

import socket
import subprocess
from pathlib import Path

_REPO = Path(__file__).parent.parent.parent.parent
_SERVE = _REPO / "scripts" / "serve.sh"

# name → (port, display, capability hint, which apps use it)
ENGINES = {
    "comfyui": {"port": 8188, "label": "ComfyUI（画像/動画生成）",  "for": ["editor"]},
    "acestep": {"port": 7867, "label": "ACE-Step（音楽生成）",      "for": ["editor"]},
    "tts":     {"port": 8088, "label": "Irodori-TTS（音声合成）",   "for": ["companion"]},
    "ollama":  {"port": 11434, "label": "Ollama（ローカルLLM）",    "for": ["companion"]},
}


def _port_up(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


def list_engines() -> list[dict]:
    return [{"name": n, "port": e["port"], "label": e["label"],
             "for": e["for"], "running": _port_up(e["port"])}
            for n, e in ENGINES.items()]


def _run(action: str, name: str) -> dict:
    if name not in ENGINES:
        return {"ok": False, "error": f"unknown engine: {name}"}
    try:
        p = subprocess.run(["bash", str(_SERVE), action, name],
                           capture_output=True, text=True, timeout=30)
        out = (p.stdout + p.stderr).strip()
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "engine": name, "action": action, "output": out[-400:],
            "running": _port_up(ENGINES[name]["port"])}


def start(name: str) -> dict:
    return _run("start", name)


def stop(name: str) -> dict:
    return _run("stop", name)
