"""
ASR microservice — speech-to-text for the companion's voice input.

Runs in the Irodori-TTS venv (which already has a working GB10 torch + transformers
+ soundfile stack). Browser MediaRecorder produces webm/opus (Chrome) or mp4/aac
(Safari); we transcode any input to 16kHz mono wav with the ffmpeg CLI, then run
kotoba-whisper (Japanese-tuned Whisper) directly (NOT via the transformers ASR
pipeline, whose torchcodec import is broken against torch 2.10 in this venv).

Endpoints:
  GET  /health           → {"status","loaded"}
  POST /transcribe       → multipart file=<audio>, optional language (default ja)
                           → {"text": "..."}

Launched by scripts/serve.sh as the `asr` engine on port 8089.
"""
import os
import subprocess
import tempfile

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, UploadFile, File, Form, HTTPException

MODEL_ID = os.getenv("ASR_MODEL", "kotoba-tech/kotoba-whisper-v2.0")

app = FastAPI(title="KyChaPoGaS ASR")
_state: dict = {"processor": None, "model": None, "device": None, "dtype": None}


def _load():
    if _state["model"] is not None:
        return
    from transformers import WhisperProcessor, WhisperForConditionalGeneration
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    _state["processor"] = WhisperProcessor.from_pretrained(MODEL_ID)
    _state["model"] = WhisperForConditionalGeneration.from_pretrained(MODEL_ID, dtype=dtype).to(device).eval()
    _state["device"], _state["dtype"] = device, dtype


def _decode_to_16k_mono(raw: bytes) -> np.ndarray:
    """Transcode arbitrary browser audio (webm/opus, mp4/aac, wav…) to 16k mono."""
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as fi:
        fi.write(raw)
        src = fi.name
    dst = src + ".wav"
    try:
        subprocess.run(
            ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", src,
             "-ar", "16000", "-ac", "1", "-f", "wav", dst],
            check=True, capture_output=True,
        )
        wav, _ = sf.read(dst, dtype="float32", always_2d=False)
        if wav.ndim == 2:
            wav = wav.mean(axis=1)
        return wav.astype(np.float32)
    finally:
        for p in (src, dst):
            try: os.unlink(p)
            except OSError: pass


@app.get("/health")
def health():
    return {"status": "ok", "loaded": _state["model"] is not None, "model": MODEL_ID}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str = Form("ja")):
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty audio")
    try:
        audio = _decode_to_16k_mono(raw)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=400, detail=f"音声デコード失敗: {e.stderr.decode()[:200]}")
    if audio.size < 1600:   # < 0.1s → nothing to transcribe
        return {"text": ""}
    _load()
    feats = _state["processor"](audio, sampling_rate=16000, return_tensors="pt").input_features
    feats = feats.to(_state["device"], _state["dtype"])
    with torch.no_grad():
        ids = _state["model"].generate(feats, language=language, task="transcribe")
    text = _state["processor"].batch_decode(ids, skip_special_tokens=True)[0].strip()
    return {"text": text}


if __name__ == "__main__":
    import argparse
    import uvicorn
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8089)
    a = ap.parse_args()
    uvicorn.run(app, host=a.host, port=a.port)
