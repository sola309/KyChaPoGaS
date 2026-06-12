"""
Video analysis — scene change detection + motion intensity.

Scene detection: PySceneDetect (ContentDetector)
Motion intensity: OpenCV frame-difference sampling
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

log = logging.getLogger("video_analyzer")

# How many frames to sample per second for motion analysis (lower = faster)
_MOTION_SAMPLE_FPS = 5


def analyze_scenes(file_path: Path) -> dict[str, Any]:
    """
    Detect scene changes in a video file.

    Returns:
        {
            "scenes": [
                {"start_sec": float, "end_sec": float, "duration_sec": float},
                ...
            ],
            "scene_count": int,
            "avg_scene_duration_sec": float,
            "cut_density_label": str,   # e.g. "高速カット", "標準", "長め"
        }
    """
    try:
        from scenedetect import open_video, SceneManager  # noqa: PLC0415
        from scenedetect.detectors import ContentDetector  # noqa: PLC0415
    except ImportError as e:
        raise RuntimeError(f"scenedetect is not installed: {e}")

    log.info(f"Scene detection: {file_path.name}")

    video = open_video(str(file_path))
    manager = SceneManager()
    manager.add_detector(ContentDetector(threshold=27.0))
    manager.detect_scenes(video, show_progress=False)
    scene_list = manager.get_scene_list()

    scenes = []
    for start_tc, end_tc in scene_list:
        start_s = start_tc.get_seconds()
        end_s   = end_tc.get_seconds()
        scenes.append({
            "start_sec":    round(start_s, 3),
            "end_sec":      round(end_s,   3),
            "duration_sec": round(end_s - start_s, 3),
        })

    scene_count  = len(scenes)
    avg_duration = (
        sum(s["duration_sec"] for s in scenes) / scene_count if scene_count else 0.0
    )

    if avg_duration < 1.5:
        cut_label = "超高速カット"
    elif avg_duration < 3.0:
        cut_label = "高速カット"
    elif avg_duration < 6.0:
        cut_label = "標準"
    else:
        cut_label = "長めのカット"

    return {
        "scenes": scenes,
        "scene_count": scene_count,
        "avg_scene_duration_sec": round(avg_duration, 3),
        "cut_density_label": cut_label,
    }


def analyze_motion_curve(file_path: Path) -> dict[str, Any]:
    """
    Per-frame inter-frame difference curve (画面の変化量を数値化).

    Full frame-rate resolution so the curve can be aligned with a beat grid
    (beat interval at 172 bpm ≈ 0.35 s — 1 s segments are far too coarse).

    Returns:
        {
            "fps": float,            # sampling rate (= video fps)
            "values": [float, ...],  # 0..1 mean-abs-diff per frame pair;
                                     # values[i] = diff(frame i, frame i+1)
            "frame_count": int,
        }
    """
    try:
        import cv2  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415
    except ImportError as e:
        raise RuntimeError(f"opencv-python is not installed: {e}")

    log.info(f"Motion curve: {file_path.name}")

    cap = cv2.VideoCapture(str(file_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {file_path}")

    video_fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    values: list[float] = []
    prev_gray = None

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        # Downscale for speed — diff statistics are stable at low res
        small = cv2.resize(frame, (160, 90), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        if prev_gray is not None:
            diff = cv2.absdiff(gray, prev_gray)
            values.append(round(float(np.mean(diff)) / 255.0, 4))
        prev_gray = gray

    cap.release()
    return {
        "fps": round(video_fps, 3),
        "values": values,
        "frame_count": len(values) + 1,
    }


def analyze_motion(file_path: Path) -> dict[str, Any]:
    """
    Compute motion intensity (frame-difference mean) at sampled intervals.

    Returns:
        {
            "segments": [
                {"start_sec": float, "end_sec": float, "intensity": float},
                ...
            ],
            "peak_intensity": float,
            "avg_intensity": float,
        }
    """
    try:
        import cv2  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415
    except ImportError as e:
        raise RuntimeError(f"opencv-python is not installed: {e}")

    log.info(f"Motion analysis: {file_path.name}")

    cap = cv2.VideoCapture(str(file_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {file_path}")

    video_fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    frame_skip = max(1, int(video_fps / _MOTION_SAMPLE_FPS))

    segments: list[dict] = []
    prev_gray = None
    frame_idx = 0
    seg_start_sec = 0.0
    seg_intensities: list[float] = []
    seg_len_frames = int(video_fps)   # 1-second segments

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_skip == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if prev_gray is not None:
                diff = cv2.absdiff(gray, prev_gray)
                intensity = float(np.mean(diff)) / 255.0
                seg_intensities.append(intensity)
            prev_gray = gray

        # Flush segment every ~1 s
        if frame_idx > 0 and frame_idx % seg_len_frames == 0:
            if seg_intensities:
                seg_end_sec = frame_idx / video_fps
                segments.append({
                    "start_sec":  round(seg_start_sec, 3),
                    "end_sec":    round(seg_end_sec, 3),
                    "intensity":  round(float(np.mean(seg_intensities)), 4),
                })
                seg_start_sec = seg_end_sec
                seg_intensities = []

        frame_idx += 1

    cap.release()

    # Final segment
    if seg_intensities:
        import numpy as np  # already imported above but re-import safe
        seg_end_sec = frame_idx / video_fps
        segments.append({
            "start_sec":  round(seg_start_sec, 3),
            "end_sec":    round(seg_end_sec, 3),
            "intensity":  round(float(np.mean(seg_intensities)), 4),
        })

    all_intensities = [s["intensity"] for s in segments]
    peak = round(max(all_intensities), 4) if all_intensities else 0.0
    avg  = round(sum(all_intensities) / len(all_intensities), 4) if all_intensities else 0.0

    return {
        "segments":       segments,
        "peak_intensity": peak,
        "avg_intensity":  avg,
    }
