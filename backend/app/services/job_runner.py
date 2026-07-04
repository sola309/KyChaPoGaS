"""
Background job runner.

Polls the Job table every 2 seconds for 'pending' jobs and executes them one at a time.
Started as an asyncio task in FastAPI lifespan (main.py).

Supported job types:
  render_final        — FFmpeg timeline render → MP4
  generate_image      — ComfyUI image generation → Asset
  generate_audio      — Local MusicGen (stub until Phase 4d)
  generate_video_i2v  — ComfyUI I2V generation → Asset
  analyze_audio       — BPM/beat detection via librosa
  analyze_video       — Scene detection + motion intensity
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
PROXIES_DIR   = Path(__file__).parent.parent.parent / "data" / "proxies"


# レーン並列: 重いGPUジョブ(動画/音楽/最終レンダー/分解)と軽いジョブ(画像/解析/プロキシ)を
# 1本ずつ同時に走らせる。128GBユニファイドメモリの余力を活かしつつ、VRAMゲートで安全側に倒す。
LANE_HEAVY = {"generate_video_i2v", "generate_video_s2v", "generate_audio",
              "render_final", "precompose", "decompose_character", "mad_shot_takes"}


def _lane_of(job_type: str) -> str:
    return "heavy" if job_type in LANE_HEAVY else "light"


async def run_forever() -> None:
    log.info("Job runner started (lanes: heavy / light)")
    running: dict[str, asyncio.Task] = {}
    while True:
        try:
            for lane in ("heavy", "light"):
                t = running.get(lane)
                if t and not t.done():
                    continue
                job = _claim_next(lane)
                if job:
                    running[lane] = asyncio.create_task(_run_job(job))
        except Exception as e:
            log.error(f"Job runner error: {e}")
        await asyncio.sleep(2)


def _claim_next(lane: str) -> Job | None:
    """このレーンの先頭pendingジョブをrunningに遷移して返す(無ければNone)。"""
    from app.services.gpu_monitor import estimate_vram_mb, is_vram_sufficient

    with Session(engine) as session:
        pendings = session.exec(
            select(Job).where(Job.status == "pending").order_by(Job.created_at)
        ).all()
        job = next((j for j in pendings if _lane_of(j.job_type) == lane), None)
        if not job:
            return None

        params = json.loads(job.params)
        estimated_mb = estimate_vram_mb(job.job_type, params)
        if estimated_mb > 512 and not is_vram_sufficient(estimated_mb):
            log.info(f"Job id={job.id} deferred — VRAM insufficient (need ~{estimated_mb} MB)")
            return None

        log.info(f"Starting job id={job.id} type={job.job_type} lane={lane}")
        job.status = "running"
        job.started_at = datetime.utcnow()
        job.vram_estimated_mb = estimated_mb
        session.add(job)
        session.commit()
        session.refresh(job)
        return job


async def _run_job(job: Job) -> None:
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
        case "generate_video_s2v":
            await _generate_video_s2v(job, params)
        case "generate_audio":
            await _generate_audio(job, params)
        case "analyze_audio":
            await _analyze_audio(job, params)
        case "analyze_video":
            await _analyze_video(job, params)
        case "create_proxy":
            await _create_proxy(job, params)
        case "precompose":
            await _precompose(job, params)
        case "render_motion_graphics":
            await _render_motion_graphics(job, params)
        case "decompose_character":
            await _decompose_character(job, params)
        case "mad_reproxy_shot":
            await _mad_reproxy_shot(job, params)
        case "cutout":
            await _cutout(job, params)
        case "interpolate":
            await _interpolate(job, params)
        case "vlm_review":
            await _vlm_review(job, params)
        case "mad_shot_takes":
            await _mad_shot_takes(job, params)
        case "puppet_clip":
            await _puppet_clip(job, params)
        case _:
            raise ValueError(f"Unknown job type: {job.job_type}")


# ── mad_reproxy_shot ──────────────────────────────────────────────────────────

async def _mad_reproxy_shot(job: Job, params: dict) -> None:
    """Re-render one mad-kit shot's proxy and swap it into its asset in place
    (the Shot Editor's fast feedback path — no full re-render needed)."""
    import importlib.util
    from app.services.motion_graphics import render_html_to_video
    from app.services.thumbnail import generate_video_thumbnail

    kit_dir = Path(__file__).parent.parent.parent.parent / "tools" / "mad-kit"
    spec = importlib.util.spec_from_file_location("madkit_build", kit_dir / "build.py")
    kit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(kit)

    mad_path = Path(__file__).parent.parent.parent / "data" / "mad" / f"{job.project_id}.json"
    m = json.loads(mad_path.read_text())
    shot_id = params["shot_id"]
    entry = m["shot_map"][shot_id]
    project_dir, shotlist_path = Path(m["project_dir"]), Path(m["shotlist_path"])

    html, _shotlist, _grid = kit.build_html(project_dir, shotlist_path, offset=entry["t0"])
    dur = entry["t1"] - entry["t0"]
    tmp = project_dir / "shot_proxies" / f"shot_{shot_id}.tmp.mp4"
    await render_html_to_video(html, tmp, duration_sec=dur, fps=30, width=640, height=360,
                               progress_cb=lambda p: _update_progress(job.id, p * 0.95))

    with Session(engine) as session:
        asset = session.get(Asset, entry["asset_id"])
        if not asset:
            raise ValueError(f"asset {entry['asset_id']} not found")
        dest = Path(asset.file_path)
        shutil.copy2(tmp, project_dir / "shot_proxies" / f"shot_{shot_id}.mp4")
        shutil.move(str(tmp), str(dest))
        generate_video_thumbnail(dest, asset.id)
        _update_result_assets(job.id, [asset.id])
    _update_progress(job.id, 1.0)


async def _mad_shot_takes(job: Job, params: dict) -> None:
    """テイク比較: 1ショットをバリエーション違いで4連プロキシ生成。
    vary="camera"(parallax系) or "enter"(登場モーション)。result_jsonに
    各テイクのパッチとプロキシURLを返し、UI/AI指示側が選んで適用する。"""
    import importlib.util
    import tempfile
    from app.services.motion_graphics import render_html_to_video

    kit_dir = Path(__file__).parent.parent.parent.parent / "tools" / "mad-kit"
    spec = importlib.util.spec_from_file_location("madkit_build", kit_dir / "build.py")
    kit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(kit)

    mad_path = Path(__file__).parent.parent.parent / "data" / "mad" / f"{job.project_id}.json"
    m = json.loads(mad_path.read_text())
    shot_id = params["shot_id"]
    entry = m["shot_map"][shot_id]
    project_dir, shotlist_path = Path(m["project_dir"]), Path(m["shotlist_path"])

    vary = params.get("vary", "camera")
    VARIANTS = {
        "camera": [{"params": {"camera": c}} for c in ("dolly_in", "pass_through", "orbit", "crane_up")],
        "enter": [{"params": {"subjects": None}, "_enter": e} for e in ("rise_pop", "drop_bounce", "spin_in", "flip_in")],
        "fx": [{"fx": [{"kind": k, "on": "db"}]} for k in ("rgb_shift", "glitch", "shake", "manga_flash")],
    }[vary if vary in ("camera", "enter", "fx") else "camera"]

    sl = json.loads(shotlist_path.read_text())
    idx = next(i for i, s in enumerate(sl["shots"]) if str(s.get("id")) == str(shot_id))
    takes_dir = project_dir / "shot_proxies" / "takes"
    takes_dir.mkdir(parents=True, exist_ok=True)
    dur = entry["t1"] - entry["t0"]
    results = []
    for k, patch in enumerate(VARIANTS):
        sl2 = json.loads(json.dumps(sl))
        shot = sl2["shots"][idx]
        if "params" in patch and patch["params"]:
            shot.setdefault("params", {}).update(patch["params"])
        if "_enter" in patch:
            for sub in (shot.get("params", {}).get("subjects") or []):
                sub["enter"] = patch["_enter"]
        if "fx" in patch:
            shot["fx"] = patch["fx"]
        with tempfile.NamedTemporaryFile("w", suffix=".json", dir=str(shotlist_path.parent),
                                         delete=False) as tf:
            json.dump(sl2, tf, ensure_ascii=False)
            tmp_sl = Path(tf.name)
        try:
            html, _s, _g = kit.build_html(project_dir, tmp_sl, offset=entry["t0"])
            out = takes_dir / f"shot_{shot_id}_take{k}.mp4"
            await render_html_to_video(html, out, duration_sec=dur, fps=30, width=640, height=360,
                                       progress_cb=lambda p, k=k: _update_progress(job.id, (k + p) / len(VARIANTS)))
            results.append({"take": k, "patch": {kk: vv for kk, vv in patch.items() if not kk.startswith("_")},
                            "enter": patch.get("_enter"), "file": str(out)})
        finally:
            tmp_sl.unlink(missing_ok=True)
    with Session(engine) as session:
        j = session.get(Job, job.id)
        j.result_json = json.dumps({"vary": vary, "takes": results}, ensure_ascii=False)
        session.add(j); session.commit()
    _update_progress(job.id, 1.0)


# ── render_final ──────────────────────────────────────────────────────────────

async def _render_final(job: Job, params: dict) -> None:
    from app.services.ffmpeg_render import render_timeline

    # project_id lives on the Job; params may omit it (the render dialog sends {}).
    project_id = params.get("project_id") or job.project_id
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
        encoder=params.get("encoder"),
    )


