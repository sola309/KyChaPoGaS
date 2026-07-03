import json
import mimetypes
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, BackgroundTasks
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from app.db.database import get_session
from app.models import Asset, AssetCreate, AssetRead
from app.models.job import Job
from app.services.media_info import probe
from app.services.thumbnail import generate_video_thumbnail, generate_image_thumbnail, thumbnail_path


def _queue_proxy(session: Session, asset: Asset) -> int:
    """Queue a low-res proxy generation job for a video asset."""
    job = Job(
        project_id=asset.project_id, job_type="create_proxy",
        params=json.dumps({"asset_id": asset.id, "project_id": asset.project_id}),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job.id

ASSETS_DIR = Path(__file__).parent.parent.parent / "data" / "assets"

router = APIRouter(prefix="/assets", tags=["assets"])


def _asset_dir(project_id: int) -> Path:
    d = ASSETS_DIR / str(project_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _make_thumbnail(asset: Asset) -> None:
    src = Path(asset.file_path)
    if not src.exists():
        return
    if asset.asset_type == "video":
        generate_video_thumbnail(src, asset.id)
    elif asset.asset_type == "image":
        generate_image_thumbnail(src, asset.id)


@router.get("/", response_model=list[AssetRead])
def list_assets(project_id: int | None = None, session: Session = Depends(get_session)):
    query = select(Asset)
    if project_id is not None:
        query = query.where(Asset.project_id == project_id)
    return session.exec(query).all()


@router.post("/upload", response_model=AssetRead, status_code=201)
async def upload_asset(
    background_tasks: BackgroundTasks,
    project_id: int = Form(...),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
):
    dest_dir = _asset_dir(project_id)
    dest = dest_dir / file.filename
    # avoid name collisions
    counter = 1
    while dest.exists():
        stem, suffix = Path(file.filename).stem, Path(file.filename).suffix
        dest = dest_dir / f"{stem}_{counter}{suffix}"
        counter += 1

    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    info = probe(dest)

    asset = Asset(
        project_id=project_id,
        name=dest.name,
        asset_type=info.asset_type,
        file_path=str(dest),
        duration_sec=info.duration_sec,
        width=info.width,
        height=info.height,
        file_size_bytes=info.file_size_bytes,
    )
    session.add(asset)
    session.commit()
    session.refresh(asset)

    background_tasks.add_task(_make_thumbnail, asset)

    # Auto-generate a lightweight preview proxy for uploaded videos.
    if info.asset_type == "video":
        _queue_proxy(session, asset)

    return asset


@router.post("/{asset_id}/extract-frame", response_model=AssetRead, status_code=201)
def extract_frame(
    asset_id: int,
    background_tasks: BackgroundTasks,
    time_sec: float = 0.0,
    session: Session = Depends(get_session),
):
    """
    Extract a single frame from a video asset at ``time_sec`` and register it as a
    new image asset. Used to pick a source frame from the timeline (slider/playhead)
    for I2V keyframes or I2I input.
    """
    import subprocess
    import imageio_ffmpeg

    src_asset = session.get(Asset, asset_id)
    if not src_asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    src = Path(src_asset.file_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source file not found on disk")

    dest_dir = _asset_dir(src_asset.project_id)
    t = max(0.0, time_sec)
    dest = dest_dir / f"frame_{asset_id}_{int(t * 1000)}ms.png"
    counter = 1
    while dest.exists():
        dest = dest_dir / f"frame_{asset_id}_{int(t * 1000)}ms_{counter}.png"
        counter += 1

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    proc = subprocess.run(
        [ffmpeg, "-y", "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1", str(dest)],
        capture_output=True,
    )
    if proc.returncode != 0 or not dest.exists():
        raise HTTPException(status_code=400, detail=f"Frame extraction failed: {proc.stderr.decode()[-300:]}")

    info = probe(dest)
    asset = Asset(
        project_id=src_asset.project_id,
        name=dest.name,
        asset_type="image",
        file_path=str(dest),
        duration_sec=None,
        width=info.width,
        height=info.height,
        file_size_bytes=info.file_size_bytes,
    )
    session.add(asset)
    session.commit()
    session.refresh(asset)
    background_tasks.add_task(_make_thumbnail, asset)
    return asset


FILMSTRIP_DIR = Path(__file__).parent.parent.parent / "data" / "proxies"


@router.get("/{asset_id}/filmstrip")
def get_filmstrip(asset_id: int, count: int = 10, session: Session = Depends(get_session)):
    """A horizontal sprite of N evenly-spaced frames (cached) for the clip background."""
    import subprocess
    import imageio_ffmpeg

    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    if asset.asset_type not in ("video", "generated") or not asset.duration_sec:
        raise HTTPException(status_code=404, detail="No filmstrip for this asset")
    src = Path(asset.file_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source not found")

    n = max(2, min(40, count))
    dest_dir = FILMSTRIP_DIR / str(asset.project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{asset_id}_strip{n}.jpg"
    if not dest.exists():
        fps = n / max(0.1, asset.duration_sec)
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        proc = subprocess.run(
            [ffmpeg, "-y", "-i", str(src),
             "-vf", f"fps={fps:.4f},scale=64:36:force_original_aspect_ratio=increase,crop=64:36,tile={n}x1",
             "-frames:v", "1", str(dest)],
            capture_output=True,
        )
        if proc.returncode != 0 or not dest.exists():
            raise HTTPException(status_code=400, detail="Filmstrip generation failed")
    return FileResponse(dest, media_type="image/jpeg")


@router.get("/{asset_id}/thumbnail")
def get_thumbnail(asset_id: int, session: Session = Depends(get_session)):
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    thumb = thumbnail_path(asset_id)
    if not thumb.exists():
        # generate on demand if not yet ready
        if asset.asset_type == "video":
            generate_video_thumbnail(Path(asset.file_path), asset_id)
        elif asset.asset_type == "image":
            generate_image_thumbnail(Path(asset.file_path), asset_id)

    if not thumb.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not available")

    return FileResponse(thumb, media_type="image/jpeg")


@router.get("/{asset_id}/file")
def get_asset_file(asset_id: int, proxy: bool = False, session: Session = Depends(get_session)):
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    path = Path(asset.file_path)
    # Serve the low-res proxy for preview when requested and available.
    if proxy and asset.proxy_path and Path(asset.proxy_path).exists():
        path = Path(asset.proxy_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")
    media_type, _ = mimetypes.guess_type(str(path))
    return FileResponse(path, media_type=media_type or "application/octet-stream")


@router.post("/{asset_id}/proxy", status_code=202)
def make_proxy(asset_id: int, session: Session = Depends(get_session)):
    """Queue (or re-queue) low-res proxy generation for a video asset."""
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    job_id = _queue_proxy(session, asset)
    return {"job_id": job_id, "status": "queued"}


@router.get("/{asset_id}", response_model=AssetRead)
def get_asset(asset_id: int, session: Session = Depends(get_session)):
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


@router.delete("/{asset_id}", status_code=204)
def delete_asset(asset_id: int, session: Session = Depends(get_session)):
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    dest = Path(asset.file_path)
    if dest.exists():
        dest.unlink()
    thumb = thumbnail_path(asset_id)
    if thumb.exists():
        thumb.unlink()
    session.delete(asset)
    session.commit()


# ── 生成来歴からの再生成(要件7.4) ────────────────────────────────────────────

from pydantic import BaseModel as _BM


class RegenerateRequest(_BM):
    prompt_override: str | None = None
    seed: int | None = None          # None → 新しいシード(元seed+1000)


@router.post("/{asset_id}/regenerate", status_code=201)
def regenerate(asset_id: int, req: RegenerateRequest, session: Session = Depends(get_session)):
    """このアセットの生成条件(gen_params_json)を元に新しい生成ジョブを投入する。"""
    import json as _json
    from app.routers.generation import _create_job
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="asset not found")
    if not asset.gen_params_json:
        raise HTTPException(status_code=400, detail="このアセットには生成来歴がありません(手動アップロード等)")
    params = _json.loads(asset.gen_params_json)
    job_type = ("generate_audio" if "lyrics" in params
                else "generate_video_i2v" if params.get("model", "").startswith("wan")
                else "generate_image")
    if req.prompt_override:
        params["prompt"] = req.prompt_override
    params["seed"] = req.seed if req.seed is not None else int(params.get("seed", 0) or 0) + 1000
    params["project_id"] = asset.project_id
    params.setdefault("_lab", {})["regenerated_from"] = asset_id
    return _create_job(session, asset.project_id, job_type, params)
