import subprocess
from pathlib import Path
from typing import Optional

import imageio_ffmpeg


THUMB_DIR = Path(__file__).parent.parent.parent / "data" / "thumbnails"
THUMB_SIZE = (320, 180)


def thumbnail_path(asset_id: int) -> Path:
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    return THUMB_DIR / f"{asset_id}.jpg"


def generate_video_thumbnail(src: Path, asset_id: int) -> Optional[Path]:
    out = thumbnail_path(asset_id)
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    try:
        subprocess.run(
            [ffmpeg, "-y", "-ss", "0", "-i", str(src),
             "-vframes", "1", "-vf", f"scale={THUMB_SIZE[0]}:{THUMB_SIZE[1]}:force_original_aspect_ratio=decrease",
             "-q:v", "3", str(out)],
            capture_output=True, timeout=30,
        )
        return out if out.exists() else None
    except Exception:
        return None


def generate_image_thumbnail(src: Path, asset_id: int) -> Optional[Path]:
    out = thumbnail_path(asset_id)
    try:
        from PIL import Image
        with Image.open(src) as img:
            img.thumbnail(THUMB_SIZE)
            img.convert("RGB").save(out, "JPEG", quality=80)
        return out
    except Exception:
        return None
