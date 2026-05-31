"""
Background job runner.

Polls the Job table every 2 seconds for 'pending' jobs and executes them one at a time.
Started as an asyncio task in FastAPI lifespan (main.py).

Supported job types:
  render_final        — FFmpeg timeline render → MP4
  generate_image      — ComfyUI image generation → Asset
  generate_audio      — Local MusicGen (stub until Phase 4d)
  generate_video_i2v  — ComfyUI I2V generation → Asset
"""

import asyncio
import json
import logging
import mimetypes
import shutil
from datetime import datetime
from pathlib import Path

from sqlmodel import Session, select

from app.db.database import engine
from app.models.job import Job
from app.models import Track, Clip, Asset, AssetCreate, Project

log = logging.getLogger("job_runner")

GENERATED_DIR = Path(__file__).parent.parent.parent / "data" / "generated"


async def run_forever() -> None:
    log.info("Job runner started")
    while True:
        try:
            await _poll_once()
        except Exception as e:
            log.error(f"Job runner error: {e}")
        await asyncio.sleep(2)


async def _poll_once() -> None:
    from app.services.gpu_monitor import estimate_vram_mb, is_vram_sufficient

    with Session(engine) as session:
        job = session.exec(
            select(Job)
            .where(Job.status == "pending")
            .order_by(Job.created_at)
        ).first()
        if not job:
            return

        params = json.loads(job.params)
        estimated_mb = estimate_vram_mb(job.job_type, params)

        # If this is a GPU-heavy job and VRAM is insufficient, skip for now
        if estimated_mb > 512 and not is_vram_sufficient(estimated_mb):
            log.info(
                f"Job id={job.id} deferred — VRAM insufficient "
                f"(need ~{estimated_mb} MB)"
            )
            return

        log.info(f"Starting job id={job.id} type={job.job_type}")
        job.status = "running"
        job.started_at = datetime.utcnow()
        job.vram_estimated_mb = estimated_mb
        session.add(job)
        session.commit()
        session.refresh(job)

    # Start background VRAM sampler
    vram_sampler = asyncio.create_task(_sample_vram(job.id))

    try:
        await _dispatch(job)
        vram_sampler.cancel()
        with Session(engine) as session:
            j = session.get(Job, job.id)
            if j and j.status == "running":   # don't overwrite if already cancelled
                j.status = "completed"
                j.progress = 1.0
                j.completed_at = datetime.utcnow()
                session.add(j)
                session.commit()
        log.info(f"Job id={job.id} completed")
    except Exception as e:
        vram_sampler.cancel()
        log.error(f"Job id={job.id} failed: {e}")
        with Session(engine) as session:
            j = session.get(Job, job.id)
            if j:
                j.status = "failed"
                j.error_msg = str(e)[:2000]
                j.completed_at = datetime.utcnow()
                session.add(j)
                session.commit()


async def _sample_vram(job_id: int) -> None:
    """Poll GPU VRAM every 3 seconds and record the peak used value."""
    from app.services.gpu_monitor import get_gpu_status
    peak_mb = 0
    try:
        while True:
            status = get_gpu_status()
            if status.available and status.gpus:
                peak_mb = max(peak_mb, status.primary_used_mb)
            await asyncio.sleep(3)
    except asyncio.CancelledError:
        if peak_mb > 0:
            with Session(engine) as session:
                j = session.get(Job, job_id)
                if j:
                    j.vram_peak_mb = peak_mb
                    session.add(j)
                    session.commit()
            log.info(f"Job id={job_id} peak VRAM: {peak_mb} MB")


def _update_progress(job_id: int, pct: float) -> None:
    with Session(engine) as session:
        j = session.get(Job, job_id)
        if j and j.status == "running":
            j.progress = round(min(1.0, max(0.0, pct)), 3)
            session.add(j)
            session.commit()


def _update_result_assets(job_id: int, asset_ids: list[int]) -> None:
    with Session(engine) as session:
        j = session.get(Job, job_id)
        if j:
            j.result_asset_ids = json.dumps(asset_ids)
            session.add(j)
            session.commit()


# ── Dispatch ──────────────────────────────────────────────────────────────────