# ── precompose: flatten the timeline into a single reusable asset ─────────────

async def _precompose(job: Job, params: dict) -> None:
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
        tracks_d, clips_d, assets_d = list(tracks), list(clips), list(assets)

    def progress_cb(p): _update_progress(job.id, p * 0.95)

    output = await render_timeline(
        job_id=job.id, project_id=project_id,
        tracks=tracks_d, clips=clips_d, assets=assets_d,
        fps=fps, width=width, height=height,
        progress_cb=progress_cb,
        encoder=params.get("encoder"),
    )
    asset_id = _register_asset(project_id, output, "generated", params)
    _update_result_assets(job.id, [asset_id])
    _update_progress(job.id, 1.0)
    log.info(f"Precompose done → asset {asset_id}")


# ── generate_image ────────────────────────────────────────────────────────────

async def _generate_image(job: Job, params: dict) -> None:
    from app.services.comfyui import comfyui
    from app.services.workflow_builder import (
        build_sdxl_txt2img, build_flux_txt2img, build_krea2_txt2img, detect_model_type
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

    if model_type == "krea2":
        # Krea 2 — UNET(diffusion_models) + Qwen3-VL TE + Qwen Image VAE の分離ロード
        unet_models = await comfyui.list_unet_models()
        # "krea2_turbo" / "krea2_raw" の指定を尊重。無印 "krea2" は turbo を優先
        want = model_id.lower()
        unet = next((m for m in unet_models if want in m.lower()), "") or \
               next((m for m in unet_models if "krea2_turbo" in m.lower()), "") or \
               next((m for m in unet_models if "krea2" in m.lower()), "")
        if not unet:
            raise RuntimeError("Krea 2 のモデルが見つかりません(install_models.py 未実行?)")
        clip_models = await comfyui.list_clip_models()
        te = next((m for m in clip_models if "qwen3vl" in m.lower()), "")
        vae_list = await comfyui._object_info_options("VAELoader", "vae_name")
        vae = next((v for v in vae_list if "qwen_image_vae" in v.lower()), "")
        if not te or not vae:
            raise RuntimeError("Krea 2 用の TE/VAE が見つかりません(qwen3vl / qwen_image_vae)")
        loras = [(l[0], float(l[1])) for l in (params.get("loras") or [])]
        workflow = build_krea2_txt2img(unet, te, vae, prompt, neg_prompt,
                                       width, height, seed,
                                       steps=params.get("steps"), cfg=params.get("cfg"),
                                       loras=loras or None)
    elif model_type == "flux":
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
        loras = [(l[0], float(l[1])) for l in (params.get("loras") or [])]
        workflow = build_sdxl_txt2img(ckpt, prompt, neg_prompt, width, height, seed,
                                      loras=loras or None)

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
            "ComfyUI が起動していません。scripts/start.sh で起動してください。"
        )

    model_id = params.get("model", "wan2.2-flf2v")
    if model_id.startswith("wan2.2"):
        await _generate_video_wan22(job, params)
        return

    project_id = params["project_id"]
    keyframes  = params.get("keyframes", [])
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


