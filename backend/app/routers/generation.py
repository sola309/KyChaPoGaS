"""
Generation router — creates Jobs for AI generation tasks.

Each endpoint validates the request, creates a Job record, and queues it.
Actual execution is handled by the background job runner (Phase 4b).
"""

import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from app.db.database import get_session
from app.models.job import Job, JobRead
from app.services.comfyui import comfyui

router = APIRouter(prefix="/generation", tags=["generation"])


def _create_job(session: Session, project_id: int, job_type: str, params: dict) -> JobRead:
    job = Job(project_id=project_id, job_type=job_type, params=json.dumps(params))
    session.add(job)
    session.commit()
    session.refresh(job)
    return JobRead.from_orm(job)


# ── Model catalogue (stub — will be populated from ComfyUI / local runners) ──

MODELS = {
    "image": [
        {"id": "waiNSFWIllustrious_v170", "name": "WAI Illustrious v17.0 (アニメ)",
         "backend": "comfyui", "recommended": True},
        {"id": "sdxl-base",  "name": "SDXL Base",     "backend": "comfyui"},
        {"id": "flux-dev",   "name": "FLUX.1 Dev (要DL)", "backend": "comfyui"},
    ],
    "audio": [
        {"id": "acestep-v15", "name": "ACE-Step 1.5（ボーカル対応）", "backend": "acestep",
         "vocals": True, "recommended": True},
    ],
    "video_i2v": [
        {"id": "wan2.2-flf2v",   "name": "Wan2.2 FLF2V (最初/最後フレーム)", "backend": "comfyui",
         "first_last_frame": True, "recommended": True},
        {"id": "wan2.2-fun-inp", "name": "Wan2.2 Fun-InP (最初/最後フレーム)", "backend": "comfyui",
         "first_last_frame": True},
        {"id": "svd-xt",         "name": "Stable Video Diffusion XT", "backend": "comfyui"},
    ],
}


@router.get("/models")
def list_models():
    return MODELS


@router.get("/comfyui/status")
async def comfyui_status():
    available = await comfyui.is_available()
    return {"available": available, "url": comfyui.base_url}


# ── Image generation ─────────────────────────────────────────────────────────

class ImageGenRequest(BaseModel):
    project_id: int
    prompt: str
    negative_prompt: str = ""
    model: str = "flux-dev"
    width: int = 1024
    height: int = 1024
    seed: int = -1   # -1 = random
    # LoRA適用: [["file.safetensors", 0.8], ...](lora-kitの成果物)
    loras: list | None = None


@router.post("/image", response_model=JobRead, status_code=201)
def generate_image(req: ImageGenRequest, session: Session = Depends(get_session)):
    return _create_job(session, req.project_id, "generate_image", req.model_dump())


# ── Audio / Music generation ─────────────────────────────────────────────────

class AudioGenRequest(BaseModel):
    project_id: int
    prompt: str                       # style / genre / mood (caption)
    lyrics: str = ""                  # lyrics for vocals; empty → instrumental
    duration_sec: float = 30.0
    vocal_language: str = "en"
    instrumental: Optional[bool] = None   # None → auto from lyrics presence
    model: str = "acestep-v15"
    seed: int = -1


@router.post("/audio", response_model=JobRead, status_code=201)
def generate_audio(req: AudioGenRequest, session: Session = Depends(get_session)):
    return _create_job(session, req.project_id, "generate_audio", req.model_dump())


# ── Video I2V generation ──────────────────────────────────────────────────────

class I2VKeyframe(BaseModel):
    time_sec: float
    asset_id: int


class VideoI2VRequest(BaseModel):
    project_id: int
    keyframes: list[I2VKeyframe]   # sorted by time_sec; frame[0]=start, frame[-1]=end
    duration_sec: float = 3.0
    fps: int = 16                  # Wan2.2 native fps is 16
    motion_strength: float = 0.6   # (SVD only)
    model: str = "wan2.2-flf2v"
    seed: int = -1
    # Wan2.2-specific
    prompt: str = ""
    negative_prompt: str = ""
    width: int = 640
    height: int = 640
    use_lightning: bool = True     # 4-step Lightning distillation (fast)

    def validate_keyframes(self):
        if len(self.keyframes) == 0:
            raise HTTPException(status_code=400, detail="At least one keyframe required")
        times = [kf.time_sec for kf in self.keyframes]
        if times != sorted(times):
            raise HTTPException(status_code=400, detail="Keyframes must be sorted by time_sec")


@router.post("/video/i2v", response_model=JobRead, status_code=201)
def generate_video_i2v(req: VideoI2VRequest, session: Session = Depends(get_session)):
    req.validate_keyframes()
    params = req.model_dump()
    params["keyframes"] = [kf.model_dump() for kf in req.keyframes]
    return _create_job(session, req.project_id, "generate_video_i2v", params)