async def _dispatch(job: Job) -> None:
    params = json.loads(job.params)
    match job.job_type:
        case "render_final":
            await _render_final(job, params)
        case "generate_image":
            await _generate_image(job, params)
        case "generate_video_i2v":
            await _generate_video_i2v(job, params)
        case "generate_audio":
            await _generate_audio_stub(job, params)
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
        tracks = session.exec(select(Track).where(Track.project_id == project_id)).all()
        clips  = session.exec(select(Clip).where(Clip.track_id.in_([t.id for t in tracks]))).all()
        assets = session.exec(select(Asset).where(Asset.project_id == project_id)).all()
        fps    = float(params.get("fps",    project.fps))
        width  = int(params.get("width",  project.width))
        height = int(params.get("height", project.height))
        tracks_d = list(tracks)
        clips_d  = list(clips)
        assets_d = list(assets)

    def progress_cb(p): _update_progress(job.id, p)

    await render_timeline(
        job_id=job.id, project_id=project_id,
        tracks=tracks_d, clips=clips_d, assets=assets_d,
        fps=fps, width=width, height=height,
        progress_cb=progress_cb,
    )


# ── generate_image ────────────────────────────────────────────────────────────

async def _generate_image(job: Job, params: dict) -> None:
    from app.services.comfyui import comfyui
    from app.services.workflow_builder import (
        build_sdxl_txt2img, build_flux_txt2img, detect_model_type
    )

    if not await comfyui.is_available():
        raise RuntimeError(
            "ComfyUI が起動していません。scripts/start.ps1 または start.sh で起動してください。"
        )

    project_id = params["project_id"]
    prompt     = params.get("prompt", "")
    neg_prompt = params.get("negative_prompt", "")
    model_id   = params.get("model", "")
    width      = int(params.get("width",  1024))
    height     = int(params.get("height", 1024))
    seed       = int(params.get("seed", -1))

    model_type = detect_model_type(model_id)

    if model_type == "flux":
        # FLUX needs separate UNET / CLIP / VAE
        checkpoints = await comfyui.list_checkpoints()
        unet_models = await comfyui.list_unet_models()
        clip_models = await comfyui.list_clip_models()
        unet = next((m for m in unet_models if model_id.lower() in m.lower()), unet_models[0] if unet_models else "")
        clip1 = clip_models[0] if clip_models else ""
        clip2 = clip_models[1] if len(clip_models) > 1 else clip1
        vae_list = await comfyui._object_info_options("VAELoader", "vae_name")
        vae = vae_list[0] if vae_list else ""
        workflow = build_flux_txt2img(unet, clip1, clip2, vae, prompt, width, height, seed)
    else:
        # SDXL / SD1.5 — use checkpoint directly
        checkpoints = await comfyui.list_checkpoints()
        ckpt = next((c for c in checkpoints if model_id.lower() in c.lower()), checkpoints[0] if checkpoints else model_id)
        workflow = build_sdxl_txt2img(ckpt, prompt, neg_prompt, width, height, seed)

    _update_progress(job.id, 0.05)

    prompt_id = await comfyui.submit(workflow)
    log.info(f"ComfyUI image job submitted: prompt_id={prompt_id}")

    def progress_cb(p): _update_progress(job.id, 0.05 + p * 0.90)

    outputs = await comfyui.wait_for_outputs(prompt_id, progress_cb)

    # Download outputs and register as Assets
    dest_dir = GENERATED_DIR / str(project_id)
    asset_ids = []
    for out_info in outputs:
        filename  = out_info.get("filename", "")
        subfolder = out_info.get("subfolder", "")
        ftype     = out_info.get("type", "output")
        if not filename:
            continue
        path = await comfyui.download_output(filename, subfolder, ftype, dest_dir)
        asset_id = _register_asset(project_id, path, "generated", params)
        asset_ids.append(asset_id)

    _update_result_assets(job.id, asset_ids)
    log.info(f"Image generation done: {len(asset_ids)} asset(s) registered")


# ── generate_video_i2v ────────────────────────────────────────────────────────

