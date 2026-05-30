from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.db.database import get_session
from app.models import Clip, ClipCreate, ClipUpdate, ClipRead

router = APIRouter(prefix="/clips", tags=["clips"])


@router.get("/", response_model=list[ClipRead])
def list_clips(track_id: int | None = None, project_id: int | None = None,
               session: Session = Depends(get_session)):
    from app.models import Track
    query = select(Clip)
    if track_id is not None:
        query = query.where(Clip.track_id == track_id)
    elif project_id is not None:
        track_ids = [t.id for t in session.exec(select(Track).where(Track.project_id == project_id)).all()]
        if not track_ids:
            return []
        query = query.where(Clip.track_id.in_(track_ids))
    return session.exec(query).all()


@router.post("/", response_model=ClipRead, status_code=201)
def create_clip(data: ClipCreate, session: Session = Depends(get_session)):
    clip = Clip.model_validate(data)
    session.add(clip)
    session.commit()
    session.refresh(clip)
    return clip


@router.patch("/{clip_id}", response_model=ClipRead)
def update_clip(clip_id: int, data: ClipUpdate, session: Session = Depends(get_session)):
    clip = session.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(clip, field, value)
    session.add(clip)
    session.commit()
    session.refresh(clip)
    return clip


@router.delete("/{clip_id}", status_code=204)
def delete_clip(clip_id: int, session: Session = Depends(get_session)):
    clip = session.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    session.delete(clip)
    session.commit()
