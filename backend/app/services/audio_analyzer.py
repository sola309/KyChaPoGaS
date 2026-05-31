"""
Audio analysis — BPM, beat detection, downbeat detection.
Uses librosa for all signal processing.

Returns plain dicts so results can be stored as JSON.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

log = logging.getLogger("audio_analyzer")


def analyze_beats(file_path: Path) -> dict[str, Any]:
    """
    Analyse an audio/video file for tempo and beat positions.

    Returns:
        {
            "bpm": float,
            "beats": [float, ...],        # beat times in seconds
            "downbeats": [float, ...],    # downbeat times (every 4th beat heuristic)
            "duration_sec": float,
            "tempo_label": str,           # e.g. "速い (140 BPM)"
        }
    """
    try:
        import librosa  # noqa: PLC0415 — lazy import (heavy)
        import numpy as np
    except ImportError as e:
        raise RuntimeError(f"librosa is not installed: {e}")

    log.info(f"Beat analysis: {file_path.name}")

    # Load mono at native sample rate (max 60 s for speed; full file if < 10 MB)
    size_mb = file_path.stat().st_size / (1024 * 1024)
    duration = None if size_mb < 10 else 300.0

    y, sr = librosa.load(str(file_path), mono=True, duration=duration)
    total_sec = float(librosa.get_duration(y=y, sr=sr))

    # Tempo and beat tracking
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()

    bpm = float(np.atleast_1d(tempo)[0])

    # Heuristic downbeats: every 4th beat starting at first beat
    downbeats = beat_times[::4]

    # Tempo label
    if bpm < 60:
        label = f"遅い ({bpm:.0f} BPM)"
    elif bpm < 100:
        label = f"普通 ({bpm:.0f} BPM)"
    elif bpm < 140:
        label = f"速い ({bpm:.0f} BPM)"
    else:
        label = f"非常に速い ({bpm:.0f} BPM)"

    return {
        "bpm": round(bpm, 2),
        "beats": [round(t, 4) for t in beat_times],
        "downbeats": [round(t, 4) for t in downbeats],
        "duration_sec": round(total_sec, 3),
        "tempo_label": label,
    }