async def _generate_video_i2v(job: Job, params: dict) -> None:
    from app.services.comfyui import comfyui
    from app.services.workflow_builder import build_svd_i2v

    if not await comfyui.is_available():
        raise RuntimeError(
            "ComfyUI が起動していません。scripts/start.ps1 または start.sh で起動してください。"
        )

    project_id = params["project_id"]
    keyframes  = params.get("keyframes", [])
    model_id   = params.get("model", "svd-xt")
    fps        = int(params.get("fps", 6))
    strength   = float(params.get("motion_strength", 0.6))
    seed       = int(params.get("seed", -1))

    if not keyframes:
        raise ValueError("I2V には最低1つのキーフレームが必要です")

    # Use the first keyframe image
    first_kf = keyframes[0]
    kf_asset_id = first_kf.get("asset_id")
    if not kf_asset_id:
        raise ValueError("キーフレームにアセットIDがありません")

    with Session(engine) as session:
        kf_asset = session.get(Asset, kf_asset_id)
        if not kf_asset:
            raise ValueError(f"キーフレームアセット {kf_asset_id} が見つかりません")
        kf_path = Path(kf_asset.file_path)

    if not kf_path.exists():
        raise ValueError(f"キーフレームファイルが見つかりません: {kf_path}")

    _update_progress(job.id, 0.05)

    # Upload the reference image to ComfyUI
    upload_info = await comfyui.upload_image(kf_path)
    uploaded_name = upload_info.get("name", kf_path.name)
    log.info(f"Uploaded keyframe to ComfyUI: {uploaded_name}")

    # Find SVD model
    checkpoints = await comfyui.list_checkpoints()
    ckpt = next((c for c in checkpoints if any(k in c.lower() for k in ("svd", "stable-video"))),
                checkpoints[0] if checkpoints else model_id)

    workflow = build_svd_i2v(
        model_filename=ckpt,
        uploaded_image_name=uploaded_name,
        fps=fps,
        seed=seed,
        motion_bucket_id=max(1, min(255, int(strength * 255))),
    )

    _update_progress(job.id, 0.10)

    prompt_id = await comfyui.submit(workflow)
    log.info(f"ComfyUI I2V job submitted: prompt_id={prompt_id}")

    def progress_cb(p): _update_progress(job.id, 0.10 + p * 0.85)

    outputs = await comfyui.wait_for_outputs(prompt_id, progress_cb)

    # SVD outputs individual frames — combine with FFmpeg into MP4
    dest_dir = GENERATED_DIR / str(project_id)
    frame_paths: list[Path] = []
    for out_info in outputs:
        filename  = out_info.get("filename", "")
        subfolder = out_info.get("subfolder", "")
        ftype     = out_info.get("type", "output")
        if filename:
            p = await comfyui.download_output(filename, subfolder, ftype, dest_dir)
            frame_paths.append(p)

    if frame_paths:
        # If all images → convert to MP4 with FFmpeg
        video_path = await _frames_to_video(frame_paths, dest_dir, fps, job.id)
        asset_id = _register_asset(project_id, video_path, "generated", params)
        _update_result_assets(job.id, [asset_id])
        # Cleanup individual frame files
        for fp in frame_paths:
            fp.unlink(missing_ok=True)


async def _frames_to_video(frames: list[Path], dest_dir: Path, fps: int, job_id: int) -> Path:
    """Combine image frames into an MP4 using FFmpeg."""
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

    # Write concat list
    list_file = dest_dir / f"frames_{job_id}.txt"
    with open(list_file, "w") as f:
        for p in sorted(frames):
            f.write(f"file '{p.as_posix()}'\n")
            f.write(f"duration {1/fps:.4f}\n")

    output = dest_dir / f"video_{job_id}.mp4"
    cmd = [
        FFMPEG, "-y",
        "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-vf", f"fps={fps}",
        "-c:v", "libx264", "-crf", "23", "-preset", "fast", "-pix_fmt", "yuv420p",
        str(output),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    _, stderr = await proc.communicate()
    list_file.unlink(missing_ok=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Frame-to-video failed: {stderr.decode()[-500:]}")
    return output


# ── generate_audio (stub) ────────────────────────────────────────────────────

async def _generate_audio_stub(job: Job, params: dict) -> None:
    raise RuntimeError(
        "音楽生成はPhase 4d で実装予定です。"
        "MusicGen モデルのインストールが必要です: scripts/install_models.py"
    )


# ── Asset registration ────────────────────────────────────────────────────────

def _register_asset(project_id: int, file_path: Path, source: str, gen_params: dict) -> int:
    """Register a generated file as an Asset in the DB. Returns asset_id."""
    from app.services.media_info import probe
    from app.services.thumbnail import generate_video_thumbnail, generate_image_thumbnail

    info = probe(file_path)
    asset = Asset(
        project_id=project_id,
        name=file_path.name,
        asset_type="generated",
        file_path=str(file_path),
        duration_sec=info.duration_sec,
        width=info.width,
        height=info.height,
        file_size_bytes=info.file_size_bytes,
    )

    with Session(engine) as session:
        session.add(asset)
        session.commit()
        session.refresh(asset)
        asset_id = asset.id

    # Generate thumbnail in background (sync but fast enough)
    try:
        if info.asset_type == "video":
            generate_video_thumbnail(file_path, asset_id)
        elif info.asset_type in ("image", "generated"):
            generate_image_thumbnail(file_path, asset_id)
    except Exception as e:
        log.warning(f"Thumbnail generation failed for asset {asset_id}: {e}")

    return asset_id
