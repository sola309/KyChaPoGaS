"""
Command API — MCP-ready shared execution layer.

Both the LLM chat router and the MCP server call this module.
Each function accepts a SQLModel Session and returns a plain dict
that is JSON-serialisable and tool-result-safe.
"""

import json

from sqlmodel import Session, select

from app.models import Asset, Track, Clip


# ── Operation log (cross-process observability) ───────────────────────────────

def record_op(project_id: int | None, kind: str, session: Session,
              detail: str = "", actor: str = "ai") -> None:
    if project_id is None:
        return
    from app.models.oplog import OperationLog
    session.add(OperationLog(project_id=project_id, kind=kind, detail=detail, actor=actor))
    session.commit()


def _after_edit(project_id: int | None, kind: str, session: Session,
                detail: str = "", actor: str = "ai") -> None:
    """Record the edit and broadcast a live-sync signal to collaborators."""
    record_op(project_id, kind, session, detail, actor)
    if project_id is not None:
        from app.services.collab import notify_edit
        notify_edit(project_id, by=actor)


def _project_of_clip(clip: "Clip", session: Session) -> int | None:
    t = session.get(Track, clip.track_id)
    return t.project_id if t else None


def get_recent_operations(project_id: int, session: Session, limit: int = 50) -> dict:
    """Recent timeline edits (user + AI), newest first — so an assistant can see
    what the user has been doing."""
    from app.models.oplog import OperationLog
    rows = session.exec(
        select(OperationLog)
        .where(OperationLog.project_id == project_id)
        .order_by(OperationLog.id.desc())
        .limit(min(200, max(1, limit)))
    ).all()
    return {
        "operations": [
            {"ts": r.ts.isoformat() + "Z", "actor": r.actor, "kind": r.kind, "detail": r.detail}
            for r in rows
        ]
    }


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


def get_llm_state(project_id: int, session: Session) -> dict:
    """
    One-call comprehensive state for LLM context.
    Includes timeline, assets, analysis summary, running jobs, GPU status.
    """
    from app.models import Project
    from app.models.job import Job
    from app.models.analysis import AnalysisResult
    from app.services.gpu_monitor import get_gpu_status

    project = session.get(Project, project_id)
    if not project:
        return {"error": f"Project {project_id} not found"}

    state = get_project_state(project_id, session)
    assets = session.exec(select(Asset).where(Asset.project_id == project_id)).all()

    # Running / pending jobs
    jobs = session.exec(
        select(Job)
        .where(Job.project_id == project_id)
        .where(Job.status.in_(["pending", "running"]))
        .order_by(Job.created_at)
    ).all()
    active_jobs = [
        {"id": j.id, "type": j.job_type, "status": j.status,
         "progress": j.progress, "vram_estimated_mb": j.vram_estimated_mb}
        for j in jobs
    ]

    # Analysis summary
    asset_ids = [a.id for a in assets]
    analysis_parts: dict = {}
    if asset_ids:
        results = session.exec(
            select(AnalysisResult).where(AnalysisResult.asset_id.in_(asset_ids))
        ).all()
        for r in results:
            data = json.loads(r.result_json)
            if r.analysis_type == "audio_beats" and "audio" not in analysis_parts:
                analysis_parts["audio"] = {
                    "asset_id": r.asset_id,
                    "bpm": data.get("bpm"),
                    "beat_count": len(data.get("beats", [])),
                    "duration_sec": data.get("duration_sec"),
                    "tempo_label": data.get("tempo_label"),
                }
            elif r.analysis_type == "scene_changes":
                analysis_parts.setdefault("scenes", []).append({
                    "asset_id": r.asset_id,
                    "scene_count": data.get("scene_count"),
                    "avg_scene_duration_sec": data.get("avg_scene_duration_sec"),
                    "cut_density_label": data.get("cut_density_label"),
                })

    # GPU
    gpu = get_gpu_status()
    gpu_info = None
    if gpu.available and gpu.gpus:
        g = gpu.gpus[0]
        gpu_info = {
            "name": g.name,
            "vram_free_mb": g.vram_free_mb,
            "vram_total_mb": g.vram_total_mb,
            "utilization_pct": g.utilization_pct,
        }

    return {
        "project": {
            "id": project.id, "name": project.name,
            "fps": project.fps, "width": project.width, "height": project.height,
        },
        "timeline": state,
        "analysis": analysis_parts if analysis_parts else None,
        "active_jobs": active_jobs,
        "gpu": gpu_info,
    }


