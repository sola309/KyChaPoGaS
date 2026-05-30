import asyncio
import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select

from app.db.database import get_session, engine
from app.models.job import Job, JobCreate, JobRead

router = APIRouter(prefix="/jobs", tags=["jobs"])


def _to_read(job: Job) -> JobRead:
    return JobRead.from_orm(job)


@router.get("/", response_model=list[JobRead])
def list_jobs(project_id: int, session: Session = Depends(get_session)):
    jobs = session.exec(
        select(Job).where(Job.project_id == project_id).order_by(Job.created_at.desc())
    ).all()
    return [_to_read(j) for j in jobs]


@router.post("/", response_model=JobRead, status_code=201)
def create_job(data: JobCreate, session: Session = Depends(get_session)):
    job = Job(
        project_id=data.project_id,
        job_type=data.job_type,
        params=json.dumps(data.params),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return _to_read(job)


@router.get("/{job_id}", response_model=JobRead)
def get_job(job_id: int, session: Session = Depends(get_session)):
    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _to_read(job)


@router.post("/{job_id}/cancel", response_model=JobRead)
def cancel_job(job_id: int, session: Session = Depends(get_session)):
    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status in ("pending", "running"):
        job.status = "cancelled"
        session.add(job)
        session.commit()
        session.refresh(job)
    return _to_read(job)


@router.delete("/{job_id}", status_code=204)
def delete_job(job_id: int, session: Session = Depends(get_session)):
    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    session.delete(job)
    session.commit()


# ── SSE: リアルタイム進捗ストリーム ─────────────────────────────────────
@router.get("/stream/sse")
async def stream_jobs(project_id: int, request: Request):
    """
    Server-Sent Events endpoint.
    Pushes the full job list for the project every 2 seconds.
    """
    async def generator():
        while not await request.is_disconnected():
            # New session per poll (thread-safe for SQLite)
            with Session(engine) as session:
                jobs = session.exec(
                    select(Job)
                    .where(Job.project_id == project_id)
                    .order_by(Job.created_at.desc())
                ).all()
                payload = json.dumps(
                    [_to_read(j).model_dump(mode="json") for j in jobs],
                    default=str,
                )
            yield f"data: {payload}\n\n"
            await asyncio.sleep(2)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
