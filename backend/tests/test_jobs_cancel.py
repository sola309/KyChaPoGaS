"""ジョブの取り消し(POST /api/jobs/{id}/cancel)が ComfyUI を止める宛先と条件のテスト。

2026-10-15: cancel_job が http://localhost:8188/interrupt を決め打ちしていたため、COMFYUI_URL を
閉じたポートにしたバックエンドのコピーで取り消しても、本物の ComfyUI の実行中ジョブ(7512)が止まった。
- 宛先は ComfyUI クライアントと同じ設定(app.config.COMFYUI_URL → comfyui.base_url)であること。
- ComfyUI を使わない CPU のジョブ(🌧 render_rain_layer)の取り消しでは ComfyUI を止めないこと。
- 待ち(pending)の取り消しでは止めないこと(これまでどおり)。
本物の ComfyUI・DB には触れない(httpx.post を差し替え、DB は conftest の一時 SQLite)。
"""
import pytest


@pytest.fixture()
def client_and_calls(monkeypatch):
    import httpx
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import jobs
    calls: list[str] = []

    def fake_post(url, *a, **k):          # 届いたら困るので、送らずに宛先だけ記録する
        calls.append(str(url))
        return None
    monkeypatch.setattr(httpx, "post", fake_post)
    app = FastAPI()
    app.include_router(jobs.router, prefix="/api")
    return TestClient(app), calls


def _job(job_type: str, status: str) -> int:
    from sqlmodel import Session
    from app.db import database
    from app.models import Job
    with Session(database.engine) as s:
        j = Job(project_id=1, job_type=job_type, params="{}", status=status)
        s.add(j); s.commit(); s.refresh(j)
        return j.id


def test_cancel_running_gpu_job_interrupts_configured_comfyui(client_and_calls):
    from app import config
    from app.services.comfyui import comfyui
    c, calls = client_and_calls
    jid = _job("generate_video_i2v", "running")
    r = c.post(f"/api/jobs/{jid}/cancel")
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    # 宛先 = クライアントの設定(conftest が COMFYUI_URL を閉じたポート 127.0.0.1:9 にしている)
    assert calls == [f"{comfyui.base_url}/interrupt"]
    assert calls[0] == config.COMFYUI_URL.rstrip("/") + "/interrupt"
    assert "8188" not in calls[0]


def test_cancel_follows_client_base_url(client_and_calls, monkeypatch):
    """決め打ちではなく、クライアントの base_url をそのまま使う(本番は既定の localhost:8188 のまま変わらない)。"""
    from app.services.comfyui import comfyui
    c, calls = client_and_calls
    monkeypatch.setattr(comfyui, "base_url", "http://127.0.0.1:9/elsewhere")
    jid = _job("generate_image", "running")
    assert c.post(f"/api/jobs/{jid}/cancel").status_code == 200
    assert calls == ["http://127.0.0.1:9/elsewhere/interrupt"]


def test_cancel_rain_job_never_touches_comfyui(client_and_calls):
    """🌧 雨フィルターの層(CPU だけ)を取り消しても、ComfyUI(別レーンの GPU ジョブ)は止めない。"""
    c, calls = client_and_calls
    jid = _job("render_rain_layer", "running")
    r = c.post(f"/api/jobs/{jid}/cancel")
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    assert calls == []


def test_cancel_pending_or_finished_does_not_interrupt(client_and_calls):
    c, calls = client_and_calls
    for st in ("pending", "completed", "failed"):
        jid = _job("generate_video_i2v", st)
        r = c.post(f"/api/jobs/{jid}/cancel")
        assert r.status_code == 200
        assert r.json()["status"] == ("cancelled" if st == "pending" else st)
    assert calls == []
    assert c.post("/api/jobs/999999/cancel").status_code == 404
