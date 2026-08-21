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
    # 新規作成でもカット境界で尺を抑える。PATCH側だけに入れていたため、
    # POST経由の配置(Sequencesの226f等)がC20の先へ5fはみ出す事故が起きた(実測)。
    clip.duration_frames = _clamp_duration_to_cut(
        session, clip, clip.start_frame, clip.duration_frames)
    session.add(clip)
    session.commit()
    session.refresh(clip)
    from app.services import command_api
    command_api.record_op(_proj_of_clip(clip, session), "add_clip", session,
                          detail=f"track {clip.track_id} @ frame {clip.start_frame}", actor="user")
    return clip


def _clamp_duration_to_cut(session, clip: Clip, start: int, dur: int) -> int:
    """映像クリップの尺をカット境界で切る。

    生成物はH3の尺スナップ(17n+5)でカット尺より長くなるため、素のまま置くと
    次のカットへはみ出す。配置経路が複数(自動配置 / テイク採用 / スクリプト)あり、
    どこか一つで対策しても別経路から壊れるので **保存の直前で一元的に** 抑える。

    「startから始めて完全にカバーできる最後のカット終端」までに収める。
    C4-C5をまとめて生成した222f のような複数カットにまたがる素材は正当なので、
    カット1個分へ一律に切ってはいけない。
    """
    from app.models import Track
    track = session.get(Track, clip.track_id)
    if not track or track.track_type != "video":
        return dur
    img = session.exec(
        select(Track).where(Track.project_id == track.project_id,
                            Track.track_type == "reference", Track.name == "Image")
    ).first()
    if not img:
        return dur
    pins = session.exec(
        select(Clip).where(Clip.track_id == img.id, Clip.asset_id.is_not(None))
        .order_by(Clip.start_frame)
    ).all()
    ends = [pins[i + 1].start_frame for i in range(0, len(pins) - 1, 2)]
    best = None
    for e in ends:
        if e >= start and (e - start + 1) <= dur:
            best = e
    return (best - start + 1) if best is not None else dur


@router.patch("/{clip_id}", response_model=ClipRead)
def update_clip(clip_id: int, data: ClipUpdate, session: Session = Depends(get_session)):
    clip = session.get(Clip, clip_id)
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    changed = data.model_dump(exclude_unset=True)
    # 尺を伸ばす変更はカット境界で抑える。縮める操作(手でトリム)は尊重する。
    #
    # ⚠ 以前「現在の尺を上限」にしていたが、これは誤り。一度短くなったクリップを
    #    正しい長さへ戻す操作まで拒否してしまい、「トリミングが短いまま直せない」
    #    不具合になった(C19で実測: 60fのクリップに118fを要求しても60fのまま)。
    #    上限はカット境界だけでよい。
    if "duration_frames" in changed:
        want = int(changed["duration_frames"])
        start = int(changed.get("start_frame", clip.start_frame))
        if want > clip.duration_frames or "start_frame" in changed:
            changed["duration_frames"] = _clamp_duration_to_cut(session, clip, start, want)
    # 🔒ロック中はロック解除以外の変更を拒否(再生成スクリプト等の誤上書きも防ぐ)
    if clip.locked and set(changed) - {"locked"}:
        raise HTTPException(status_code=409, detail="このクリップは🔒ロックされています(解除してから編集してください)")
    for field, value in changed.items():
        setattr(clip, field, value)
    session.add(clip)
    session.commit()
    session.refresh(clip)
    keys = set(changed)
    kind = ("set_speed" if keys & {"speed", "speed_ease"}
            else "set_transition" if keys & {"transition_in", "transition_frames"}
            else "set_transform" if keys & {"transform_json"}
            else "set_composite" if keys & {"opacity", "blend"}
            else "set_fade" if keys & {"fade_in_frames", "fade_out_frames"}
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
    if clip.locked:
        raise HTTPException(status_code=409, detail="このクリップは🔒ロックされています(解除してから削除してください)")
    proj = _proj_of_clip(clip, session)
    track_id = clip.track_id
    session.delete(clip)
    session.commit()
    from app.services import command_api
    command_api.record_op(proj, "delete_clip", session, detail=f"track {track_id}", actor="user")


@router.post("/scatter-beat-effects")
def scatter_beat_effects(project_id: int, effect: str = "flash", every: str = "downbeat",
                         session: Session = Depends(get_session)):
    """ビート同期エフェクトの一括散布（flash=白フラッシュ / punch=パンチイン）。"""
    from app.services import command_api
    return command_api.scatter_beat_effects(project_id, effect, session, every=every)


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
