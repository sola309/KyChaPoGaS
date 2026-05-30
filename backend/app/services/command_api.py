"""
Command API — MCP-ready shared execution layer.

Both the LLM chat router and the future MCP server call this module.
Each function accepts a SQLModel Session and returns a plain dict
that is JSON-serialisable and tool-result-safe.
"""

from sqlmodel import Session, select

from app.models import Asset, Track, Clip, ClipCreate, ClipUpdate


# ── Read operations ───────────────────────────────────────────────────────────

def get_project_state(project_id: int, session: Session) -> dict:
    tracks = session.exec(select(Track).where(Track.project_id == project_id)).all()
    clips  = session.exec(
        select(Clip).where(
            Clip.track_id.in_([t.id for t in tracks])
        )
    ).all()
    assets = session.exec(select(Asset).where(Asset.project_id == project_id)).all()

    return {
        "tracks": [
            {
                "id": t.id, "name": t.name,
                "track_type": t.track_type, "order": t.order,
                "clips": [
                    {
                        "id": c.id,
                        "asset_id": c.asset_id,
                        "start_frame": c.start_frame,
                        "duration_frames": c.duration_frames,
                        "asset_in_frame": c.asset_in_frame,
                        "asset_name": next(
                            (a.name for a in assets if a.id == c.asset_id), None
                        ),
                    }
                    for c in clips if c.track_id == t.id
                ],
            }
            for t in tracks
        ],
        "asset_count": len(assets),
    }


def get_assets(project_id: int, session: Session, asset_type: str | None = None) -> dict:
    query = select(Asset).where(Asset.project_id == project_id)
    if asset_type:
        query = query.where(Asset.asset_type == asset_type)
    assets = session.exec(query).all()
    return {
        "assets": [
            {
                "id": a.id, "name": a.name,
                "asset_type": a.asset_type,
                "duration_sec": a.duration_sec,
                "width": a.width, "height": a.height,
            }
            for a in assets
        ]
    }


# ── Write operations ──────────────────────────────────────────────────────────

def add_clip(
    project_id: int,
    track_id: int,
    asset_id: int | None,
    start_frame: int,
    duration_frames: int,
    session: Session,
) -> dict:
    # Verify track belongs to project
    track = session.get(Track, track_id)
    if not track or track.project_id != project_id:
        return {"error": f"Track {track_id} not found in project"}

    clip = Clip(
        track_id=track_id, asset_id=asset_id,
        start_frame=start_frame, duration_frames=duration_frames, asset_in_frame=0,
    )
    session.add(clip)
    session.commit()
    session.refresh(clip)
    return {"clip_id": clip.id, "track_id": track_id,
            "start_frame": start_frame, "duration_frames": duration_frames}


def move_clip(clip_id: int, new_start_frame: int, session: Session) -> dict:
    clip = session.get(Clip, clip_id)
    if not clip:
        return {"error": f"Clip {clip_id} not found"}
    old_frame = clip.start_frame
    clip.start_frame = max(0, new_start_frame)
    session.add(clip)
    session.commit()
    return {"clip_id": clip_id, "from_frame": old_frame, "to_frame": clip.start_frame}


def delete_clip(clip_id: int, session: Session) -> dict:
    clip = session.get(Clip, clip_id)
    if not clip:
        return {"error": f"Clip {clip_id} not found"}
    session.delete(clip)
    session.commit()
    return {"deleted_clip_id": clip_id}


def split_clip(clip_id: int, split_frame: int, session: Session) -> dict:
    clip = session.get(Clip, clip_id)
    if not clip:
        return {"error": f"Clip {clip_id} not found"}
    if split_frame <= clip.start_frame or split_frame >= clip.start_frame + clip.duration_frames:
        return {"error": "split_frame is outside the clip's range"}

    left_dur  = split_frame - clip.start_frame
    right_dur = clip.duration_frames - left_dur

    left  = Clip(track_id=clip.track_id, asset_id=clip.asset_id,
                 start_frame=clip.start_frame, duration_frames=left_dur,
                 asset_in_frame=clip.asset_in_frame)
    right = Clip(track_id=clip.track_id, asset_id=clip.asset_id,
                 start_frame=split_frame, duration_frames=right_dur,
                 asset_in_frame=clip.asset_in_frame + left_dur)
    session.add(left)
    session.add(right)
    session.delete(clip)
    session.commit()
    session.refresh(left)
    session.refresh(right)
    return {"left_clip_id": left.id, "right_clip_id": right.id,
            "split_at_frame": split_frame}


def create_job(project_id: int, job_type: str, params: dict, session: Session) -> dict:
    import json
    from app.models.job import Job
    job = Job(project_id=project_id, job_type=job_type, params=json.dumps(params))
    session.add(job)
    session.commit()
    session.refresh(job)
    return {"job_id": job.id, "job_type": job_type, "status": job.status}
