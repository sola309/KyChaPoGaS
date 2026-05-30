import subprocess
import json
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

    # Unknown: attempt ffprobe anyway
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
    try:
        result = subprocess.run(
            [ffprobe, "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", str(file_path)],
            capture_output=True, text=True, timeout=30,
        )
        data = json.loads(result.stdout)
    except Exception:
        atype = "video" if expect_video else "audio"
        return MediaInfo(asset_type=atype, duration_sec=None, width=None, height=None, file_size_bytes=size)

    duration = float(data.get("format", {}).get("duration", 0) or 0) or None

    video_stream = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if video_stream:
        w = video_stream.get("width")
        h = video_stream.get("height")
        return MediaInfo(asset_type="video", duration_sec=duration, width=w, height=h, file_size_bytes=size)

    return MediaInfo(asset_type="audio", duration_sec=duration, width=None, height=None, file_size_bytes=size)


def _ffprobe_exe() -> str:
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    # imageio_ffmpeg ships ffmpeg; derive ffprobe from the same directory
    ffprobe = Path(exe).parent / "ffprobe.exe"
    if ffprobe.exists():
        return str(ffprobe)
    # Some builds only ship ffmpeg — fall back to ffmpeg as probe
    return exe
