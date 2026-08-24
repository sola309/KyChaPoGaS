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


def _slim_params(p: dict) -> dict:
    """一覧・SSE用にプロンプト本文を落とす。

    実測で一覧応答857KBの86%がH3プロンプト(1本4-15KB)だった。フロントは
    ジョブのparams.promptを一切読まない(再生成はasset.gen_params_json側を使う)ので、
    落としても壊れない。SSEは2秒ごとに全件再送するため、ここが最大の帯域源。
    先頭だけ残して文字数を付す(「プロンプトあり」の表示判定用)。
    個別取得(GET /jobs/{id})は従来どおり全文を返す。
    """
    out = dict(p)
    for k in ("prompt", "negative_prompt"):
        v = out.get(k)
        if isinstance(v, str) and len(v) > 120:
            out[k + "_chars"] = len(v)
            out[k] = v[:120]
    return out


def _to_read(job: Job, slim: bool = False) -> JobRead:
    r = JobRead.from_orm(job)
    if slim and isinstance(r.params, dict):
        r.params = _slim_params(r.params)
    return r


@router.get("/", response_model=list[JobRead])
def list_jobs(project_id: int, session: Session = Depends(get_session)):
    jobs = session.exec(
        select(Job).where(Job.project_id == project_id).order_by(Job.created_at.desc())
    ).all()
    return [_to_read(j, slim=True) for j in jobs]


@router.post("/", response_model=JobRead, status_code=201)
def create_job(data: JobCreate, session: Session = Depends(get_session)):
    # 最終関門: H3プロンプトの構造検証。スクリプトを迂回してここへ直接POSTしても走る。
    # params に skip_validation=true を明示したときだけ通す(明示はparamsに残る)。
    if data.job_type == "generate_video_i2v":
        from app.services.prompt_gate import validate_video_prompt
        problems = validate_video_prompt(data.project_id, data.params or {})
        if problems:
            raise HTTPException(status_code=422, detail={
                "error": "プロンプトが規約を満たしていません",
                "problems": problems,
                "hint": "docs/anipafe2026-prompt-constitution.md を参照。"
                        "意図的に通す場合は params.skip_validation=true を明示",
            })
    job = Job(
        project_id=data.project_id,
        job_type=data.job_type,
        params=json.dumps(data.params),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return _to_read(job)


@router.get("/renders")
def list_renders(project_id: int, session: Session = Depends(get_session)):
    """書き出し済みファイルの一覧。

    ルート宣言は "/{job_id}" より前に置くこと(でないと renders が job_id として食われる)。
    ファイルが実在するものだけを、新しい順で返す。
    """
    jobs = session.exec(
        select(Job)
        .where(Job.project_id == project_id, Job.job_type == "render_final",
               Job.status == "completed")
        .order_by(Job.created_at.desc())
    ).all()
    rows = []
    for j in jobs:
        path = export_path(project_id, j.id)
        if not path.exists():
            continue
        try:
            params = json.loads(j.params)
        except Exception:
            params = {}
        review = path.with_name(f"{j.id}_review.mp4")
        rows.append({
            "job_id": j.id,
            "filename": f"render_{j.id}.mp4",
            "size_bytes": path.stat().st_size,
            # レビュー版(960px/crf30/faststart)。ネットワーク越しの確認用に本編の1/100前後。
            "review_size_bytes": review.stat().st_size if review.exists() else None,
            "review_url": f"/api/jobs/{j.id}/download?variant=review" if review.exists() else None,
            "stream_url": f"/api/jobs/{j.id}/stream?variant={'review' if review.exists() else 'full'}",
            "created_at": (j.completed_at or j.created_at).isoformat(),
            "width": params.get("width"),
            "height": params.get("height"),
            "fps": params.get("fps"),
            # encoder=x264_fast は 720pレビュー プリセット
            "preset": "レビュー" if params.get("encoder") == "x264_fast" else "本番",
            "download_url": f"/api/jobs/{j.id}/download",
        })
    return rows


@router.delete("/renders/{job_id}", status_code=204)
def delete_render(job_id: int, session: Session = Depends(get_session)):
    """書き出しファイルだけを消す(ジョブ履歴は残す)。"""
    job = session.get(Job, job_id)
    if not job or job.job_type != "render_final":
        raise HTTPException(status_code=404, detail="Render not found")
    params = json.loads(job.params)
    project_id = params.get("project_id")
    if not project_id:
        raise HTTPException(status_code=400, detail="No project_id in job params")
    path = export_path(project_id, job_id)
    if path.exists():
        path.unlink()
    return None


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


def _render_file(job_id: int, session: Session, variant: str):
    """書き出しファイルの実体を引く。variant='review' は軽量版(無ければ本番へ落ちる)。"""
    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "completed":
        raise HTTPException(status_code=409, detail="Job not completed yet")
    params = json.loads(job.params)
    project_id = params.get("project_id") or job.project_id
    if not project_id:
        raise HTTPException(status_code=400, detail="No project_id in job params")
    path = export_path(project_id, job_id)
    if variant == "review":
        review = path.with_name(f"{job_id}_review.mp4")
        if review.exists():
            return review, f"render_{job_id}_review.mp4"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Output file not found")
    return path, f"render_{job_id}.mp4"


@router.get("/{job_id}/download")
def download_job_output(job_id: int, variant: str = "full",
                        session: Session = Depends(get_session)):
    path, filename = _render_file(job_id, session, variant)
    return FileResponse(path, media_type="video/mp4",
                        headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/{job_id}/stream")
def stream_job_output(job_id: int, variant: str = "review",
                      session: Session = Depends(get_session)):
    """パネル内プレビュー用。Content-Disposition を付けず inline で返す。"""
    path, _ = _render_file(job_id, session, variant)
    return FileResponse(path, media_type="video/mp4")


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
                # 実行中・待機中は件数を切らずに必ず全部送る。
                # (直近50件だけを送ると、キューが長いときに古い実行中ジョブが
                #  枠外に落ちてUIの進捗が止まって見える)
                active = session.exec(
                    select(Job)
                    .where(Job.project_id == project_id)
                    .where(Job.status.in_(("running", "pending")))
                    .order_by(Job.created_at.desc())
                ).all()
                recent = session.exec(
                    select(Job)
                    .where(Job.project_id == project_id)
                    .order_by(Job.created_at.desc())
                    .limit(50)
                ).all()
                seen: set[int] = set()
                jobs = []
                for j in [*active, *recent]:
                    if j.id not in seen:
                        seen.add(j.id)
                        jobs.append(j)
                jobs.sort(key=lambda j: (j.created_at, j.id), reverse=True)
                rows = []
                for j in jobs:
                    d = _to_read(j, slim=True).model_dump(mode="json")
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
