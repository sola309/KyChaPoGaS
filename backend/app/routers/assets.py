import mimetypes
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, BackgroundTasks
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from app.db.database import get_session
from app.models import Asset, AssetCreate, AssetRead
from app.services.media_info import probe
from app.services.thumbnail import generate_video_thumbnail, generate_image_thumbnail, thumbnail_path

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

    return asset


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
def get_asset_file(asset_id: int, session: Session = Depends(get_session)):
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    path = Path(asset.file_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")
    media_type, _ = mimetypes.guess_type(str(path))
    return FileResponse(path, media_type=media_type or "application/octet-stream")


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
