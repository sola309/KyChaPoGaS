from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.db.database import get_session
from app.models import Asset, AssetCreate, AssetRead

router = APIRouter(prefix="/assets", tags=["assets"])


@router.get("/", response_model=list[AssetRead])
def list_assets(project_id: int | None = None, session: Session = Depends(get_session)):
    query = select(Asset)
    if project_id is not None:
        query = query.where(Asset.project_id == project_id)
    return session.exec(query).all()


@router.post("/", response_model=AssetRead, status_code=201)
def create_asset(data: AssetCreate, session: Session = Depends(get_session)):
    asset = Asset.model_validate(data)
    session.add(asset)
    session.commit()
    session.refresh(asset)
    return asset


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
    session.delete(asset)
    session.commit()
