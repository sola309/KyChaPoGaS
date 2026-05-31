"""
Analysis API — trigger audio/video analysis and retrieve results.

POST /api/analysis/audio/{asset_id}   → enqueues analyze_audio job
POST /api/analysis/video/{asset_id}   → enqueues analyze_video job
GET  /api/analysis/{asset_id}         → list all AnalysisResult for asset
GET  /api/analysis/project/{project_id}/summary  → LLM-friendly summary
"""

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.db.database import get_session, engine
from app.models import Asset, Job, AnalysisResult, AnalysisResultRead

router = APIRouter(prefix="/analysis", tags=["analysis"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_asset_or_404(asset_id: int, session: Session) -> Asset:
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} not found")
    return asset


def _enqueue_job(job_type: str, asset_id: int, project_id: int, session: Session) -> Job:
    job = Job(
        project_id=project_id,
        job_type=job_type,
        params=json.dumps({"asset_id": asset_id, "project_id": project_id}),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


# ── Trigger endpoints ─────────────────────────────────────────────────────────

@router.post("/audio/{asset_id}", status_code=202)
def trigger_audio_analysis(asset_id: int, session: Session = Depends(get_session)):
    asset = _get_asset_or_404(asset_id, session)
    if asset.asset_type not in ("audio", "video"):
        raise HTTPException(status_code=400, detail="音声または動画ファイルのみ解析できます")
    job = _enqueue_job("analyze_audio", asset_id, asset.project_id, session)
    return {"job_id": job.id, "status": "queued"}


@router.post("/video/{asset_id}", status_code=202)
def trigger_video_analysis(asset_id: int, session: Session = Depends(get_session)):
    asset = _get_asset_or_404(asset_id, session)
    if asset.asset_type not in ("video", "generated"):
        raise HTTPException(status_code=400, detail="動画ファイルのみ解析できます")
    job = _enqueue_job("analyze_video", asset_id, asset.project_id, session)
    return {"job_id": job.id, "status": "queued"}


# ── Result retrieval ──────────────────────────────────────────────────────────

@router.get("/{asset_id}", response_model=list[AnalysisResultRead])
def get_analysis(asset_id: int, session: Session = Depends(get_session)):
    _get_asset_or_404(asset_id, session)
    results = session.exec(
        select(AnalysisResult)
        .where(AnalysisResult.asset_id == asset_id)
        .order_by(AnalysisResult.created_at.desc())
    ).all()
    return [AnalysisResultRead.from_orm(r) for r in results]


# ── LLM summary ──────────────────────────────────────────────────────────────

@router.get("/project/{project_id}/summary")
def get_project_analysis_summary(project_id: int, session: Session = Depends(get_session)):
    """
    Aggregated analysis summary for LLM context.
    Returns a structured dict describing the project's audio/video characteristics.
    """
    assets = session.exec(
        select(Asset).where(Asset.project_id == project_id)
    ).all()
    asset_ids = [a.id for a in assets]
    if not asset_ids:
        return {"summary": "分析データなし", "details": {}}

    results = session.exec(
        select(AnalysisResult)
        .where(AnalysisResult.asset_id.in_(asset_ids))
    ).all()

    audio_beats = None
    scene_data: list[dict] = []
    motion_data: list[dict] = []

    for r in results:
        data = json.loads(r.result_json)
        if r.analysis_type == "audio_beats" and audio_beats is None:
            audio_beats = data
        elif r.analysis_type == "scene_changes":
            scene_data.append(data)
        elif r.analysis_type == "motion":
            motion_data.append(data)

    summary_parts: list[str] = []
    details: dict = {}

    if audio_beats:
        summary_parts.append(
            f"テンポ: {audio_beats['tempo_label']} ({audio_beats['bpm']} BPM), "
            f"ビート数: {len(audio_beats['beats'])}, "
            f"尺: {audio_beats['duration_sec']:.1f}秒"
        )
        details["audio"] = {
            "bpm": audio_beats["bpm"],
            "beat_count": len(audio_beats["beats"]),
            "downbeat_count": len(audio_beats["downbeats"]),
            "duration_sec": audio_beats["duration_sec"],
            "tempo_label": audio_beats["tempo_label"],
        }

    if scene_data:
        total_scenes = sum(d["scene_count"] for d in scene_data)
        avg_dur = sum(d["avg_scene_duration_sec"] for d in scene_data) / len(scene_data)
        labels = list({d["cut_density_label"] for d in scene_data})
        summary_parts.append(
            f"シーン数: {total_scenes}, 平均シーン長: {avg_dur:.1f}秒, カット傾向: {', '.join(labels)}"
        )
        details["scenes"] = {
            "total_scene_count": total_scenes,
            "avg_scene_duration_sec": round(avg_dur, 2),
            "cut_density_labels": labels,
        }

    if motion_data:
        peak = max(d["peak_intensity"] for d in motion_data)
        avg  = sum(d["avg_intensity"] for d in motion_data) / len(motion_data)
        summary_parts.append(
            f"モーション強度: ピーク {peak:.3f}, 平均 {avg:.3f}"
        )
        details["motion"] = {
            "peak_intensity": round(peak, 4),
            "avg_intensity":  round(avg, 4),
        }

    return {
        "summary": " / ".join(summary_parts) if summary_parts else "分析データなし",
        "details": details,
    }
