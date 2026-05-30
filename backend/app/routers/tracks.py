from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.db.database import get_session
from app.models import Track, TrackCreate, TrackRead, Clip

router = APIRouter(prefix="/tracks", tags=["tracks"])


@router.get("/", response_model=list[TrackRead])
def list_tracks(project_id: int, session: Session = Depends(get_session)):
    return session.exec(select(Track).where(Track.project_id == project_id).order_by(Track.order)).all()


@router.post("/", response_model=TrackRead, status_code=201)
def create_track(data: TrackCreate, session: Session = Depends(get_session)):
    track = Track.model_validate(data)
    session.add(track)
    session.commit()
    session.refresh(track)
    return track


@router.patch("/{track_id}", response_model=TrackRead)
def update_track(track_id: int, name: str | None = None, order: int | None = None,
                 session: Session = Depends(get_session)):
    track = session.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    if name is not None:
        track.name = name
    if order is not None:
        track.order = order
    session.add(track)
    session.commit()
    session.refresh(track)
    return track


@router.delete("/{track_id}", status_code=204)
def delete_track(track_id: int, session: Session = Depends(get_session)):
    track = session.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    for clip in session.exec(select(Clip).where(Clip.track_id == track_id)).all():
        session.delete(clip)
    session.delete(track)
    session.commit()