def get_analysis_summary(project_id: int, session: Session) -> dict:
    """Return LLM-friendly analysis summary (BPM, scenes, motion) for the project."""
    from app.models.analysis import AnalysisResult
    assets = session.exec(select(Asset).where(Asset.project_id == project_id)).all()
    asset_ids = [a.id for a in assets]
    if not asset_ids:
        return {"summary": "分析データなし", "details": {}}

    results = session.exec(
        select(AnalysisResult).where(AnalysisResult.asset_id.in_(asset_ids))
    ).all()

    audio_beats = None
    scene_data, motion_data = [], []
    for r in results:
        data = json.loads(r.result_json)
        if r.analysis_type == "audio_beats" and audio_beats is None:
            audio_beats = data
        elif r.analysis_type == "scene_changes":
            scene_data.append(data)
        elif r.analysis_type == "motion":
            motion_data.append(data)

    parts, details = [], {}
    if audio_beats:
        parts.append(
            f"テンポ: {audio_beats['tempo_label']}, "
            f"ビート数: {len(audio_beats['beats'])}, "
            f"尺: {audio_beats['duration_sec']:.1f}秒"
        )
        details["audio"] = {
            "bpm": audio_beats["bpm"],
            "beat_count": len(audio_beats["beats"]),
            "downbeat_count": len(audio_beats["downbeats"]),
            "duration_sec": audio_beats["duration_sec"],
            "tempo_label": audio_beats["tempo_label"],
            "beats_sample": audio_beats["beats"][:8],
        }
    if scene_data:
        total = sum(d["scene_count"] for d in scene_data)
        avg   = sum(d["avg_scene_duration_sec"] for d in scene_data) / len(scene_data)
        parts.append(f"シーン数: {total}, 平均シーン長: {avg:.1f}秒")
        details["scenes"] = {
            "total_scene_count": total,
            "avg_scene_duration_sec": round(avg, 2),
        }
    if motion_data:
        peak = max(d["peak_intensity"] for d in motion_data)
        parts.append(f"モーション強度ピーク: {peak:.3f}")
        details["motion"] = {"peak_intensity": round(peak, 4)}

    return {
        "summary": " / ".join(parts) if parts else "分析データなし",
        "details": details,
    }


