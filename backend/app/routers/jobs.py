import asyncio
import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from app.db.database import get_session, engine
from app.models.job import Job, JobCreate, JobRead
from app.services.ffmpeg_render import export_path

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
    was_running = job.status == "running"
    if job.status in ("pending", "running"):
        job.status = "cancelled"
        session.add(job)
        session.commit()
        session.refresh(job)
    if was_running:
        # 実行中ジョブはComfyUI側の推論も中断する(しないとゾンビ実行がGPUレーンを塞ぐ)。
        # interruptは「現在実行中のプロンプト」を止める。対象特定はできないが、
        # 実行中ジョブのキャンセル時はそれが自ジョブである可能性が高い。
        try:
            import httpx
            httpx.post("http://localhost:8188/interrupt", timeout=5.0)
        except Exception:
            pass
    return _to_read(job)


@router.get("/{job_id}/download")
def download_job_output(job_id: int, session: Session = Depends(get_session)):
    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "completed":
        raise HTTPException(status_code=409, detail="Job not completed yet")
    params = json.loads(job.params)
    project_id = params.get("project_id")
    if not project_id:
        raise HTTPException(status_code=400, detail="No project_id in job params")
    path = export_path(project_id, job_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Output file not found")
    filename = f"render_{job_id}.mp4"
    return FileResponse(path, media_type="video/mp4",
                        headers={"Content-Disposition": f'attachment; filename="{filename}"'})


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
        last_payload = ""
        beat = 0
        while not await request.is_disconnected():
            # New session per poll (thread-safe for SQLite)
            with Session(engine) as session:
                jobs = session.exec(
                    select(Job)
                    .where(Job.project_id == project_id)
                    .order_by(Job.created_at.desc())
                    .limit(50)
                ).all()
                rows = []
                for j in jobs:
                    d = _to_read(j).model_dump(mode="json")
                    # 帯域削減: 巨大フィールドはストリームから除外
                    # (必要になった1件だけGET /jobs/{id}で取得する)
                    d.pop("params", None)
                    d.pop("result_json", None)
                    rows.append(d)
                payload = json.dumps(rows, default=str)
            # 変化があった時だけ送信(接続維持のため15秒ごとにハートビート)
            beat += 1
            if payload != last_payload or beat % 8 == 0:
                last_payload = payload
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


# ── 🌙 夜間バッチ生成(サーバ常駐ループ) ─────────────────────────────────
class NightBatchStart(BaseModel):
    project_id: int
    weights: dict[str, int]          # カット開始フレーム(文字列) → 重み1..3
    keep_in_flight: int = 2
    reset_counts: bool = True


@router.get("/nightbatch/state")
def nightbatch_state():
    from app.services import night_batch
    return night_batch.get_state()


@router.post("/nightbatch/start")
def nightbatch_start(body: NightBatchStart):
    from app.services import night_batch
    st = night_batch.get_state()
    night_batch.set_state({
        "running": True,
        "project_id": body.project_id,
        "weights": {k: int(v) for k, v in body.weights.items() if int(v) > 0},
        "keep_in_flight": max(1, min(4, body.keep_in_flight)),
        "counts": {} if body.reset_counts else st.get("counts", {}),
    })
    night_batch.ensure_started()
    return night_batch.get_state()


@router.post("/nightbatch/stop")
def nightbatch_stop():
    from app.services import night_batch
    st = night_batch.get_state()
    st["running"] = False
    night_batch.set_state(st)
    return st
