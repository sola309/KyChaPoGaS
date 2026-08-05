"""
Audio analysis — BPM, beat detection, downbeat detection.

Primary engine: beat_this (CPJKU transformer, ISMIR 2024) — learned beat+downbeat
tracking, GPU-accelerated. Fallback: librosa beat_track (torch-free環境用).

Returns plain dicts so results can be stored as JSON.
"""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Any

log = logging.getLogger("audio_analyzer")

_f2b = None  # File2Beats singleton (model load is seconds — keep resident)

_SF_DECODABLE = {".wav", ".flac", ".ogg", ".aiff", ".aif"}


def _to_decodable_wav(file_path: Path) -> tuple[Path, tempfile.TemporaryDirectory | None]:
    """soundfileで読めない形式(mp3/m4a/mp4等)はffmpegでwavへ変換して返す。"""
    if file_path.suffix.lower() in _SF_DECODABLE:
        return file_path, None
    tmp = tempfile.TemporaryDirectory(prefix="beatana_")
    wav = Path(tmp.name) / "audio.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(file_path),
         "-vn", "-acodec", "pcm_s16le", "-ar", "44100", str(wav)],
        check=True, capture_output=True,
    )
    return wav, tmp


def _tempo_label(bpm: float) -> str:
    if bpm < 60:
        return f"遅い ({bpm:.0f} BPM)"
    if bpm < 100:
        return f"普通 ({bpm:.0f} BPM)"
    if bpm < 140:
        return f"速い ({bpm:.0f} BPM)"
    return f"非常に速い ({bpm:.0f} BPM)"


def _analyze_beat_this(file_path: Path) -> dict[str, Any]:
    import numpy as np
    import soundfile as sf
    import torch  # noqa: PLC0415 — lazy import (heavy)
    from beat_this.inference import File2Beats  # noqa: PLC0415

    global _f2b
    if _f2b is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        _f2b = File2Beats(checkpoint_path="final0", device=device, dbn=False)

    wav, tmp = _to_decodable_wav(file_path)
    try:
        beats, downbeats = _f2b(str(wav))
        total_sec = float(sf.info(str(wav)).duration)
    finally:
        if tmp is not None:
            tmp.cleanup()

    beats = np.asarray(beats, dtype=float)
    downbeats = np.asarray(downbeats, dtype=float)
    if len(beats) < 4:
        raise RuntimeError(f"beat_this found only {len(beats)} beats")

    ibi = np.diff(beats)
    bpm = float(60.0 / np.median(ibi))
    # グリッドの安定度(中央値IBIからの平均相対ずれ)。AI生成曲などテンポが
    # 揺れる曲の検知用 — 大きい場合はdbn=True再解析やビート単位運用を検討。
    regularity = float(np.mean(np.abs(ibi - np.median(ibi))) / np.median(ibi))

    return {
        "bpm": round(bpm, 2),
        "beats": [round(float(t), 4) for t in beats],
        "downbeats": [round(float(t), 4) for t in downbeats],
        "duration_sec": round(total_sec, 3),
        "tempo_label": _tempo_label(bpm),
        "engine": "beat_this",
        "ibi_irregularity": round(regularity, 4),
    }


def _analyze_librosa(file_path: Path) -> dict[str, Any]:
    import librosa  # noqa: PLC0415 — lazy import (heavy)
    import numpy as np

    size_mb = file_path.stat().st_size / (1024 * 1024)
    duration = None if size_mb < 10 else 300.0

    y, sr = librosa.load(str(file_path), mono=True, duration=duration)
    total_sec = float(librosa.get_duration(y=y, sr=sr))

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
    bpm = float(np.atleast_1d(tempo)[0])

    return {
        "bpm": round(bpm, 2),
        "beats": [round(t, 4) for t in beat_times],
        "downbeats": [round(t, 4) for t in beat_times[::4]],  # heuristic
        "duration_sec": round(total_sec, 3),
        "tempo_label": _tempo_label(bpm),
        "engine": "librosa",
    }


def analyze_beats(file_path: Path) -> dict[str, Any]:
    """
    Analyse an audio/video file for tempo and beat positions.

    Returns:
        {
            "bpm": float,
            "beats": [float, ...],        # beat times in seconds
            "downbeats": [float, ...],    # downbeat (bar-start) times
            "duration_sec": float,
            "tempo_label": str,           # e.g. "速い (140 BPM)"
            "engine": "beat_this" | "librosa",
            "ibi_irregularity": float,    # beat_thisのみ: グリッド安定度
        }
    """
    log.info(f"Beat analysis: {file_path.name}")
    try:
        return _analyze_beat_this(file_path)
    except Exception as e:
        log.warning(f"beat_this failed ({e}); falling back to librosa")
        return _analyze_librosa(file_path)