# ── generate_video_i2v: Wan2.2 (first/last frame) ─────────────────────────────

WAN22_FPS = 16   # Wan2.2 native frame rate


async def _generate_video_s2v(job: Job, params: dict) -> None:
    """Wan2.2 S2V: 参照画像+音声 → リップシンク/演技付き動画(歌わせる)。
    params: {image_asset_id, audio_asset_id, prompt, length, width, height, seed}
    出力動画に音声もmuxして登録する。"""
    from app.services.comfyui import comfyui
    from app.services.workflow_builder import build_wan22_s2v
    from app.services.ffmpeg_render import FFMPEG

    project_id = params["project_id"]
    with Session(engine) as session:
        img = session.get(Asset, params["image_asset_id"])
        aud = session.get(Asset, params["audio_asset_id"])
        if not img or not aud:
            raise ValueError("image_asset_id / audio_asset_id が見つかりません")
        img_path, aud_path = Path(img.file_path), Path(aud.file_path)

    if not await comfyui.is_available():
        raise RuntimeError("ComfyUI が起動していません")
    up_img = (await comfyui.upload_image(img_path)).get("name", img_path.name)
    # 音声もComfyUIのinputへ(upload/imageエンドポイントはファイル種別を問わない)
    up_aud = (await comfyui.upload_image(aud_path)).get("name", aud_path.name)
    _update_progress(job.id, 0.05)

    wf = build_wan22_s2v(
        up_img, up_aud, params.get("prompt", ""), params.get("negative_prompt", ""),
        int(params.get("width", 640)), int(params.get("height", 640)),
        int(params.get("length", 77)), int(params.get("seed", -1)),
        steps=int(params.get("steps", 20)))
    prompt_id = await comfyui.submit(wf)
    outputs = await comfyui.wait_for_outputs(
        prompt_id, lambda p: _update_progress(job.id, 0.05 + p * 0.85))

    dest_dir = GENERATED_DIR / str(project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    frames = []
    for i, out in enumerate(outputs):
        fn = out["filename"] if isinstance(out, dict) else str(out)
        p = await comfyui.download_output(fn, out.get("subfolder", "") if isinstance(out, dict) else "",
                                          out.get("type", "output") if isinstance(out, dict) else "output",
                                          dest_dir)
        fp = dest_dir / f"s2v_{job.id}_{i:05d}.png"
        p.rename(fp)
        frames.append(fp)
    if not frames:
        raise RuntimeError("S2V がフレームを出力しませんでした")
    silent = await _frames_to_video(frames, dest_dir, WAN22_FPS, job.id)
    # 音声mux(生成尺で切る)
    final = dest_dir / f"s2v_{job.id}.mp4"
    proc = await asyncio.create_subprocess_exec(
        str(FFMPEG), "-y", "-i", str(silent), "-i", str(aud_path),
        "-c:v", "copy", "-c:a", "aac", "-shortest", str(final),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    await proc.communicate()
    out_path = final if final.exists() else silent
    asset_id = _register_asset(project_id, out_path, "generated", params)
    _update_result_assets(job.id, [asset_id])
    for fp in frames:
        fp.unlink(missing_ok=True)
    log.info(f"S2V done → {out_path.name}")


async def _generate_video_wan22(job: Job, params: dict) -> None:
    """
    Wan2.2 image-to-video with first / (optional) middle / last frame control.

    1 keyframe  → start-image-only generation.
    2 keyframes → first-last-frame (FLF2V).
    N keyframes → N-1 FLF2V segments (start→mid→…→end) concatenated into one clip,
                  giving start / middle / end control.
    """
    from app.services.comfyui import comfyui
    from app.services.workflow_builder import build_wan22_video

    project_id = params["project_id"]
    keyframes  = params.get("keyframes", [])
    mode       = params.get("model", "wan2.2-flf2v")
    seed       = int(params.get("seed", -1))
    width      = int(params.get("width", 640))
    height     = int(params.get("height", 640))
    prompt     = params.get("prompt", "")
    neg_prompt = params.get("negative_prompt", "")
    use_light  = bool(params.get("use_lightning", True))
    duration   = float(params.get("duration_sec", 3.0))
    total_len  = max(5, int(round(duration * WAN22_FPS)))

    if not keyframes:
        raise ValueError("Wan2.2 I2V には最低1つのキーフレーム（開始フレーム）が必要です")

    def _asset_path(asset_id: int) -> Path:
        with Session(engine) as session:
            asset = session.get(Asset, asset_id)
            if not asset:
                raise ValueError(f"アセット {asset_id} が見つかりません")
            p = Path(asset.file_path)
        if not p.exists():
            raise ValueError(f"アセットファイルが見つかりません: {p}")
        return p

    # Upload every keyframe image to ComfyUI once
    _update_progress(job.id, 0.05)
    names: list[str] = []
    for kf in keyframes:
        p = _asset_path(kf["asset_id"])
        names.append((await comfyui.upload_image(p)).get("name", p.name))

    dest_dir = GENERATED_DIR / str(project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    n_seg   = max(1, len(names) - 1)
    seg_len = max(5, round(total_len / n_seg))
    log.info(f"Wan2.2 {mode}: {len(names)} keyframe(s) → {n_seg} segment(s), seg_len={seg_len}")

    async def _run_segment(seg_idx: int, start_name: str, end_name: str | None) -> list[Path]:
        wf = build_wan22_video(
            mode=mode, start_image_name=start_name, end_image_name=end_name,
            prompt=prompt, negative_prompt=neg_prompt,
            width=width, height=height, length=seg_len, seed=seed,
            use_lightning=use_light,
        )
        prompt_id = await comfyui.submit(wf)

        def cb(p):
            base = 0.10 + (seg_idx / n_seg) * 0.80
            _update_progress(job.id, base + (p / n_seg) * 0.80)

        outputs = await comfyui.wait_for_outputs(prompt_id, cb)
        frames: list[Path] = []
        for i, out in enumerate(outputs):
            fn = out.get("filename", "")
            if not fn:
                continue
            p = await comfyui.download_output(fn, out.get("subfolder", ""), out.get("type", "output"), dest_dir)
            # Rename for stable global ordering across segments (avoids filename collisions)
            newp = dest_dir / f"wanseg_{job.id}_{seg_idx:02d}_{i:04d}{p.suffix}"
            p.replace(newp)
            frames.append(newp)
        frames.sort()
        return frames

    _update_progress(job.id, 0.10)
    all_frames: list[Path] = []
    if len(names) == 1:
        all_frames = await _run_segment(0, names[0], None)
    else:
        for i in range(len(names) - 1):
            seg = await _run_segment(i, names[i], names[i + 1])
            if i > 0 and seg:
                seg = seg[1:]   # drop the duplicated shared keyframe at the junction
            all_frames.extend(seg)

    if not all_frames:
        raise RuntimeError("Wan2.2 がフレームを出力しませんでした")

    video_path = await _frames_to_video(all_frames, dest_dir, WAN22_FPS, job.id)
    asset_id = _register_asset(project_id, video_path, "generated", params)
    _update_result_assets(job.id, [asset_id])
    for fp in all_frames:
        fp.unlink(missing_ok=True)
    log.info(f"Wan2.2 video done: {len(all_frames)} frames ({n_seg} seg) → {video_path.name}")


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

async def _generate_audio(job: Job, params: dict) -> None:
    """Generate music (with optional vocals) via the ACE-Step service."""
    from app.services.acestep import acestep

    if not await acestep.is_available():
        raise RuntimeError(
            "音楽生成サービス (ACE-Step) が起動していません。"
            "./scripts/start.sh で起動してください。"
        )

    project_id = params["project_id"]
    caption    = params.get("prompt", "")
    lyrics     = params.get("lyrics", "")
    duration   = float(params.get("duration_sec", 30.0))
    vocal_lang = params.get("vocal_language", "en")
    instrumental = params.get("instrumental", None)
    seed       = int(params.get("seed", -1))

    _update_progress(job.id, 0.1)
    audio_bytes = await acestep.generate(
        caption=caption, lyrics=lyrics, duration_sec=duration,
        vocal_language=vocal_lang, instrumental=instrumental, seed=seed,
        bpm=params.get("bpm"), key=params.get("key"),
    )
    _update_progress(job.id, 0.9)

    dest_dir = GENERATED_DIR / str(project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    out_path = dest_dir / f"music_{job.id}.wav"
    out_path.write_bytes(audio_bytes)

    asset_id = _register_asset(project_id, out_path, "generated", params)
    _update_result_assets(job.id, [asset_id])
    log.info(f"Music generation done: {out_path.name} ({len(audio_bytes)} bytes)")


# ── analyze_audio ─────────────────────────────────────────────────────────────

async def _analyze_audio(job: Job, params: dict) -> None:
    from app.services.audio_analyzer import analyze_beats
    from app.models.analysis import AnalysisResult

    asset_id = params["asset_id"]
    with Session(engine) as session:
        from app.models import Asset
        asset = session.get(Asset, asset_id)
        if not asset:
            raise ValueError(f"Asset {asset_id} not found")
        file_path = Path(asset.file_path)

    _update_progress(job.id, 0.1)
    result = await asyncio.get_event_loop().run_in_executor(
        None, analyze_beats, file_path
    )
    _update_progress(job.id, 0.9)

    with Session(engine) as session:
        # Upsert: remove old beat result for this asset
        old = session.exec(
            select(AnalysisResult)  # type: ignore[arg-type]
            .where(AnalysisResult.asset_id == asset_id)
            .where(AnalysisResult.analysis_type == "audio_beats")
        ).first()
        if old:
            session.delete(old)
        ar = AnalysisResult(
            asset_id=asset_id,
            analysis_type="audio_beats",
            result_json=json.dumps(result),
        )
        session.add(ar)
        session.commit()

    log.info(f"Audio analysis done: asset={asset_id} bpm={result['bpm']}")


# ── analyze_video ─────────────────────────────────────────────────────────────

async def _analyze_video(job: Job, params: dict) -> None:
    from app.services.video_analyzer import analyze_scenes, analyze_motion, analyze_motion_curve
    from app.models.analysis import AnalysisResult

    asset_id = params["asset_id"]
    with Session(engine) as session:
        from app.models import Asset
        asset = session.get(Asset, asset_id)
        if not asset:
            raise ValueError(f"Asset {asset_id} not found")
        file_path = Path(asset.file_path)

    _update_progress(job.id, 0.05)

    scene_result = await asyncio.get_event_loop().run_in_executor(
        None, analyze_scenes, file_path
    )
    _update_progress(job.id, 0.45)

    motion_result = await asyncio.get_event_loop().run_in_executor(
        None, analyze_motion, file_path
    )
    _update_progress(job.id, 0.7)

    curve_result = await asyncio.get_event_loop().run_in_executor(
        None, analyze_motion_curve, file_path
    )
    _update_progress(job.id, 0.95)

    with Session(engine) as session:
        for atype, result in (
            ("scene_changes", scene_result),
            ("motion", motion_result),
            ("motion_curve", curve_result),
        ):
            old = session.exec(
                select(AnalysisResult)  # type: ignore[arg-type]
                .where(AnalysisResult.asset_id == asset_id)
                .where(AnalysisResult.analysis_type == atype)
            ).first()
            if old:
                session.delete(old)
            session.add(AnalysisResult(
                asset_id=asset_id,
                analysis_type=atype,
                result_json=json.dumps(result),
            ))
        session.commit()

    log.info(
        f"Video analysis done: asset={asset_id} "
        f"scenes={scene_result['scene_count']}"
    )


# ── render_motion_graphics: HTML/CSS/JS → video clip ──────────────────────────

async def _render_motion_graphics(job: Job, params: dict) -> None:
    from app.services.motion_graphics import render_html_to_video

    project_id = params["project_id"]
    # Server-side templates (single source of truth, shared by UI + AI).
    template = params.get("template")
    if template == "lyric_motion":
        from app.services.lyric_motion import build_lyric_motion_html
        html = build_lyric_motion_html(params.get("style", "pop"))
    else:
        html = params.get("html", "")
    if not html.strip():
        raise ValueError("html が空です")

    transparent = bool(params.get("transparent", False))
    dest_dir = GENERATED_DIR / str(project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    out = dest_dir / (f"mg_{job.id}.mov" if transparent else f"mg_{job.id}.mp4")

    # Data-driven MG: expose the project's real beat grid (+ params.lyrics) to
    # the page as window.kycha, so templates can sync to the actual music.
    duration_sec = float(params.get("duration_sec", 3.0))
    offset_sec = float(params.get("offset_sec", 0.0))   # MGをタイムラインのどこに置くか
    lyrics = params.get("lyrics", "")
    if not lyrics:
        # Auto-fetch the song lyrics from the project's most recent music job.
        try:
            with Session(engine) as session:
                audio_jobs = session.exec(
                    select(Job)
                    .where(Job.project_id == project_id)
                    .where(Job.job_type == "generate_audio")
                    .order_by(Job.id.desc())
                ).all()
            for aj in audio_jobs:
                p = json.loads(aj.params) if isinstance(aj.params, str) else (aj.params or {})
                if p.get("lyrics"):
                    lyrics = p["lyrics"]
                    break
        except Exception as e:
            log.warning(f"lyrics autofetch failed: {e}")
    inject: dict = {
        "duration": duration_sec, "offset": offset_sec,
        "fps": float(params.get("fps", 30)),
        "lyrics": lyrics,
        "bpm": None, "beats": [], "downbeats": [],
    }
    try:
        from app.services import command_api
        with Session(engine) as session:
            grid = command_api.get_beat_grid(project_id, session)
        if "error" not in grid:
            from app.models import Project as _P
            with Session(engine) as session:
                proj = session.get(_P, project_id)
            pfps = proj.fps if proj else 30.0
            # MGローカル秒 (offsetを引いてクリップ内時刻に変換)
            beats = [round(b["frame"] / pfps - offset_sec, 4) for b in grid["beats"]]
            downs = [round(f / pfps - offset_sec, 4) for f in grid["downbeat_frames"]]
            inject.update({
                "bpm": grid.get("bpm"),
                "beats": [t for t in beats if -0.05 <= t <= duration_sec + 0.05],
                "downbeats": [t for t in downs if -0.05 <= t <= duration_sec + 0.05],
            })
    except Exception as e:
        log.warning(f"MG beat injection skipped: {e}")

    await render_html_to_video(
        html, out,
        duration_sec=duration_sec,
        fps=float(params.get("fps", 30)),
        width=int(params.get("width", 1280)),
        height=int(params.get("height", 720)),
        transparent=transparent,
        inject_data=inject,
        progress_cb=lambda p: _update_progress(job.id, 0.05 + 0.9 * p),
    )

    asset_id = _register_asset(project_id, out, "generated", params)
    _update_result_assets(job.id, [asset_id])
    _update_progress(job.id, 1.0)
    log.info(f"Motion graphics done → asset {asset_id}")


# ── decompose_character: image → See-Through layers → rigged puppet ───────────

REPO_ROOT      = Path(__file__).parent.parent.parent.parent
SEE_THROUGH    = REPO_ROOT / "tools" / "see-through"
PUPPETS_DIR    = Path(__file__).parent.parent.parent / "data" / "puppets"


async def _decompose_character(job: Job, params: dict) -> None:
    """
    キャラ画像 → See-Through で23パーツ分解(+遮蔽補完) → パペット登録。

    See-Through is a separate, heavy venv (its own torch/models), so we shell out
    to it rather than importing into the backend process. Output lands in
    data/puppets/<puppet_id>/ (manifest.json + per-layer PNGs), served by the
    puppet router and rigged by the companion frontend.
    """
    import re

    st_py = SEE_THROUGH / ".venv" / "bin" / "python"
    if not st_py.exists():
        raise RuntimeError("See-Through 未導入（tools/see-through/.venv が無い）")

    project_id = params["project_id"]
    puppet_id = params.get("puppet_id") or f"char_{job.id}"
    puppet_id = re.sub(r"[^a-zA-Z0-9_-]", "_", puppet_id)
    name = params.get("name") or puppet_id

    # source image (project asset, or explicit path)
    if params.get("asset_id"):
        with Session(engine) as session:
            asset = session.get(Asset, params["asset_id"])
            if not asset:
                raise ValueError(f"Asset {params['asset_id']} not found")
            src = Path(asset.file_path)
    else:
        src = Path(params["image_path"])
    if not src.exists():
        raise ValueError(f"画像が見つかりません: {src}")

    # stage the input inside See-Through and run the pipeline
    in_dir = SEE_THROUGH / "input"
    in_dir.mkdir(exist_ok=True)
    stem = f"{puppet_id}"
    staged = in_dir / f"{stem}.png"
    shutil.copy(src, staged)
    _update_progress(job.id, 0.05)

    async def run(cmd: list[str], cwd: Path):
        proc = await asyncio.create_subprocess_exec(
            *[str(c) for c in cmd], cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await proc.communicate()
        if proc.returncode != 0:
            tail = out.decode(errors="replace")[-1500:]
            raise RuntimeError(f"{cmd[1]} failed:\n{tail}")
        return out

    # 1) layer decomposition → PSD (~9 min on GB10)
    log.info(f"decompose_character: layerdiff on {staged.name}")
    await run([st_py, "inference/scripts/inference_psd.py",
               "--srcp", str(staged), "--save_to_psd"], cwd=SEE_THROUGH)
    _update_progress(job.id, 0.85)

    out_dir = SEE_THROUGH / "workspace" / "layerdiff_output" / stem
    psd = SEE_THROUGH / "workspace" / "layerdiff_output" / f"{stem}.psd"
    if not psd.exists():
        raise RuntimeError("See-Through 出力PSDが見つかりません")

    # 2) PSD → puppet manifest (build_puppet uses See-Through's psd-tools)
    log.info("decompose_character: building puppet manifest")
    await run([st_py, str(REPO_ROOT / "scripts" / "build_puppet.py"),
               str(out_dir), str(psd), puppet_id, name], cwd=SEE_THROUGH)
    _update_progress(job.id, 0.95)

    manifest = PUPPETS_DIR / puppet_id / "manifest.json"
    if not manifest.exists():
        raise RuntimeError("パペット・マニフェスト生成に失敗")

    # 3) Rig Compiler v2 — canonical z-order, semantic depth, skin/eye/mouth rig
    # metadata (so any decomposed character gets high-fidelity rigging).
    log.info("decompose_character: compiling high-fidelity rig (v2)")
    await run([st_py, str(REPO_ROOT / "scripts" / "rig_compiler.py"),
               str(PUPPETS_DIR / puppet_id)], cwd=REPO_ROOT)
    _update_progress(job.id, 0.97)

    # record the puppet id on the job result (no asset row — puppets are their own store)
    with Session(engine) as session:
        j = session.get(Job, job.id)
        if j:
            j.result_asset_ids = json.dumps([])
            j.params = json.dumps({**params, "puppet_id": puppet_id})
            session.add(j)
            session.commit()
    _update_progress(job.id, 1.0)
    log.info(f"decompose_character done → puppet '{puppet_id}'")


# ── create_proxy: low-res preview proxy for a video asset ─────────────────────

async def _create_proxy(job: Job, params: dict) -> None:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

    asset_id = params["asset_id"]
    with Session(engine) as session:
        asset = session.get(Asset, asset_id)
        if not asset:
            raise ValueError(f"Asset {asset_id} not found")
        src = Path(asset.file_path)
        project_id = asset.project_id
    if not src.exists():
        raise ValueError(f"アセットファイルが見つかりません: {src}")

    dest_dir = PROXIES_DIR / str(project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    out = dest_dir / f"{asset_id}.mp4"

    _update_progress(job.id, 0.1)
    cmd = [
        FFMPEG, "-y", "-i", str(src),
        # downscale to max 640px wide (even dims), fast-decoding H.264, web-streamable
        "-vf", "scale='min(640,iw)':-2",
        "-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "96k",
        str(out),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0 or not out.exists():
        raise RuntimeError(f"プロキシ生成に失敗: {stderr.decode()[-400:]}")

    with Session(engine) as session:
        a = session.get(Asset, asset_id)
        if a:
            a.proxy_path = str(out)
            session.add(a)
            session.commit()
    _update_progress(job.id, 1.0)
    log.info(f"Proxy created: asset {asset_id} → {out.name} ({out.stat().st_size/1e6:.1f}MB)")


# ── Asset registration ────────────────────────────────────────────────────────

async def _puppet_clip(job: Job, params: dict) -> None:
    """コンパニオンを透過webm素材化(MAD/動画用)。idle/talk/nodのループ系モーション。"""
    import tempfile
    from app.services.ffmpeg_render import FFMPEG

    pid = params["puppet_id"]
    motion = params.get("motion", "idle")
    dur = float(params.get("duration", 4))
    fps = int(params.get("fps", 30))
    project_id = params["project_id"]

    with tempfile.TemporaryDirectory(prefix="puppet_clip_") as td:
        proc = await asyncio.create_subprocess_exec(
            "node", str(REPO_ROOT / "frontend" / "puppet_clip.mjs"),
            pid, motion, str(dur), str(fps), td,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            cwd=str(REPO_ROOT / "frontend"))
        out, _ = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"puppet_clip.mjs failed:\n{out.decode(errors='replace')[-800:]}")
        _update_progress(job.id, 0.8)
        dest_dir = GENERATED_DIR / str(project_id)
        dest_dir.mkdir(parents=True, exist_ok=True)
        outp = dest_dir / f"puppet_{pid}_{motion}_{job.id}.webm"
        proc2 = await asyncio.create_subprocess_exec(
            str(FFMPEG), "-y", "-framerate", str(fps), "-i", f"{td}/f%05d.png",
            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "24",
            "-auto-alt-ref", "0", str(outp),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        o2, _ = await proc2.communicate()
        if proc2.returncode != 0 or not outp.exists():
            raise RuntimeError(f"webm encode failed:\n{o2.decode(errors='replace')[-500:]}")
    asset_id = _register_asset(project_id, outp, "puppet_clip",
                               {"puppet_id": pid, "motion": motion, "duration": dur, "fps": fps})
    _update_result_assets(job.id, [asset_id])


async def _vlm_review(job: Job, params: dict) -> None:
    """レンダー動画をローカルVLMで意味QA→コメントキューに自動起票(lightレーン)。"""
    from app.services.ffmpeg_render import FFMPEG
    from app.services import vlm_review as V

    with Session(engine) as session:
        asset = session.get(Asset, params["asset_id"])
        if not asset:
            raise ValueError(f"Asset {params['asset_id']} not found")
        src, project_id = Path(asset.file_path), asset.project_id
    _update_progress(job.id, 0.05)
    findings = await asyncio.to_thread(
        V.review_video, src, str(FFMPEG), int(params.get("frames", 12)))
    n = V.file_comments(project_id, findings, src.stem)
    _update_progress(job.id, 1.0)
    with Session(engine) as session:
        j = session.get(Job, job.id)
        j.result_json = json.dumps({"findings": findings, "comments_filed": n},
                                   ensure_ascii=False)
        session.add(j); session.commit()


async def _interpolate(job: Job, params: dict) -> None:
    """
    フレーム補間: 低fpsの生成動画(Wan等)を滑らかな高fpsへ。
    まずは ffmpeg minterpolate(動き補償)。RIFE系への昇格パスは stem-kit venv(torch)
    + Practical-RIFE を想定(tools/README参照)。
    """
    from app.services.ffmpeg_render import FFMPEG

    with Session(engine) as session:
        asset = session.get(Asset, params["asset_id"])
        if not asset:
            raise ValueError(f"Asset {params['asset_id']} not found")
        src = Path(asset.file_path)
        project_id = asset.project_id

    fps = int(params.get("fps", 60))
    dest_dir = GENERATED_DIR / str(project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    is_webm = src.suffix.lower() == ".webm"
    out = dest_dir / f"{src.stem}_{fps}fps_{job.id}{'.webm' if is_webm else '.mp4'}"

    vcodec = (["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "24", "-pix_fmt", "yuva420p"]
              if is_webm else ["-c:v", "libx264", "-crf", "16", "-preset", "medium"])
    cmd = [str(FFMPEG), "-y", "-i", str(src),
           "-vf", f"minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1",
           *vcodec, "-an", str(out)]
    _update_progress(job.id, 0.1)
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.STDOUT)
    o, _ = await proc.communicate()
    if proc.returncode != 0 or not out.exists():
        raise RuntimeError(f"minterpolate failed:\n{o.decode(errors='replace')[-800:]}")
    _update_progress(job.id, 0.95)
    asset_id = _register_asset(project_id, out, "interpolate",
                               {"src_asset_id": params["asset_id"], "fps": fps,
                                "method": "minterpolate"})
    _update_result_assets(job.id, [asset_id])


async def _cutout(job: Job, params: dict) -> None:
    """
    高品質切り抜き: アセット画像 → 透過PNG(マッティング+デフリンジ+影抑制)。
    tools/cutout-kit を同一venvで直接呼ぶ(CPU、数秒)。
    """
    import sys
    kit = REPO_ROOT / "tools" / "cutout-kit"
    if str(kit) not in sys.path:
        sys.path.insert(0, str(kit))
    from cutout import cut_image, crop_alpha  # noqa: E402
    from PIL import Image

    project_id = params["project_id"]
    with Session(engine) as session:
        asset = session.get(Asset, params["asset_id"])
        if not asset:
            raise ValueError(f"Asset {params['asset_id']} not found")
        src = Path(asset.file_path)
    _update_progress(job.id, 0.1)

    model = params.get("model", "isnet-anime")
    im = await asyncio.to_thread(
        cut_image, Image.open(src), model,
        params.get("bg", "white"), float(params.get("feather", 1.0)))
    if params.get("crop", True):
        im = crop_alpha(im)
    _update_progress(job.id, 0.9)

    dest_dir = GENERATED_DIR / str(project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    out = dest_dir / f"{src.stem}_cut_{job.id}.png"
    im.save(out)
    asset_id = _register_asset(project_id, out, "cutout",
                               {"src_asset_id": params["asset_id"], "model": model,
                                "bg": params.get("bg", "white")})
    _update_result_assets(job.id, [asset_id])


def _register_asset(project_id: int, file_path: Path, source: str, gen_params: dict) -> int:
    """Register a generated file as an Asset in the DB. Returns asset_id."""
    from app.services.media_info import probe
    from app.services.thumbnail import generate_video_thumbnail, generate_image_thumbnail

    info = probe(file_path)
    slim = {k: v for k, v in (gen_params or {}).items() if k != "keyframes"}
    asset = Asset(
        project_id=project_id,
        name=file_path.name,
        asset_type="generated",
        file_path=str(file_path),
        duration_sec=info.duration_sec,
        width=info.width,
        height=info.height,
        file_size_bytes=info.file_size_bytes,
        gen_params_json=json.dumps(slim, ensure_ascii=False),
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
