"""コンポジション(入れ子のタイムライン)。設計は docs/composition-design.md。"""
import json
import mimetypes
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from app.db.database import get_session
from app.models import Asset, Clip, Track, Project, Job
from app.models.composition import Composition
from app.services import comp_render as CR

router = APIRouter(prefix="/comps", tags=["comps"])


class CompCreate(BaseModel):
    project_id: int
    name: str = "コンポジション"
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    duration_frames: int = 120
    data: dict | None = None


class CompUpdate(BaseModel):
    name: str | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    duration_frames: int | None = None
    data: dict | None = None


class CompPlace(BaseModel):
    track_id: int | None = None      # 省略時は「Comps」という映像トラック(無ければ作る)
    start_frame: int = 0
    render: bool = True


def _get(comp_id: int, session: Session) -> Composition:
    c = session.get(Composition, comp_id)
    if not c:
        raise HTTPException(404, "コンポジションがありません")
    return c


def _check_data(data: dict) -> None:
    if not isinstance(data.get("layers", []), list):
        raise HTTPException(422, "data.layers は配列にしてください")
    ids = [ly.get("id") for ly in data.get("layers", []) if isinstance(ly, dict)]
    if len(ids) != len(data.get("layers", [])) or any(not isinstance(i, str) or not i for i in ids):
        raise HTTPException(422, "レイヤーには文字列の id が要ります")
    if len(set(ids)) != len(ids):
        raise HTTPException(422, "レイヤーの id が重なっています")


# ── エンジンの配布物・コマ(固定のパスなので /{comp_id} より先に置く)──────────────

@router.get("/engine/{path:path}")
def engine_file(path: str):
    p = CR.engine_file(path)
    if not p:
        raise HTTPException(404, "not found")
    mt = "text/javascript" if p.suffix in (".js", ".mjs") else (mimetypes.guess_type(str(p))[0] or "application/octet-stream")
    # 開発中に古いエンジンが残らないように毎回確かめさせる(ETag で 304 になる)
    return FileResponse(p, media_type=mt, headers={"Cache-Control": "no-cache"})


@router.get("/vframe/{asset_id}/{n}")
def vframe(asset_id: int, n: int, fps: float = 24.0, session: Session = Depends(get_session)):
    """動画素材の n コマ目(fps で数える)。キャプチャのときエンジンが 1 コマずつ取りに来る。"""
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(404, "Asset not found")
    p = CR.video_frame(asset, n, fps)
    if not p:
        raise HTTPException(404, "frame not available")
    return FileResponse(p, media_type="image/png" if p.suffix == ".png" else "image/jpeg",
                        headers={"Cache-Control": "private, max-age=3600"})


# ── CRUD ─────────────────────────────────────────────────────────────────────

@router.get("/")
def list_comps(project_id: int, session: Session = Depends(get_session)):
    rows = session.exec(select(Composition).where(Composition.project_id == project_id)
                        .order_by(Composition.id)).all()
    out = []
    for c in rows:
        d = CR.comp_dict(c)
        d["layer_count"] = len(d["data"].get("layers", []))
        del d["data"]            # 一覧は軽く
        out.append(d)
    return out


