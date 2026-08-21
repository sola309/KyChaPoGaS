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


# ── Scenes枠の同期 ────────────────────────────────────────────────────────────

@router.post("/scenes-sync")
def scenes_sync(project_id: int, session: Session = Depends(get_session)):
    """Scenes トラックをカット割り(ピン列)へ同期する。

    AniPAFE2026 の運用方針: 生成は Scenes のカット枠に合わせて行うので、
    **全カットぶんの枠を空クリップで先に敷いておく**。生成・テイク採用は
    枠の asset_id を差し替えるだけになり、位置や尺を触らない。
    これで「配置時のはみ出し」「トリムが短いまま」系の事故が構造的に消える。

    連動の仕組み — 枠は attrs_json.cut_bind = [開始ピンID, 終了ピンID] で
    **ピンに束縛**される。カット境界を微調整(ピンを移動)しても、この同期を
    走らせれば枠が追従する。フレーム位置ではなくピンIDで結ぶのは、
    位置は編集で変わるがIDは変わらないため。

    - cut_bind を持つクリップ → ピンの現在位置から開始/尺を再計算
    - cut_bind の無い既存クリップ → 覆っているカット範囲から束縛を推定して付与
      (C4-C5 のような複数カットまたぎは [先頭カットの開始ピン, 末尾カットの終了ピン])
    - どのクリップにも覆われていないカット → 空クリップ(asset_id=None)を新規作成
    - 束縛先のピンが消えたクリップ → 触らない(勝手に消さない)
    """
    import json as _json
    from app.models import Clip

    tracks = session.exec(select(Track).where(Track.project_id == project_id)).all()
    img = next((t for t in tracks if t.track_type == "reference" and t.name == "Image"), None)
    scenes = next((t for t in tracks if t.track_type == "video" and t.name == "Scenes"), None)
    if not img or not scenes:
        raise HTTPException(status_code=404, detail="Image/Scenesトラックがありません")

    pins = session.exec(
        select(Clip).where(Clip.track_id == img.id, Clip.asset_id.is_not(None))
        .order_by(Clip.start_frame)
    ).all()
    cuts = [(pins[i], pins[i + 1]) for i in range(0, len(pins) - 1, 2)]
    pin_by_id = {p.id: p for p in pins}

    clips = session.exec(select(Clip).where(Clip.track_id == scenes.id)).all()
    moved = bound = created = 0

    # 1) 束縛済みクリップをピンの現在位置へ追従させる
    for c in clips:
        try:
            attrs = _json.loads(c.attrs_json) if c.attrs_json else {}
        except Exception:
            attrs = {}
        bind = attrs.get("cut_bind")
        if not (isinstance(bind, list) and len(bind) == 2):
            continue
        sp, ep = pin_by_id.get(bind[0]), pin_by_id.get(bind[1])
        if not sp or not ep:
            continue                      # ピンが消えた枠は触らない
        want_s, want_d = sp.start_frame, ep.start_frame - sp.start_frame + 1
        if c.start_frame != want_s or c.duration_frames != want_d:
            c.start_frame, c.duration_frames = want_s, want_d
            session.add(c); moved += 1

    # 2) 未束縛クリップに束縛を推定して付与(既存配置を壊さない)
    for c in clips:
        try:
            attrs = _json.loads(c.attrs_json) if c.attrs_json else {}
        except Exception:
            attrs = {}
        if attrs.get("cut_bind"):
            continue
        end = c.start_frame + c.duration_frames - 1
        covered = [(sp, ep) for sp, ep in cuts
                   if sp.start_frame >= c.start_frame and ep.start_frame <= end + 3]
        inside = next(((sp, ep) for sp, ep in cuts
                       if sp.start_frame <= c.start_frame <= ep.start_frame), None)
        pick = None
        if covered:
            pick = (covered[0][0], covered[-1][1])
        elif inside:
            pick = inside
        if pick:
            attrs["cut_bind"] = [pick[0].id, pick[1].id]
            c.attrs_json = _json.dumps(attrs, ensure_ascii=False)
            session.add(c); bound += 1

    # 3) 空のカットに枠を敷く
    session.flush()
    occupied = []
    for c in clips:
        occupied.append((c.start_frame, c.start_frame + c.duration_frames - 1))
    for sp, ep in cuts:
        if any(s <= sp.start_frame <= e for s, e in occupied):
            continue
        nc = Clip(track_id=scenes.id, asset_id=None, start_frame=sp.start_frame,
                  duration_frames=ep.start_frame - sp.start_frame + 1,
                  attrs_json=_json.dumps({"cut_bind": [sp.id, ep.id]}))
        session.add(nc); created += 1

    session.commit()
    return {"cuts": len(cuts), "moved": moved, "bound": bound, "created": created}