def get_beat_grid(project_id: int, session: Session, max_beats: int = 500) -> dict:
    """
    Beat positions mapped into TIMELINE FRAME space, for beat-synced editing (音ハメ).

    Finds the first timeline audio clip whose asset has beat analysis and maps each
    beat time → timeline frame using the clip's placement and the project fps. The
    LLM can use these frames directly as cut points / clip boundaries with
    move_clip / split_clip / add_clip.
    """
    from app.models import Project
    from app.models.analysis import AnalysisResult

    project = session.get(Project, project_id)
    if not project:
        return {"error": f"Project {project_id} not found"}
    fps = project.fps

    tracks = session.exec(select(Track).where(Track.project_id == project_id)).all()
    clips = session.exec(
        select(Clip).where(Clip.track_id.in_([t.id for t in tracks]))
    ).all()
    asset_ids = list({c.asset_id for c in clips if c.asset_id})
    if not asset_ids:
        return {"error": "タイムラインに音声クリップがありません。"}

    results = session.exec(
        select(AnalysisResult)
        .where(AnalysisResult.asset_id.in_(asset_ids))
        .where(AnalysisResult.analysis_type == "audio_beats")
    ).all()
    beat_by_asset = {r.asset_id: json.loads(r.result_json) for r in results}

    target = next((c for c in clips if c.asset_id in beat_by_asset), None)
    if not target:
        return {"error": "音声のビート解析がありません。先に trigger_analysis(audio) を実行してください。"}

    data = beat_by_asset[target.asset_id]
    asset_in_sec = target.asset_in_frame / fps
    clip_end = target.start_frame + target.duration_frames
    downbeat_set = {round(t, 4) for t in data.get("downbeats", [])}

    beats = []
    for t in data.get("beats", []):
        frame = round(target.start_frame + (t - asset_in_sec) * fps)
        if frame < target.start_frame or frame > clip_end:
            continue
        beats.append({"frame": frame, "time_sec": round(t, 3), "downbeat": round(t, 4) in downbeat_set})

    bpm = data.get("bpm")
    return {
        "bpm": bpm,
        "fps": fps,
        "audio_clip_id": target.id,
        "audio_asset_id": target.asset_id,
        "beat_interval_frames": round(fps * 60 / bpm, 2) if bpm else None,
        "beat_count": len(beats),
        "downbeat_frames": [b["frame"] for b in beats if b["downbeat"]][:max_beats],
        "beats": beats[:max_beats],
        "truncated": len(beats) > max_beats,
        "note": "frame はタイムライン座標。音ハメは clip 境界/カット点をこれらの frame に合わせる。downbeat=小節頭。",
    }


