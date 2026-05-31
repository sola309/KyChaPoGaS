"""
Background job runner.

Polls the Job table every 2 seconds for 'pending' jobs and executes them.
Runs as an asyncio task started during FastAPI lifespan.

Supported job types:
  render_final        — FFmpeg timeline render → MP4
  generate_image      — Image generation (ComfyUI stub, Phase 4b)
  generate_audio      — Audio generation (local model stub, Phase 4b)
  generate_video_i2v  — Video I2V (ComfyUI stub, Phase 4b)
"""

import asyncio
import json
import logging
from datetime import datetime

from sqlmodel import Session, select

from app.db.database import engine
from app.models.job import Job
from app.models import Track, Clip, Asset, Project

log = logging.getLogger("job_runner")


async def run_forever() -> None:
    log.info("Job runner started")
    while True:
        try:
            await _poll_once()
        except Exception as e:
            log.error(f"Job runner error: {e}")
        await asyncio.sleep(2)


async def _poll_once() -> None:
    with Session(engine) as session:
        job = session.exec(
            select(Job)
            .where(Job.status == "pending")
            .order_by(Job.created_at)
        ).first()

        if not job:
            return

        log.info(f"Executing job id={job.id} type={job.job_type}")
        job.status = "running"
        job.started_at = datetime.utcnow()
        session.add(job)
        session.commit()
        session.refresh(job)

    # Execute outside the session (long-running)
    try:
        await _dispatch(job)
        with Session(engine) as session:
            j = session.get(Job, job.id)
            j.status = "completed"
            j.progress = 1.0
            j.completed_at = datetime.utcnow()
            session.add(j)
            session.commit()
        log.info(f"Job id={job.id} completed")
    except Exception as e:
        log.error(f"Job id={job.id} failed: {e}")
        with Session(engine) as session:
            j = session.get(Job, job.id)
            j.status = "failed"
            j.error_msg = str(e)[:1000]
            j.completed_at = datetime.utcnow()
            session.add(j)
            session.commit()


def _set_progress(job_id: int, pct: float) -> None:
    """Write progress to DB (fire-and-forget, no await needed)."""
    with Session(engine) as session:
        j = session.get(Job, job_id)
        if j and j.status == "running":
            j.progress = round(pct, 3)
            session.add(j)
            session.commit()


async def _dispatch(job: Job) -> None:
    params = json.loads(job.params)
    match job.job_type:
        case "render_final":
            await _render_final(job, params)
        case "generate_image" | "generate_audio" | "generate_video_i2v":
            await _generation_stub(job, params)
        case _:
            raise ValueError(f"Unknown job type: {job.job_type}")


# ── render_final ──────────────────────────────────────────────────────────────

async def _render_final(job: Job, params: dict) -> None:
    from app.services.ffmpeg_render import render_timeline

    project_id = params["project_id"]

    with Session(engine) as session:
        project = session.get(Project, project_id)
        if not project:
            raise ValueError(f"Project {project_id} not found")

        tracks = session.exec(
            select(Track).where(Track.project_id == project_id)
        ).all()
        track_ids = [t.id for t in tracks]
        clips = session.exec(
            select(Clip).where(Clip.track_id.in_(track_ids))
        ).all()
        assets = session.exec(
            select(Asset).where(Asset.project_id == project_id)
        ).all()

        fps    = params.get("fps",    project.fps)
        width  = params.get("width",  project.width)
        height = params.get("height", project.height)

        # Detach objects from session before passing to async render
        tracks_data = list(tracks)
        clips_data  = list(clips)
        assets_data = list(assets)

    def progress_cb(pct: float):
        _set_progress(job.id, pct)

    output = await render_timeline(
        job_id=job.id,
        project_id=project_id,
        tracks=tracks_data,
        clips=clips_data,
        assets=assets_data,
        fps=float(fps),
        width=int(width),
        height=int(height),
        progress_cb=progress_cb,
    )
    log.info(f"Render complete → {output}")


# ── Generation stubs (Phase 4b) ───────────────────────────────────────────────

async def _generation_stub(job: Job, params: dict) -> None:
    """
    Placeholder for ComfyUI / local model generation.
    Simulates a 5-step job with progress updates.
    """
    log.info(f"Generation stub for job {job.id} ({job.job_type}) — ComfyUI not yet wired")
    for i in range(1, 6):
        await asyncio.sleep(1)
        _set_progress(job.id, i / 5)

    # Mark as failed with a clear message until Phase 4b is implemented
    raise RuntimeError(
        "ComfyUI connector is not yet configured. "
        "Run setup.ps1 / setup.sh to install ComfyUI, then configure backend/.env."
    )
