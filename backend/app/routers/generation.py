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
    # i2i: 初期画像アセット+ノイズ量(SDXL系のみ)
    init_asset_id: Optional[int] = None
    denoise: float = 0.6
    # ✏️AI編集(qwen-edit-2511等): 参照画像アセット(1枚目=編集対象)
    ref_asset_ids: Optional[list[int]] = None
    use_lightning: bool = True
    # 完成時にタイムラインへ自動配置: {track_id, start_frame, duration_frames}
    place: Optional[dict] = None


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
    # 完成時にタイムラインへ自動配置: {track_id, start_frame, duration_frames}
    place: Optional[dict] = None

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


# ── 3D model generation ───────────────────────────────────────────────────────

class OrbitSpec(BaseModel):
    preset: str = "orbit"        # orbit | dolly_in | dolly_out | sway | arc_l | arc_r
    seconds: float = 4.0
    fps: int = 30
    width: int = 1280
    height: int = 720
    style: str = "standard"      # standard | toon | wire
    turns: Optional[float] = None  # orbit時の周回数(既定1.0)


class Model3DRequest(BaseModel):
    project_id: int
    mode: str = "object"           # object | object_mv | relief
    image_asset_id: Optional[int] = None      # object / relief
    views: Optional[dict] = None   # object_mv: {"front": aid, "left": aid, ...}
    seed: int = -1
    steps: int = 30
    octree_resolution: int = 256
    # relief専用
    resolution_level: int = 9
    decimation: int = 2       # 頂点ストライド1-8
    discontinuity_threshold: float = 0.03
    fov_x_degrees: float = 60.0
    # GLB生成後に続けてカメラワークwebmも焼く場合
    orbit: Optional[OrbitSpec] = None


@router.post("/model3d", response_model=JobRead, status_code=201)
def generate_model3d(req: Model3DRequest, session: Session = Depends(get_session)):
    if req.mode in ("object", "relief") and not req.image_asset_id:
        raise HTTPException(status_code=400, detail="image_asset_id is required")
    if req.mode == "object_mv" and not (req.views or {}).get("front"):
        raise HTTPException(status_code=400, detail="views.front is required for object_mv")
    params = req.model_dump()
    if req.orbit:
        params["orbit"] = req.orbit.model_dump()
    return _create_job(session, req.project_id, "generate_3d", params)


class Orbit3DRequest(BaseModel):
    project_id: int
    asset_id: int                  # model3d アセット
    orbit: OrbitSpec = OrbitSpec()


@router.post("/model3d/orbit", response_model=JobRead, status_code=201)
def render_model3d_orbit(req: Orbit3DRequest, session: Session = Depends(get_session)):
    params = req.model_dump()
    params["orbit"] = req.orbit.model_dump()
    return _create_job(session, req.project_id, "render_orbit3d", params)


class Video3DCamRequest(BaseModel):
    project_id: int
    model_asset_id: Optional[int] = None   # 単体GLB(sceneと排他)
    scene: Optional[dict] = None           # {objects:[{model_asset_id,pos,rot,scale}], camera:[keys]}
    control_style: str = "depth"           # depth | edge
    ref_image_asset_id: int        # 画風・キャラを与える参照画像
    prompt: str = ""
    negative_prompt: str = ""
    camera: Optional[dict | list] = None   # {preset, turns} or [{at,az,el,dist,fov}]
    length: int = 81               # 4n+1 (81=約5秒@16fps)
    width: int = 832
    height: int = 480
    seed: int = -1
    use_lightning: bool = True
    steps: int = 4
    keep_control_video: bool = False


@router.post("/video/3dcam", response_model=JobRead, status_code=201)
def generate_video_3dcam(req: Video3DCamRequest, session: Session = Depends(get_session)):
    if not req.model_asset_id and not (req.scene or {}).get("objects"):
        raise HTTPException(status_code=400, detail="model_asset_id か scene.objects が必要です")
    return _create_job(session, req.project_id, "generate_video_3dcam", req.model_dump())


# ── ビート駆動3Dカメラ生成 ────────────────────────────────────────────────────

class BeatCameraRequest(BaseModel):
    project_id: int
    audio_asset_id: int            # audio_beats 解析済みの音源アセット
    start_sec: float
    end_sec: float
    style: str = "punch_in"        # punch_in | orbit_beat | sway_beat | riser
    intensity: float = 1.0


@router.post("/camera/beat")
def make_beat_camera(req: BeatCameraRequest, session: Session = Depends(get_session)):
    """beatgridから3Dカメラキーフレームを生成(3dcam/scene3dのcameraにそのまま渡せる)。"""
    from sqlmodel import select
    from app.models.analysis import AnalysisResult
    from app.services.camera_gen import beat_camera

    res = session.exec(
        select(AnalysisResult)
        .where(AnalysisResult.asset_id == req.audio_asset_id,
               AnalysisResult.analysis_type == "audio_beats")
        .order_by(AnalysisResult.id.desc())
    ).first()
    if not res:
        raise HTTPException(status_code=404,
                            detail="音源のビート解析がありません(analyze_audioを先に)")
    data = json.loads(res.result_json)
    beats = data.get("beats") or data.get("beat_times") or []
    downbeats = data.get("downbeats") or beats[::4]
    bpm = float(data.get("bpm") or 120)
    camera = beat_camera(bpm, beats, downbeats, req.start_sec, req.end_sec,
                         req.style, req.intensity)
    return {"camera": camera, "bpm": bpm,
            "n_beats": len([b for b in beats if req.start_sec <= b <= req.end_sec])}