def auto_cut_to_beats(project_id: int, clip_id: int, session: Session) -> dict:
    """
    Split a clip at every beat that falls within its span (音ハメ自動カット).
    Uses the project's beat grid (see get_beat_grid). The original clip is replaced
    by consecutive segments cut on the beat.
    """
    clip = session.get(Clip, clip_id)
    if not clip:
        return {"error": f"Clip {clip_id} not found"}
    track = session.get(Track, clip.track_id)
    if not track or track.project_id != project_id:
        return {"error": f"Clip {clip_id} not in project"}

    grid = get_beat_grid(project_id, session)
    if "error" in grid:
        return grid
    beats = [b["frame"] for b in grid.get("beats", [])]

    start = clip.start_frame
    end = clip.start_frame + clip.duration_frames
    cuts = sorted({bf for bf in beats if start < bf < end})
    if not cuts:
        return {"message": "クリップ範囲内にビートがありません", "created": 0}

    speed = getattr(clip, "speed", 1.0) or 1.0
    ease = getattr(clip, "speed_ease", "linear") or "linear"
    bounds = [start, *cuts, end]
    new_clips: list[Clip] = []
    for s0, s1 in zip(bounds, bounds[1:]):
        seg = Clip(
            track_id=clip.track_id, asset_id=clip.asset_id,
            start_frame=s0, duration_frames=s1 - s0,
            asset_in_frame=clip.asset_in_frame + round((s0 - start) * speed),
            speed=speed, speed_ease=ease,
        )
        session.add(seg)
        new_clips.append(seg)
    session.delete(clip)
    session.commit()
    for c in new_clips:
        session.refresh(c)
    _after_edit(project_id, "auto_cut_beats", session, detail=f"{len(new_clips)} segments")
    return {
        "original_clip_id": clip_id,
        "created": len(new_clips),
        "cut_frames": cuts,
        "new_clip_ids": [c.id for c in new_clips],
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


# ── Analysis trigger ─────────────────────────────────────────────────────────

def trigger_analysis(project_id: int, asset_id: int, analysis_type: str, session: Session) -> dict:
    """Queue an analysis job for the given asset. analysis_type: 'audio' | 'video'."""
    asset = session.get(Asset, asset_id)
    if not asset or asset.project_id != project_id:
        return {"error": f"Asset {asset_id} not found in project"}

    job_type = "analyze_audio" if analysis_type == "audio" else "analyze_video"
    job = create_job(project_id, job_type, {"asset_id": asset_id, "project_id": project_id}, session)
    return {"job_id": job["job_id"], "status": "queued", "analysis_type": analysis_type}


# ── Track operations ──────────────────────────────────────────────────────────

def add_track(project_id: int, track_type: str, name: str, session: Session) -> dict:
    """Add a new track to the project. track_type: 'video' | 'audio' | 'reference'."""
    existing = session.exec(select(Track).where(Track.project_id == project_id)).all()
    order = max((t.order for t in existing), default=-1) + 1
    track = Track(project_id=project_id, track_type=track_type, name=name, order=order)
    session.add(track)
    session.commit()
    session.refresh(track)
    _after_edit(project_id, "add_track", session, detail=track.name or "")
    return {"track_id": track.id, "name": track.name, "track_type": track.track_type, "order": track.order}


def delete_track(track_id: int, session: Session) -> dict:
    """Delete a track and all its clips."""
    track = session.get(Track, track_id)
    if not track:
        return {"error": f"Track {track_id} not found"}
    proj = track.project_id
    clips = session.exec(select(Clip).where(Clip.track_id == track_id)).all()
    for c in clips:
        session.delete(c)
    session.delete(track)
    session.commit()
    _after_edit(proj, "delete_track", session, detail=f"{len(clips)} clips")
    return {"deleted_track_id": track_id, "deleted_clip_count": len(clips)}


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
    _after_edit(project_id, "add_clip", session, detail=f"track {track_id} @ frame {start_frame}")
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
    _after_edit(_project_of_clip(clip, session), "move_clip", session,
                detail=f"{old_frame}→{clip.start_frame}")
    return {"clip_id": clip_id, "from_frame": old_frame, "to_frame": clip.start_frame}


def delete_clip(clip_id: int, session: Session) -> dict:
    clip = session.get(Clip, clip_id)
    if not clip:
        return {"error": f"Clip {clip_id} not found"}
    proj = _project_of_clip(clip, session)
    session.delete(clip)
    session.commit()
    _after_edit(proj, "delete_clip", session)
    return {"deleted_clip_id": clip_id}


def split_clip(clip_id: int, split_frame: int, session: Session) -> dict:
    clip = session.get(Clip, clip_id)
    if not clip:
        return {"error": f"Clip {clip_id} not found"}
    if split_frame <= clip.start_frame or split_frame >= clip.start_frame + clip.duration_frames:
        return {"error": "split_frame is outside the clip's range"}

    left_dur  = split_frame - clip.start_frame
    right_dur = clip.duration_frames - left_dur
    speed = clip.speed or 1.0
    # Pieces inherit speed/transition/fades. A non-linear ease can't be split
    # exactly (the bezier spans the whole original clip), so pieces fall back
    # to linear at the same speed. asset_in advances by SOURCE frames consumed
    # (timeline frames × speed) — not timeline frames.
    left  = Clip(track_id=clip.track_id, asset_id=clip.asset_id,
                 start_frame=clip.start_frame, duration_frames=left_dur,
                 asset_in_frame=clip.asset_in_frame,
                 speed=speed, speed_ease="linear",
                 transition_in=clip.transition_in, transition_frames=clip.transition_frames,
                 fade_in_frames=clip.fade_in_frames, fade_out_frames=0)
    right = Clip(track_id=clip.track_id, asset_id=clip.asset_id,
                 start_frame=split_frame, duration_frames=right_dur,
                 asset_in_frame=clip.asset_in_frame + round(left_dur * speed),
                 speed=speed, speed_ease="linear",
                 fade_in_frames=0, fade_out_frames=clip.fade_out_frames)
    session.add(left)
    session.add(right)
    session.delete(clip)
    session.commit()
    session.refresh(left)
    session.refresh(right)
    _after_edit(_project_of_clip(left, session), "split_clip", session, detail=f"@ frame {split_frame}")
    return {"left_clip_id": left.id, "right_clip_id": right.id,
            "split_at_frame": split_frame}


def get_beat_match_score(project_id: int, session: Session) -> dict:
    """
    音ハメスコア — how well the timeline's visual changes line up with the music.

    Builds a timeline-space motion curve from each video clip's per-frame
    motion_curve analysis (mapped through asset_in/speed), injects spikes at
    cut points (a cut IS a visual change), then checks every beat for a nearby
    motion peak. Returns an overall score, per-beat hits, and the weakest
    beats as edit suggestions.
    """
    import bisect
    from app.models.analysis import AnalysisResult

    grid = get_beat_grid(project_id, session)
    if "error" in grid:
        return grid
    beat_frames = [b["frame"] for b in grid.get("beats", [])]
    if not beat_frames:
        return {"error": "ビートがありません（音声解析を実行してください）"}

    from app.models import Project
    project = session.get(Project, project_id)
    fps = project.fps if project else 30.0

    # Primary video track clips
    tracks = session.exec(select(Track).where(Track.project_id == project_id)).all()
    v_tracks = [t for t in tracks if t.track_type == "video"]
    if not v_tracks:
        return {"error": "ビデオトラックがありません"}
    clips = sorted(
        session.exec(select(Clip).where(Clip.track_id == v_tracks[0].id)).all(),
        key=lambda c: c.start_frame,
    )
    if not clips:
        return {"error": "クリップがありません"}

    # Motion curves per asset (analysis_type=motion_curve)
    curves: dict[int, dict] = {}
    for c in clips:
        if c.asset_id is None or c.asset_id in curves:
            continue
        row = session.exec(
            select(AnalysisResult)
            .where(AnalysisResult.asset_id == c.asset_id)
            .where(AnalysisResult.analysis_type == "motion_curve")
        ).first()
        if row:
            curves[c.asset_id] = json.loads(row.result_json)

    # ── Timeline-space motion curve ───────────────────────────────────────
    total = max(c.start_frame + c.duration_frames for c in clips)
    timeline = [0.0] * (total + 1)
    analyzed_clips = 0
    for c in clips:
        curve = curves.get(c.asset_id or -1)
        speed = c.speed or 1.0
        if curve and curve.get("values"):
            analyzed_clips += 1
            vals, cfps = curve["values"], curve.get("fps", fps)
            for f in range(c.duration_frames):
                src_sec = (c.asset_in_frame + f * speed) / fps
                idx = int(src_sec * cfps)
                if 0 <= idx < len(vals):
                    tf = c.start_frame + f
                    if tf <= total:
                        timeline[tf] = max(timeline[tf], vals[idx])
    # Cuts are visual changes — inject a spike at every clip boundary.
    # A cut to a DIFFERENT scene is a strong change (0.8); a jump cut within
    # the same asset is much weaker visually (0.25) — otherwise the score
    # rewards machine-gunning the same scene, which reads as monotony.
    cut_frames = [c.start_frame for c in clips]
    for i, c in enumerate(clips):
        cf = c.start_frame
        if not (0 <= cf <= total):
            continue
        prev = clips[i - 1] if i > 0 else None
        same_scene = prev is not None and prev.asset_id == c.asset_id
        timeline[cf] = max(timeline[cf], 0.25 if same_scene else 0.8)

    # ── Score each beat: motion peak within ±2 frames? ────────────────────
    nonzero = sorted(v for v in timeline if v > 0)
    if not nonzero:
        return {"error": "動画クリップの motion_curve 解析がありません（動画解析を実行してください）"}
    threshold = nonzero[int(len(nonzero) * 0.6)]   # 60th percentile of activity

    win = 2
    beat_hits = []
    hits = 0
    for bf in beat_frames:
        if bf > total:
            continue
        lo, hi = max(0, bf - win), min(total, bf + win)
        peak = max(timeline[lo:hi + 1])
        hit = peak >= max(threshold, 0.05)
        hits += hit
        beat_hits.append({"frame": bf, "sec": round(bf / fps, 2),
                          "peak": round(peak, 3), "hit": bool(hit)})

    # Cut-on-beat ratio (cuts within ±3 frames of a beat)
    on_beat = 0
    for cf in cut_frames:
        i = bisect.bisect_left(beat_frames, cf)
        near = min((abs(cf - beat_frames[j]) for j in (i - 1, i) if 0 <= j < len(beat_frames)),
                   default=999)
        on_beat += near <= 3

    considered = len(beat_hits)
    score = round(100 * hits / considered) if considered else 0
    weak = [b for b in beat_hits if not b["hit"]][:20]
    return {
        "score": score,
        "beats_total": considered,
        "beats_hit": hits,
        "cuts_total": len(cut_frames),
        "cuts_on_beat": on_beat,
        "analyzed_clips": analyzed_clips,
        "unanalyzed_clips": len([c for c in clips if c.asset_id not in curves]),
        "weak_beats": weak,
        "hint": "weak_beats のフレーム位置にカット・動きの山・フラッシュを置くとスコアが上がります",
    }


def set_transform(clip_id: int, transform: str, session: Session) -> dict:
    """Set animated zoom/pan/shake on a clip. transform: preset name
    ('kenburns_in'|'kenburns_out'|'punch_in'|'punch_out'|'pan_lr'|'pan_rl'|'shake'),
    a JSON keyframe spec, or '' to clear."""
    from app.services.ffmpeg_render import parse_transform
    clip = session.get(Clip, clip_id)
    if not clip:
        return {"error": f"Clip {clip_id} not found"}
    if transform.strip() and parse_transform(transform) is None:
        return {"error": f"unknown transform: {transform}"}
    clip.transform_json = transform.strip()
    session.add(clip)
    session.commit()
    _after_edit(_project_of_clip(clip, session), "set_transform", session,
                detail=transform[:60] or "clear")
    return {"clip_id": clip_id, "transform_json": clip.transform_json}


def scatter_beat_effects(project_id: int, effect: str, session: Session,
                         every: str = "downbeat",
                         start_frame: int = 0, end_frame: int | None = None,
                         max_count: int = 32) -> dict:
    """
    ビート同期エフェクトの一括散布 — apply an effect at every (down)beat in a
    range on the primary video track, in one command.

    effect:
      'flash' — split the clip at the beat (continuous source, no jump) and set
                a short white-flash transition: a pure flash on the beat.
      'punch' — split at the beat and put a punch_in zoom (0.22s decay) on the
                right piece: the image punches on every beat (静止画MAD idiom).
    every: 'downbeat' (小節頭) or 'beat'.
    """
    grid = get_beat_grid(project_id, session)
    if "error" in grid:
        return grid
    beats = grid.get("beats", [])
    frames = [b["frame"] for b in beats
              if (every != "downbeat" or b.get("downbeat"))]
    if not frames:
        return {"error": "対象ビートがありません"}

    tracks = session.exec(select(Track).where(Track.project_id == project_id)).all()
    v_tracks = sorted([t for t in tracks if t.track_type == "video"], key=lambda t: t.order)
    if not v_tracks:
        return {"error": "ビデオトラックがありません"}
    base_track = v_tracks[0]

    applied = []
    for bf in frames:
        if bf < start_frame or (end_frame is not None and bf > end_frame):
            continue
        if len(applied) >= max_count:
            break
        clips = session.exec(select(Clip).where(Clip.track_id == base_track.id)).all()
        target = next((c for c in clips
                       if c.start_frame <= bf < c.start_frame + c.duration_frames), None)
        on_cut = any(abs(c.start_frame - bf) <= 2 for c in clips)
        if effect == "flash":
            if on_cut:       # 既にカットがある拍はトランジションだけ付与
                c = next(c for c in clips if abs(c.start_frame - bf) <= 2)
                c.transition_in = "white"
                c.transition_frames = max(c.transition_frames, 3)
                session.add(c); session.commit()
                applied.append(bf)
                continue
            if not target:
                continue
            r = split_clip(target.id, bf, session)
            if "error" in r:
                continue
            set_transition(r["right_clip_id"], "white", 3, session)
            applied.append(bf)
        elif effect == "punch":
            if not target:
                continue
            if abs(target.start_frame - bf) <= 2:    # 拍がクリップ先頭ならそのまま
                set_transform(target.id, "punch_in", session)
                applied.append(bf)
                continue
            r = split_clip(target.id, bf, session)
            if "error" in r:
                continue
            set_transform(r["right_clip_id"], "punch_in", session)
            applied.append(bf)
        else:
            return {"error": "effect must be 'flash' or 'punch'"}

    _after_edit(project_id, "scatter_effects", session,
                detail=f"{effect}×{len(applied)} every={every}")
    return {"effect": effect, "applied_at_frames": applied, "count": len(applied)}


def set_clip_speed(clip_id: int, speed: float, ease: str, session: Session) -> dict:
    """Set playback speed + accel curve. ease: 'linear'|'in'|'out'|'inout' or a
    custom bezier 'cubic:x1,y1,x2,y2'. The source span stays fixed, so the
    timeline duration auto-adjusts (faster → shorter clip)."""
    clip = session.get(Clip, clip_id)
    if not clip:
        return {"error": f"Clip {clip_id} not found"}
    sp = max(0.1, min(8.0, float(speed)))
    source_consumed = clip.duration_frames * (clip.speed or 1.0)
    clip.duration_frames = max(1, round(source_consumed / sp))
    clip.speed = sp
    clip.speed_ease = ease or "linear"
    session.add(clip)
    session.commit()
    _after_edit(_project_of_clip(clip, session), "set_speed", session,
                detail=f"x{sp} {clip.speed_ease}")
    return {"clip_id": clip_id, "speed": sp, "speed_ease": clip.speed_ease,
            "duration_frames": clip.duration_frames}


def set_transition(clip_id: int, transition: str, frames: int, session: Session) -> dict:
    """Set the transition INTO a clip (from the previous clip on its track).
    transition: '' (cut) | 'cross' | 'white' | 'black'. Duration-preserving."""
    clip = session.get(Clip, clip_id)
    if not clip:
        return {"error": f"Clip {clip_id} not found"}
    if transition not in ("", "cross", "white", "black"):
        return {"error": "transition must be '', 'cross', 'white' or 'black'"}
    clip.transition_in = transition
    clip.transition_frames = max(0, int(frames)) if transition else 0
    session.add(clip)
    session.commit()
    _after_edit(_project_of_clip(clip, session), "set_transition", session,
                detail=f"{transition or 'cut'} {clip.transition_frames}f")
    return {"clip_id": clip_id, "transition_in": clip.transition_in,
            "transition_frames": clip.transition_frames}


def set_audio_fade(clip_id: int, fade_in_frames: int, fade_out_frames: int, session: Session) -> dict:
    """Set fade-in/out on an audio clip (frames at project fps)."""
    clip = session.get(Clip, clip_id)
    if not clip:
        return {"error": f"Clip {clip_id} not found"}
    clip.fade_in_frames = max(0, int(fade_in_frames))
    clip.fade_out_frames = max(0, int(fade_out_frames))
    session.add(clip)
    session.commit()
    _after_edit(_project_of_clip(clip, session), "set_fade", session,
                detail=f"in {clip.fade_in_frames}f / out {clip.fade_out_frames}f")
    return {"clip_id": clip_id, "fade_in_frames": clip.fade_in_frames,
            "fade_out_frames": clip.fade_out_frames}


def create_job(project_id: int, job_type: str, params: dict, session: Session) -> dict:
    import json
    from app.models.job import Job
    job = Job(project_id=project_id, job_type=job_type, params=json.dumps(params))
    session.add(job)
    session.commit()
    session.refresh(job)
    return {"job_id": job.id, "job_type": job_type, "status": job.status}
