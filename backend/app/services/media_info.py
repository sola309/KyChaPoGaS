import subprocess
import json
import shutil
import sys
from pathlib import Path
from typing import Optional
from dataclasses import dataclass

import imageio_ffmpeg


@dataclass
class MediaInfo:
    asset_type: str          # video | audio | image
    duration_sec: Optional[float]
    width: Optional[int]
    height: Optional[int]
    file_size_bytes: int


_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif"}
_AUDIO_EXTS = {".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".opus"}
_VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v"}


def probe(file_path: Path) -> MediaInfo:
    ext = file_path.suffix.lower()
    size = file_path.stat().st_size

    if ext in _IMAGE_EXTS:
        return _probe_image(file_path, size)
    if ext in _AUDIO_EXTS:
        return _probe_av(file_path, size, expect_video=False)
    if ext in _VIDEO_EXTS:
        return _probe_av(file_path, size, expect_video=True)

    return _probe_av(file_path, size, expect_video=False)


def _probe_image(file_path: Path, size: int) -> MediaInfo:
    try:
        from PIL import Image
        with Image.open(file_path) as img:
            w, h = img.size
        return MediaInfo(asset_type="image", duration_sec=None, width=w, height=h, file_size_bytes=size)
    except Exception:
        return MediaInfo(asset_type="image", duration_sec=None, width=None, height=None, file_size_bytes=size)


def _probe_av(file_path: Path, size: int, *, expect_video: bool) -> MediaInfo:
    ffprobe = _ffprobe_exe()
    atype_fallback = "video" if expect_video else "audio"

    if ffprobe is None:
        # ffprobe not available — use mutagen for duration on audio/video
        return _probe_mutagen(file_path, size, atype_fallback)

    try:
        result = subprocess.run(
            [ffprobe, "-v", "quiet", "-print_format", "json",
             "-show_streams", "-show_format", str(file_path)],
            capture_output=True, text=True, timeout=30,
        )
        data = json.loads(result.stdout)
    except Exception:
        return _probe_mutagen(file_path, size, atype_fallback)

    duration = float(data.get("format", {}).get("duration", 0) or 0) or None

    video_stream = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if video_stream:
        return MediaInfo(
            asset_type="video",
            duration_sec=duration,
            width=video_stream.get("width"),
            height=video_stream.get("height"),
            file_size_bytes=size,
        )

    return MediaInfo(asset_type="audio", duration_sec=duration, width=None, height=None, file_size_bytes=size)


def _probe_mutagen(file_path: Path, size: int, asset_type: str) -> MediaInfo:
    try:
        from mutagen import File as MutagenFile
        mf = MutagenFile(str(file_path))
        duration = mf.info.length if mf and hasattr(mf, "info") and hasattr(mf.info, "length") else None
    except Exception:
        duration = None
    return MediaInfo(asset_type=asset_type, duration_sec=duration, width=None, height=None, file_size_bytes=size)


def _ffprobe_exe() -> Optional[str]:
    # 1. System ffprobe (preferred — available on DGX Spark / any system with ffmpeg installed)
    system = shutil.which("ffprobe")
    if system:
        return system

    # 2. ffprobe next to the imageio_ffmpeg bundled binary
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    suffix = ".exe" if sys.platform == "win32" else ""
    candidate = Path(exe).with_name(f"ffprobe{suffix}")
    if candidate.exists():
        return str(candidate)

    return None
