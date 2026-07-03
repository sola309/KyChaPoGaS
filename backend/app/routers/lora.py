"""
/api/lora — LoRA Lab(学習済みLoRAの一覧・生成テスト・ギャラリー).

テスト生成は専用プロジェクト「🧪 LoRA Lab」の generate_image ジョブとして実行し、
結果はジョブのparams(プロンプト/LoRA/強度/シード)付きでギャラリー表示する。
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session, select

from app.db.database import get_session
from app.models import Project
from app.models.job import Job, JobRead
from app.routers.generation import _create_job

router = APIRouter(prefix="/lora", tags=["lora"])

LAB_NAME = "🧪 LoRA Lab"
REPO = Path(__file__).resolve().parent.parent.parent.parent
LORAS_DIR = REPO / "tools" / "comfyui" / "models" / "loras"
DATASETS_DIR = REPO / "tools" / "lora-kit" / "datasets"
CKPT_DIR = REPO / "tools" / "comfyui" / "models" / "checkpoints"
DIFFUSION_DIR = REPO / "tools" / "comfyui" / "models" / "diffusion_models"


def lab_id(session: Session) -> int:
    p = session.exec(select(Project).where(Project.name == LAB_NAME)).first()
    if not p:
        p = Project(name=LAB_NAME, fps=30)
        session.add(p); session.commit(); session.refresh(p)
    return p.id


@router.get("/list")
def list_loras():
    loras = []
    if LORAS_DIR.exists():
        for f in sorted(LORAS_DIR.rglob("*.safetensors")):
            rel = str(f.relative_to(LORAS_DIR))
            if rel.startswith("Wan"):      # 動画モデル用LoRA(SDXLテスト対象外)
                continue
            loras.append({"name": rel,
                          "size_mb": round(f.stat().st_size / 2**20, 1),
                          "mtime": datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec="minutes")})
    datasets = []
    if DATASETS_DIR.exists():
        for d in sorted(DATASETS_DIR.iterdir()):
            if d.is_dir():
                raw = len(list((d / "raw").glob("*"))) if (d / "raw").exists() else 0
                prepared = any((d / "img").glob("*/*.txt")) if (d / "img").exists() else False
                trained = (LORAS_DIR / f"{d.name}.safetensors").exists()
                datasets.append({"name": d.name, "raw_images": raw,
                                 "prepared": prepared, "trained": trained})
    # ベースモデル一覧: checkpoints はファイル名(拡張子なし)、Krea 2 は種別キーで指定
    models = []
    if CKPT_DIR.exists():
        models += [f.stem for f in sorted(CKPT_DIR.glob("*.safetensors"))]
    if DIFFUSION_DIR.exists():
        if any(DIFFUSION_DIR.glob("krea2_turbo*")):
            models.append("krea2_turbo")
        if any(DIFFUSION_DIR.glob("krea2_raw*")):
            models.append("krea2_raw")
    return {"loras": loras, "datasets": datasets, "models": models}


class TestRequest(BaseModel):
    prompt: str
    negative_prompt: str = ("worst quality, low quality, bad anatomy, bad hands, watermark, "
                            "signature, text, jpeg artifacts, multiple girls, nsfw")
    model: str = "waiNSFWIllustrious"
    width: int = 832
    height: int = 1216
    seed: int = -1
    lora: str | None = None            # loras/ 内のファイル名
    strength: float = 0.8
    sweep: bool = False                # true: 強度 0.0/0.4/0.6/0.8/1.0 の5枚
    count: int = 1                     # sweep=falseのとき同条件シード違い枚数


@router.post("/test", response_model=list[JobRead], status_code=201)
def test(req: TestRequest, session: Session = Depends(get_session)):
    pid = lab_id(session)
    base_seed = req.seed if req.seed >= 0 else 309
    jobs = []
    if req.sweep and req.lora:
        for st in (0.0, 0.4, 0.6, 0.8, 1.0):
            jobs.append(_create_job(session, pid, "generate_image", {
                "project_id": pid,
                "prompt": req.prompt, "negative_prompt": req.negative_prompt,
                "model": req.model, "width": req.width, "height": req.height,
                "seed": base_seed,
                "loras": [[req.lora, st]] if st > 0 else [],
                "_lab": {"lora": req.lora, "strength": st, "sweep": True}}))
    else:
        for i in range(max(1, min(req.count, 6))):
            jobs.append(_create_job(session, pid, "generate_image", {
                "project_id": pid,
                "prompt": req.prompt, "negative_prompt": req.negative_prompt,
                "model": req.model, "width": req.width, "height": req.height,
                "seed": base_seed + i * 111,
                "loras": [[req.lora, req.strength]] if req.lora else [],
                "_lab": {"lora": req.lora, "strength": req.strength if req.lora else None}}))
    return jobs


@router.get("/gallery")
def gallery(session: Session = Depends(get_session), limit: int = 60):
    pid = lab_id(session)
    rows = session.exec(select(Job).where(Job.project_id == pid)
                        .order_by(Job.created_at.desc()).limit(limit)).all()
    out = []
    for j in rows:
        if j.job_type != "generate_image":
            continue
        params = json.loads(j.params or "{}")
        out.append({"job_id": j.id, "status": j.status,
                    "progress": j.progress, "error": j.error_msg,
                    "asset_ids": json.loads(j.result_asset_ids or "[]"),
                    "prompt": params.get("prompt", "")[:160],
                    "seed": params.get("seed"),
                    "lora": (params.get("_lab") or {}).get("lora"),
                    "strength": (params.get("_lab") or {}).get("strength")})
    return {"project_id": pid, "items": out}
