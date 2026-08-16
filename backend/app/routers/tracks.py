import json
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
                 hidden: bool | None = None, layout_json: str | None = None,
                 session: Session = Depends(get_session)):
    track = session.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    if name is not None:
        track.name = name
    if order is not None:
        track.order = order
    if hidden is not None:
        track.hidden = hidden
    if layout_json is not None:
        track.layout_json = layout_json     # "" で全画面に戻る
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


@router.post("/compare-layout")
def compare_layout(project_id: int, left_track_id: int | None = None,
                   right_track_id: int | None = None, enable: bool = True,
                   session: Session = Depends(get_session)):
    """比較表示: 指定した2つの映像トラックを画面の左右に並べる。

    レイヤーをコンポジションとして扱い、出力の中で左右に配置するだけなので、
    2本の動画を突き合わせる必要がなく、フレームのずれが原理的に生じない。
    enable=False で全トラックを全画面に戻す。
    """
    tracks = session.exec(select(Track).where(Track.project_id == project_id)).all()
    if not enable:
        for t in tracks:
            t.layout_json = ""
            session.add(t)
        session.commit()
        return {"enabled": False, "updated": len(tracks)}

    half = {"left":  {"x": 0.0, "y": 0.25, "w": 0.5, "h": 0.5, "fit": "contain"},
            "right": {"x": 0.5, "y": 0.25, "w": 0.5, "h": 0.5, "fit": "contain"}}
    vids = sorted([t for t in tracks if t.track_type == "video"], key=lambda t: t.order)
    # 未指定なら「最背面(order最大)を右=参照」「それ以外は左」を既定にする。
    # 制作側はレイヤーが増える(Shots/Scenes等)ので、右に置く1本を決めて
    # 残りはまとめて左へ送るほうが、レイヤーが増えても壊れない。
    rid = right_track_id if right_track_id is not None else (vids[-1].id if len(vids) > 1 else None)
    lid = left_track_id
    out = []
    for t in tracks:
        if t.track_type != "video":
            continue
        if t.id == rid:
            t.layout_json = json.dumps(half["right"])
        elif lid is None or t.id == lid:
            # 左は重ね合わせ。上のレイヤーが下を覆う通常の合成がそのまま働く。
            t.layout_json = json.dumps(half["left"])
        else:
            t.layout_json = json.dumps({"x": 0, "y": 0, "w": 0.001, "h": 0.001})  # 実質非表示
        session.add(t)
        out.append({"id": t.id, "name": t.name, "layout": t.layout_json})
    session.commit()
    return {"enabled": True, "left": lid, "right": rid, "tracks": out}