@router.post("/", status_code=201)
def create_comp(body: CompCreate, session: Session = Depends(get_session)):
    proj = session.get(Project, body.project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    data = body.data or {"version": 1, "bg": None, "layers": []}
    _check_data(data)
    c = Composition(project_id=body.project_id, name=body.name,
                    width=body.width or proj.width, height=body.height or proj.height,
                    fps=body.fps or proj.fps, duration_frames=max(1, body.duration_frames),
                    data_json=json.dumps(data, ensure_ascii=False))
    session.add(c); session.commit(); session.refresh(c)
    if CR.find_cycle(c.id, data, session):
        session.delete(c); session.commit()
        raise HTTPException(422, "入れ子が循環しています")
    return CR.comp_dict(c)


@router.get("/{comp_id}")
def get_comp(comp_id: int, session: Session = Depends(get_session)):
    return CR.comp_dict(_get(comp_id, session))


@router.patch("/{comp_id}")
def update_comp(comp_id: int, body: CompUpdate, session: Session = Depends(get_session)):
    c = _get(comp_id, session)
    changed = False
    for k in ("name", "width", "height", "fps", "duration_frames"):
        v = getattr(body, k)
        if v is not None and v != getattr(c, k):
            setattr(c, k, v)
            changed = changed or k != "name"
    if body.data is not None:
        _check_data(body.data)
        if CR.find_cycle(comp_id, body.data, session):
            raise HTTPException(422, "入れ子が循環しています(このコンポジション自身を中に含んでいます)")
        new = json.dumps(body.data, ensure_ascii=False)
        if new != c.data_json:
            c.data_json = new
            changed = True
    if changed:
        c.rev += 1
    c.updated_at = datetime.utcnow()
    session.add(c); session.commit(); session.refresh(c)
    return CR.comp_dict(c)


@router.delete("/{comp_id}", status_code=204)
def delete_comp(comp_id: int, session: Session = Depends(get_session)):
    c = _get(comp_id, session)
    used = []
    for cl in session.exec(select(Clip).where(Clip.kind == "comp")).all():
        try:
            if json.loads(cl.attrs_json or "{}").get("comp_id") == comp_id:
                used.append(cl.id)
        except Exception:
            pass
    if used:
        raise HTTPException(409, f"タイムラインに置いてあります(クリップ {used})。先にクリップを消してください")
    for o in session.exec(select(Composition).where(Composition.project_id == c.project_id)).all():
        if o.id != comp_id and comp_id in CR.child_comp_ids(json.loads(o.data_json or "{}")):
            raise HTTPException(409, f"コンポジション「{o.name}」の中で使われています")
    session.delete(c); session.commit()


@router.post("/{comp_id}/duplicate", status_code=201)
def duplicate_comp(comp_id: int, session: Session = Depends(get_session)):
    c = _get(comp_id, session)
    n = Composition(project_id=c.project_id, name=c.name + " のコピー", width=c.width, height=c.height,
                    fps=c.fps, duration_frames=c.duration_frames, data_json=c.data_json)
    session.add(n); session.commit(); session.refresh(n)
    return CR.comp_dict(n)


# ── 描き出し・配置 ────────────────────────────────────────────────────────────

def _queue_render(c: Composition, session: Session) -> Job:
    j = Job(project_id=c.project_id, job_type="render_comp",
            params=json.dumps({"comp_id": c.id, "project_id": c.project_id, "rev": c.rev}, ensure_ascii=False))
    session.add(j); session.commit(); session.refresh(j)
    return j


@router.post("/{comp_id}/render", status_code=202)
def render_comp(comp_id: int, session: Session = Depends(get_session)):
    c = _get(comp_id, session)
    j = _queue_render(c, session)
    return {"job_id": j.id, "comp_id": comp_id, "rev": c.rev}


@router.post("/{comp_id}/place", status_code=201)
def place_comp(comp_id: int, body: CompPlace, session: Session = Depends(get_session)):
    """タイムラインに comp クリップを置く。素材は描き出しが済むと自動で入る。"""
    c = _get(comp_id, session)
    proj = session.get(Project, c.project_id)
    if body.track_id is not None:
        tr = session.get(Track, body.track_id)
        if not tr or tr.track_type != "video":
            raise HTTPException(422, "映像トラックを指定してください")
    else:
        tr = session.exec(select(Track).where(Track.project_id == c.project_id)
                          .where(Track.name == "Comps")).first()
        if not tr:
            orders = [t.order for t in session.exec(select(Track).where(Track.project_id == c.project_id)).all()]
            tr = Track(project_id=c.project_id, name="Comps", track_type="video",
                       order=(min(orders) - 1) if orders else 0)
            session.add(tr); session.commit(); session.refresh(tr)
    fps = (proj.fps if proj else c.fps) or c.fps
    dur = max(1, round(c.duration_frames * fps / c.fps))
    fresh = c.rendered_rev == c.rev and c.rendered_asset_id
    cl = Clip(track_id=tr.id, asset_id=c.rendered_asset_id if fresh else None,
              start_frame=max(0, body.start_frame), duration_frames=dur, kind="comp",
              attrs_json=json.dumps({"comp_id": c.id, "rev": c.rendered_rev if fresh else 0}, ensure_ascii=False))
    session.add(cl); session.commit(); session.refresh(cl)
    job_id = None
    if body.render and not fresh:
        job_id = _queue_render(c, session).id
    from app.services import command_api
    command_api._after_edit(c.project_id, "place_comp", session, detail=f"comp {c.id} → clip {cl.id}", actor="user")
    return {"clip_id": cl.id, "track_id": tr.id, "job_id": job_id}


@router.get("/{comp_id}/player.html", response_class=HTMLResponse)
def player(comp_id: int, mode: str = "preview", frame: int | None = None,
           session: Session = Depends(get_session)):
    c = _get(comp_id, session)
    try:
        html = CR.player_html(CR.comp_dict(c), "capture" if mode == "capture" else "preview", "", frame)
    except FileNotFoundError:
        raise HTTPException(503, "エンジン(tools/comp-kit/player.html)がまだありません")
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})
