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
    from app.services import command_api
    command_api.record_op(track.project_id, "add_track", session,
                          detail=track.name or f"track {track.id}", actor="user")
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
    proj = track.project_id
    name = track.name
    for clip in session.exec(select(Clip).where(Clip.track_id == track_id)).all():
        session.delete(clip)
    session.delete(track)
    session.commit()
    from app.services import command_api
    command_api.record_op(proj, "delete_track", session, detail=name or "", actor="user")
