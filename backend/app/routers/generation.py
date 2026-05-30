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
        {"id": "flux-dev",   "name": "FLUX.1 Dev",    "backend": "comfyui"},
        {"id": "sdxl-base",  "name": "SDXL Base",     "backend": "comfyui"},
    ],
    "audio": [
        {"id": "musicgen-small",  "name": "MusicGen Small",  "backend": "local"},
        {"id": "musicgen-medium", "name": "MusicGen Medium", "backend": "local"},
        {"id": "musicgen-large",  "name": "MusicGen Large",  "backend": "local"},
    ],
    "video_i2v": [
        {"id": "hunyuan-i2v",    "name": "HunyuanVideo I2V",   "backend": "comfyui"},
        {"id": "cogvideox-i2v",  "name": "CogVideoX I2V",      "backend": "comfyui"},
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


@router.post("/image", response_model=JobRead, status_code=201)
def generate_image(req: ImageGenRequest, session: Session = Depends(get_session)):
    return _create_job(session, req.project_id, "generate_image", req.model_dump())


# ── Audio / Music generation ─────────────────────────────────────────────────

class AudioGenRequest(BaseModel):
    project_id: int
    prompt: str
    duration_sec: float = 30.0
    model: str = "musicgen-small"
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
    keyframes: list[I2VKeyframe]   # sorted by time_sec; 1–N frames
    duration_sec: float = 5.0
    fps: int = 24
    motion_strength: float = 0.6
    model: str = "hunyuan-i2v"
    seed: int = -1

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
