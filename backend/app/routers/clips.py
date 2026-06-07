from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.db.database import get_session
from app.models import Clip, ClipCreate, ClipUpdate, ClipRead

router = APIRouter(prefix="/clips", tags=["clips"])


def _proj_of_clip(clip: Clip, session: Session) -> int | None:
    from app.models import Track
    t = session.get(Track, clip.track_id)
    return t.project_id if t else None


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
    from app.services import command_api
    command_api.record_op(_proj_of_clip(clip, session), "add_clip", session,
                          detail=f"track {clip.track_id} @ frame {clip.start_frame}", actor="user")
    return clip


@router.patch("/{clip_id}", response_model=ClipRead)
def update_clip(clip_id: int, data: ClipUpdate, session: Session = Depends(get_session)):
    clip = session.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    changed = data.model_dump(exclude_unset=True)
    for field, value in changed.items():
        setattr(clip, field, value)
    session.add(clip)
    session.commit()
    session.refresh(clip)
    keys = set(changed)
    kind = ("set_speed" if keys & {"speed", "speed_ease"}
            else "move_clip" if keys & {"start_frame", "track_id"}
            else "trim_clip" if keys & {"in_point", "out_point", "duration"}
            else "update_clip")
    from app.services import command_api
    command_api.record_op(_proj_of_clip(clip, session), kind, session,
                          detail=", ".join(sorted(keys)), actor="user")
    return clip


@router.delete("/{clip_id}", status_code=204)
def delete_clip(clip_id: int, session: Session = Depends(get_session)):
    clip = session.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    proj = _proj_of_clip(clip, session)
    track_id = clip.track_id
    session.delete(clip)
    session.commit()
    from app.services import command_api
    command_api.record_op(proj, "delete_clip", session, detail=f"track {track_id}", actor="user")


@router.post("/{clip_id}/auto-cut-beats")
def auto_cut_beats(clip_id: int, session: Session = Depends(get_session)):
    """Split a clip on every beat in its span (音ハメ自動カット)."""
    from app.models import Track
    from app.services import command_api
    clip = session.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    track = session.get(Track, clip.track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    return command_api.auto_cut_to_beats(track.project_id, clip_id, session)
