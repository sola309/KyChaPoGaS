"""🌧 雨フィルターの API(app/services/rain_fx.py を参照)。

  GET  /api/rain/defaults                 設定の既定値と範囲
  POST /api/rain/clips/{clip_id}/render   雨クリップの層を作り直す(ジョブ render_rain_layer を積む)
  POST /api/rain/clips                    新しい雨クリップを作る(層を作ってからクリップを置くジョブを積む)
  GET  /api/rain/clips/{clip_id}/takes    このクリップで作った層の一覧(新しい順。PATCH /api/clips で戻せる)
"""
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.db.database import get_session
from app.models import Asset, Clip, Job, JobRead, Track
from app.services import rain_fx

router = APIRouter(prefix="/rain", tags=["rain"])


class RenderBody(BaseModel):
    rain: dict = {}


class CreateBody(BaseModel):
    track_id: int
    start_frame: int
    duration_frames: int
    opacity: float = 1.0
    rain: dict = {}


@router.get("/defaults")
def defaults():
    return {"defaults": rain_fx.normalize({}),
            "ranges": {k: {"min": lo, "max": hi, "int": typ is int} for k, (typ, _d, lo, hi) in rain_fx.SPEC.items()}}


def _active_job_for(session: Session, clip_id: int | None, track_id: int, start: int) -> Job | None:
    for j in session.exec(select(Job).where(Job.job_type == rain_fx.JOB_TYPE,
                                            Job.status.in_(("pending", "running")))).all():
        try:
            p = json.loads(j.params)
        except ValueError:
            continue
        if clip_id is not None and p.get("clip_id") == clip_id:
            return j
        c = p.get("create") or {}
        if c.get("track_id") == track_id and c.get("start_frame") == start:
            return j
    return None


def _check_source(session: Session, project_id: int, start: int, settings: dict) -> None:
    try:
        rain_fx.resolve_source(session, project_id, start, settings)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


def _queue(session: Session, project_id: int, params: dict) -> JobRead:
    job = Job(project_id=project_id, job_type=rain_fx.JOB_TYPE, params=json.dumps(params, ensure_ascii=False))
    session.add(job)
    session.commit()
    session.refresh(job)
    return JobRead.from_orm(job)


@router.post("/clips/{clip_id}/render", response_model=JobRead, status_code=201)
def render_clip(clip_id: int, body: RenderBody, session: Session = Depends(get_session)):
    clip = session.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    if (clip.kind or "") != rain_fx.CLIP_KIND:
        raise HTTPException(status_code=422, detail="雨クリップではありません")
    if clip.locked:
        raise HTTPException(status_code=409, detail="このクリップは🔒ロックされています(解除してから作り直してください)")
    track = session.get(Track, clip.track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    busy = _active_job_for(session, clip.id, track.id, clip.start_frame)
    if busy:
        raise HTTPException(status_code=409, detail={"error": "このクリップの雨を作り直し中です", "job_id": busy.id})
    cur = rain_fx.parse_attrs(clip.attrs_json).get("rain") or {}
    settings = rain_fx.normalize(body.rain, base=cur)
    _check_source(session, track.project_id, clip.start_frame, settings)
    return _queue(session, track.project_id, {"project_id": track.project_id, "clip_id": clip.id, "rain": settings})


@router.post("/clips", response_model=JobRead, status_code=201)
def create_rain_clip(body: CreateBody, session: Session = Depends(get_session)):
    track = session.get(Track, body.track_id)
    if not track or track.track_type != "video":
        raise HTTPException(status_code=422, detail="雨クリップは映像トラックに置いてください")
    if body.duration_frames < 1 or body.start_frame < 0:
        raise HTTPException(status_code=422, detail="位置と長さを確かめてください")
    busy = _active_job_for(session, None, track.id, body.start_frame)
    if busy:
        raise HTTPException(status_code=409, detail={"error": "この位置の雨を作成中です", "job_id": busy.id})
    settings = rain_fx.normalize(body.rain)
    _check_source(session, track.project_id, body.start_frame, settings)
    create = {"track_id": track.id, "start_frame": body.start_frame, "duration_frames": body.duration_frames,
              "opacity": rain_fx.clamp_opacity(body.opacity)}
    return _queue(session, track.project_id, {"project_id": track.project_id, "create": create, "rain": settings})


@router.get("/clips/{clip_id}/takes")
def list_takes(clip_id: int, session: Session = Depends(get_session)):
    clip = session.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    track = session.get(Track, clip.track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    rows = session.exec(select(Asset).where(Asset.project_id == track.project_id,
                                            Asset.gen_params_json.contains('"rain_fx"'))
                        .order_by(Asset.id.desc())).all()
    out = []
    for a in rows:
        try:
            g = json.loads(a.gen_params_json or "{}").get("rain_fx") or {}
        except ValueError:
            continue
        same_clip = g.get("clip_id") == clip.id
        same_place = g.get("track_id") == clip.track_id and g.get("start_frame") == clip.start_frame
        if not (same_clip or same_place or a.id == clip.asset_id):
            continue
        out.append({"asset_id": a.id, "name": a.name, "created_at": a.created_at.isoformat() + "Z",
                    "start_frame": g.get("start_frame"), "duration_frames": g.get("duration_frames"),
                    "job_id": g.get("job_id"), "cover_mean": g.get("cover_mean"),
                    "base_asset_ids": sorted({b.get("asset_id") for b in (g.get("base") or []) if b.get("asset_id")}),
                    "rain": rain_fx.normalize(g), "current": a.id == clip.asset_id})
    return out
