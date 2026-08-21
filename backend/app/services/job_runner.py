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
import random
import shutil
from datetime import datetime
from pathlib import Path

from sqlmodel import Session, select

from app.db.database import engine
from app.models.job import Job
from app.models import Track, Clip, Asset, AssetCreate, Project

log = logging.getLogger("job_runner")


def _resolve_seed(params: dict) -> int:
    """seed=-1(ランダム)をここで実値に確定し、params(→gen_params_json)に書き戻す。
    再生成UIやテイク履歴に「実際に使われたseed」が表示されるようにするため。"""
    s = int(params.get("seed", -1))
    if s == -1:
        s = random.randint(0, 2**31 - 1)
        params["seed"] = s
    return s

GENERATED_DIR = Path(__file__).parent.parent.parent / "data" / "generated"
PROXIES_DIR   = Path(__file__).parent.parent.parent / "data" / "proxies"


# レーン並列: 重いGPUジョブ(動画/音楽/最終レンダー/分解)と軽いジョブ(画像/解析/プロキシ)を
# 1本ずつ同時に走らせる。128GBユニファイドメモリの余力を活かしつつ、VRAMゲートで安全側に倒す。
LANE_HEAVY = {"generate_video_i2v", "generate_video_s2v", "generate_audio",
              "render_final", "precompose", "decompose_character", "mad_shot_takes",
              "generate_3d", "generate_video_3dcam"}


def _lane_of(job_type: str) -> str:
    return "heavy" if job_type in LANE_HEAVY else "light"


def _recover_orphans() -> None:
    """再起動時: 前プロセスの'running'ジョブは戻ってこないので failed に倒す。
    (これをしないとUI上で永遠に実行中に見えるゾンビになる)"""
    with Session(engine) as session:
        orphans = session.exec(select(Job).where(Job.status == "running")).all()
        for j in orphans:
            j.status = "failed"
            j.error_msg = "バックエンド再起動により中断されました(再投入してください)"
            j.completed_at = datetime.utcnow()
            session.add(j)
        if orphans:
            session.commit()
            log.warning(f"Recovered {len(orphans)} orphaned running job(s) → failed: "
                        f"{[j.id for j in orphans]}")
    # 持ち主を失ったComfyUI側のプロンプトも一掃する。
    # 残しておくと結果を誰も回収しない計算でGPUが埋まり、再投入したジョブが
    # その後ろで待たされて「5%のまま進まない」ように見える。
    from app.services.comfyui import comfyui
    dropped = comfyui.drop_all_queued_sync()
    if dropped:
        log.warning(f"ComfyUIの孤児プロンプトを破棄: {dropped}件")


def _sweep_zombies(live_ids: set[int]) -> None:
    """実行中の実体が居ないのに status='running' のまま残った行を失敗に倒す。

    タスクが CancelledError 等の BaseException で終わると _run_job の except を
    すり抜けて終端状態が書かれず、UIに永久に消えない「実行中」が積み上がる。
    走っているタスクの job.id 以外の running は実体が無いので回収する。
    """
    with Session(engine) as session:
        stale = session.exec(select(Job).where(Job.status == "running")).all()
        hit = [j for j in stale if j.id not in live_ids]
        for j in hit:
            j.status = "failed"
            j.error_msg = "実行タスクが失われました(再投入してください)"
            j.completed_at = datetime.utcnow()
            session.add(j)
        if hit:
            session.commit()
            log.warning(f"ゾンビ実行中ジョブを回収: {[j.id for j in hit]}")


async def run_forever() -> None:
    log.info("Job runner started (lanes: heavy / light)")
    _recover_orphans()
    running: dict[str, asyncio.Task] = {}
    lane_job: dict[str, int] = {}      # レーンが今実際に走らせている job.id
    sweep = 0
    while True:
        try:
            for lane in ("heavy", "light"):
                t = running.get(lane)
                if t and not t.done():
                    continue
                lane_job.pop(lane, None)
                job = _claim_next(lane)
                if job:
                    running[lane] = asyncio.create_task(_run_job(job))
                    lane_job[lane] = job.id
            # 30秒ごとに実体を失った'running'を掃除する
            sweep += 1
            if sweep % 15 == 0:
                _sweep_zombies(set(lane_job.values()))
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


def _update_phase(job_id: int, phase: str) -> None:
    """実行フェーズ表示(「モデル読み込み中…」等)。頻度が高いので同値スキップ。"""
    with Session(engine) as session:
        j = session.get(Job, job_id)
        if j and j.status == "running" and getattr(j, "phase", "") != phase:
            j.phase = phase
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
        case "separate_vocals":
            await _separate_vocals(job, params)
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
        case "generate_3d":
            await _generate_3d(job, params)
        case "render_orbit3d":
            await _render_orbit3d(job, params)
        case "generate_video_3dcam":
            await _generate_video_3dcam(job, params)
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
        # クリップが実際に参照しているアセットを引く。プロジェクトで絞ると、
        # 他プロジェクトの素材を使ったクリップ(複製したタイムライン等)が
        # 全て「素材なし」になって黒く落ちる。
        ids = {c.asset_id for c in clips if c.asset_id}
        assets = session.exec(select(Asset).where(Asset.id.in_(ids))).all() if ids else []
        # ⬆ 高解像度版(scripts/upscale_assets.py が作る up_<元ID>_*)も渡す。
        # クリップからは参照されていないので、ID一致だけでは取れない。
        # レンダラが書き出し解像度に応じて元素材と差し替える。
        if ids:
            ups = session.exec(select(Asset).where(Asset.project_id == project_id)
                               .where(Asset.name.startswith("up_"))).all()
            keep = {a.id: a for a in assets}
            for a in ups:
                keep.setdefault(a.id, a)
            assets = list(keep.values())
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
        grade=params.get("grade"),   # None=設定既定(film) / "off"で無効化
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
        ids = {c.asset_id for c in clips if c.asset_id}
        assets = session.exec(select(Asset).where(Asset.id.in_(ids))).all() if ids else []
        # ⬆ 高解像度版(scripts/upscale_assets.py が作る up_<元ID>_*)も渡す。
        # クリップからは参照されていないので、ID一致だけでは取れない。
        # レンダラが書き出し解像度に応じて元素材と差し替える。
        if ids:
            ups = session.exec(select(Asset).where(Asset.project_id == project_id)
                               .where(Asset.name.startswith("up_"))).all()
            keep = {a.id: a for a in assets}
            for a in ups:
                keep.setdefault(a.id, a)
            assets = list(keep.values())
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
        grade="off",   # 素材化される出力: 最終レンダでも掛かるため二重掛けを防ぐ
    )
    asset_id = _register_asset(project_id, output, "generated", params)
    _update_result_assets(job.id, [asset_id])
    _update_progress(job.id, 1.0)
    log.info(f"Precompose done → asset {asset_id}")


# ── generate_image ────────────────────────────────────────────────────────────

def _fit_speed(session: Session, asset_id: int, duration_frames: int, project_fps: float) -> float:
    """生成物をカット尺へ収めるための再生速度。

    H3は最小124フレーム(=24fpsで5.17秒)しか作れないため、それより短いカットでは
    「短い参照の動きを長い尺へ引き伸ばした」映像が返る(実測: 2.23秒指定で歩行が43%速度)。
    生成物全体をカット尺に詰め直すと、動きの速さが参照どおりに戻る。
    """
    asset = session.get(Asset, asset_id)
    if not asset or not asset.duration_sec or duration_frames <= 0 or project_fps <= 0:
        return 1.0
    slot_sec = duration_frames / project_fps
    if slot_sec <= 0:
        return 1.0
    speed = asset.duration_sec / slot_sec
    # 上限3倍。極端に短いカット(0.3秒等)では要求倍率が10倍を超え、全編を詰め込むと
    # 一瞬の明滅にしかならない。その場合は3倍までに留め、頭から必要な分だけを使う
    # (=残りは切り捨て)。速いカットは元々「一瞬の出来事」なのでこれで用が足りる。
    speed = min(speed, 3.0)
    # 等倍付近は触らない(誤差で微妙な速度がつくのを避ける)
    return round(speed, 3) if speed > 1.02 else 1.0


def _clamp_to_cut(session, project_id, start: int, dur: int) -> int:
    """配置尺をカット境界で切る。

    カット境界は Image(reference) トラックのピン列(2本1組)から導出する。
    戻り値は「startから始めて完全にカバーできる最後のカット終端」までの尺。
    ピンが無い/導出できない場合は元の尺のまま返す(切りすぎ事故を避ける)。
    """
    try:
        if not project_id:
            return dur
        img = session.exec(
            select(Track).where(Track.project_id == int(project_id),
                                Track.track_type == "reference",
                                Track.name == "Image")
        ).first()
        if not img:
            return dur
        pins = session.exec(
            select(Clip).where(Clip.track_id == img.id, Clip.asset_id.is_not(None))
            .order_by(Clip.start_frame)
        ).all()
        ends = [pins[i + 1].start_frame for i in range(0, len(pins) - 1, 2)]
        best = None
        for e in ends:
            if e >= start and (e - start + 1) <= dur:
                best = e
        if best is None:
            return dur
        want = best - start + 1
        if want < dur:
            log.info(f"place: カット境界でクリップ {dur}f → {want}f (末尾{dur - want}fトリム)")
        return want
    except Exception as e:
        log.warning(f"place: カット境界クリップに失敗、元の尺のまま配置: {e}")
        return dur


def _place_result(params: dict, asset_id: int, fallback_duration: int = 30) -> None:
    """
    params["place"] = {track_id, start_frame, duration_frames?} が指定されていれば
    完成アセットをそのタイムライン位置へクリップ配置する(タイムライン第一原則)。

    place["fit_speed"]=True のとき、生成物の全長がカット尺に収まる速度を自動設定する。
    """
    place = params.get("place")
    if not place:
        return
    # auto=False: 配置せずテイクとして蓄積(place情報はgen_paramsに残り、
    # テイクブラウザがカット紐付けに使う)。夜間バリエーション生成→朝選択のワークフロー用。
    if place.get("auto") is False:
        log.info("place.auto=False → テイクとして蓄積(自動配置スキップ)")
        return
    with Session(engine) as session:
        # replace_clip_id: 既存クリップのアセットを差し替える(再生成ワークフロー)。
        # 位置・尺・トランスフォームはそのまま残る。
        if place.get("replace_clip_id"):
            clip = session.get(Clip, int(place["replace_clip_id"]))
            if clip:
                if clip.locked:
                    log.info(f"clip {clip.id} は🔒ロック中 → 差し替えず、テイクとして蓄積")
                    return
                clip.asset_id = asset_id
                session.add(clip)
                session.commit()
                log.info(f"replaced clip {clip.id} asset → {asset_id}")
                return
        if not place.get("track_id"):
            return
        # 同一位置に🔒ロック済みクリップがある場合は重ね置きしない(テイク蓄積扱い)
        existing = session.exec(
            select(Clip).where(Clip.track_id == int(place["track_id"]),
                               Clip.start_frame == int(place.get("start_frame", 0)))
        ).all()
        if any(c.locked for c in existing):
            log.info("配置先に🔒ロック済みクリップ → 自動配置スキップ(テイク蓄積)")
            return
        dur = int(place.get("duration_frames", fallback_duration))
        start = int(place.get("start_frame", 0))
        # ── 空枠への充填 ──────────────────────────────────────────────
        # scenes-sync が全カットに枠(asset_id=None)を敷く運用。配置先に空枠が
        # あるなら asset を差し替えるだけにする。位置と尺は枠(=ピン束縛)が正で、
        # 生成側の尺で上書きしない — これで「はみ出し」も「短いまま」も起きない。
        slot = next((c for c in session.exec(
            select(Clip).where(Clip.track_id == int(place["track_id"]),
                               Clip.start_frame == start)).all()
            if c.asset_id is None and not c.locked), None)
        if slot is not None:
            slot.asset_id = asset_id
            session.add(slot)
            session.commit()
            log.info(f"placed asset {asset_id} into empty slot clip {slot.id} @ {start}")
            return
        # ── カット境界へのクリッピング ────────────────────────────────
        # H3の尺スナップ(17n+5)でカット尺より長く生成されるため、そのまま置くと
        # 末尾が次のカットへはみ出す(実測: 全長で14クリップがはみ出していた)。
        # 「完全にカバーできる最後のカット終端」で切る — 複数カットまとめ生成
        # (C4-C5の222f等)は正当なので、カット1個分に一律で切ってはいけない。
        dur = _clamp_to_cut(session, params.get("project_id"), start, dur)
        clip = Clip(
            track_id=int(place["track_id"]),
            asset_id=asset_id,
            start_frame=start,
            duration_frames=dur,
        )
        # 再生速度の自動調整は廃止(2026-08-12 ユーザー指示)。
        # 生成物は常に等倍で配置し、カット尺で頭から切る。速度変更は人間の判断で行う。
        session.add(clip)
        session.commit()
    log.info(f"placed asset {asset_id} on track {place['track_id']} @ {place.get('start_frame', 0)}")


async def _generate_image(job: Job, params: dict) -> None:
    from app.services.comfyui import comfyui
    from app.services.workflow_builder import (
        build_sdxl_txt2img, build_sdxl_img2img, build_flux_txt2img,
        build_krea2_txt2img, detect_model_type
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
    seed       = _resolve_seed(params)

    # ✏️ AI編集モデル(Qwen-2511 / HiDream-O1 / FLUX.2 klein KV)
    from app.services.workflow_builder import IMAGE_EDIT_MODELS
    if model_id in IMAGE_EDIT_MODELS:
        from app.services.workflow_builder import (
            build_qwen_image_edit, build_hidream_o1_edit, build_flux2_klein_edit
        )
        ref_ids = [int(a) for a in (params.get("ref_asset_ids") or [])]
        if not ref_ids:
            raise ValueError("AI編集には参照画像(ref_asset_ids)が最低1枚必要です")
        names: list[str] = []
        first_dims = (width, height)
        with Session(engine) as session:
            for i, aid in enumerate(ref_ids):
                a = session.get(Asset, aid)
                if not a or not Path(a.file_path).exists():
                    raise ValueError(f"参照アセット {aid} が見つかりません")
                if i == 0 and a.width and a.height:
                    first_dims = (a.width, a.height)
                names.append((await comfyui.upload_image(Path(a.file_path))).get("name", Path(a.file_path).name))
        if model_id == "minimax-h3-edit":
            from app.services.workflow_builder import build_minimax_h3_edit
            workflow = build_minimax_h3_edit(
                names, prompt,
                width=int(params.get("width") or 832),
                height=int(params.get("height") or 1216),
                seed=seed)
        elif model_id in ("qwen-edit-2511", "qwen-edit-2511-fp8"):
            workflow = build_qwen_image_edit(
                names, prompt, seed=seed,
                use_lightning=bool(params.get("use_lightning", True)),
                fused_fp8=(model_id == "qwen-edit-2511-fp8"))
        elif model_id == "hidream-o1-dev":
            workflow = build_hidream_o1_edit(names, prompt, first_dims[0], first_dims[1], seed=seed)
        else:  # flux2-klein-kv
            # 1MP相当に正規化(klein推奨レンジ)
            import math
            scale = math.sqrt(1024 * 1024 / (first_dims[0] * first_dims[1]))
            workflow = build_flux2_klein_edit(
                names, prompt, width=int(first_dims[0] * scale), height=int(first_dims[1] * scale), seed=seed)

        _update_progress(job.id, 0.05)
        _update_phase(job.id, "モデル読み込み中…")
        prompt_id = await comfyui.submit(workflow)
        outputs = await comfyui.wait_for_outputs(
            prompt_id,
            progress_cb=lambda p: _update_progress(job.id, p),
            phase_cb=lambda ph: _update_phase(job.id, ph),
            workflow=workflow)
        dest_dir = GENERATED_DIR / str(project_id)
        asset_ids = []
        for out in outputs:
            fn = out.get("filename", "")
            if not fn:
                continue
            path = await comfyui.download_output(fn, out.get("subfolder", ""), out.get("type", "output"), dest_dir)
            asset_ids.append(_register_asset(project_id, path, "generated", params))
        _update_result_assets(job.id, asset_ids)
        if asset_ids:
            _place_result(params, asset_ids[0])
        log.info(f"AI edit done ({model_id}): {len(asset_ids)} asset(s)")
        return

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
        init_aid = params.get("init_asset_id")
        if init_aid:
            # i2i: 初期画像アセットをComfyUIへアップロードして潜在源にする
            with Session(engine) as session:
                init_asset = session.get(Asset, int(init_aid))
                if not init_asset:
                    raise ValueError(f"i2i初期画像アセット {init_aid} が見つかりません")
                init_path = Path(init_asset.file_path)
            if not init_path.exists():
                raise ValueError(f"i2i初期画像ファイルがありません: {init_path}")
            init_name = (await comfyui.upload_image(init_path)).get("name", init_path.name)
            workflow = build_sdxl_img2img(ckpt, init_name, prompt, neg_prompt,
                                          width, height, seed,
                                          denoise=float(params.get("denoise", 0.6)),
                                          loras=loras or None)
        else:
            workflow = build_sdxl_txt2img(ckpt, prompt, neg_prompt, width, height, seed,
                                          loras=loras or None)

    _update_progress(job.id, 0.05)

    prompt_id = await comfyui.submit(workflow)
    log.info(f"ComfyUI image job submitted: prompt_id={prompt_id}")

    def progress_cb(p): _update_progress(job.id, 0.05 + p * 0.90)

    outputs = await comfyui.wait_for_outputs(
        prompt_id, progress_cb,
        phase_cb=lambda ph: _update_phase(job.id, ph), workflow=workflow)

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
    if asset_ids:
        _place_result(params, asset_ids[0])
    log.info(f"Image generation done: {len(asset_ids)} asset(s) registered")


# ── generate_video_i2v ────────────────────────────────────────────────────────

async def _generate_video_i2v(job: Job, params: dict) -> None:
    from app.services.comfyui import comfyui
    from app.services.workflow_builder import build_svd_i2v

    if not await comfyui.is_available():
        raise RuntimeError(
            "ComfyUI が起動していません。scripts/start.sh で起動してください。"
        )

    # ── T1下見プリセット ──────────────────────────────────────────
    # params["quality"]="t1" の1フラグで最速構成に展開する。
    # 解像度は Ref2V Turbo v0.1 の学習解像度に合わせて **544p** (960x544)。
    #   旧値640x368は ①学習ドメイン(544p)外 ②公式規定(短辺768)から二重に外れており、
    #   fl2v用LoRAの流用と併せてユーザー指摘(2026-08-22)で是正した。
    #   960 = 544 × (1344/768) を32の倍数へ丸めた値(本番と同じ画角)。
    # 品質は下見用(構図・配置・キャラ判別は読める。質感とディテールは崩れる)。
    # TurboLoRAは重み自体が変わるため、同じseedでも本番構成では再現しない
    # (シード選抜には使えない — 使うのはプロンプトと構成の検証)。
    if str(params.get("quality", "")).lower() == "t1":
        params = dict(params)
        params.update({"width": 960, "height": 544, "steps": 4,
                       "turbo_lora": 0.75, "easycache": True,
                       "ref_image_size": "match"})
        log.info("T1下見プリセット適用: 960x544/step4/turbo0.75(ref2v)/easycache")

    model_id = params.get("model", "wan2.2-flf2v")
    if model_id.startswith("wan2.2") or model_id.startswith("minimax-h3"):
        await _generate_video_wan22(job, params)
        return

    project_id = params["project_id"]
    keyframes  = params.get("keyframes", [])
    fps        = int(params.get("fps", 6))
    strength   = float(params.get("motion_strength", 0.6))
    seed       = _resolve_seed(params)

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
        prompt_id, lambda p: _update_progress(job.id, 0.05 + p * 0.85),
        phase_cb=lambda ph: _update_phase(job.id, ph), workflow=wf)

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
    seed       = _resolve_seed(params)
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

    # MiniMax H3 Ref2VA: 参照束(画像/動画/音声)+指示文→映像+音声
    if mode == "minimax-h3-ref":
        from app.services.workflow_builder import build_minimax_h3_ref_video, h3_snap_length, H3_FPS
        _update_progress(job.id, 0.05)
        # keyframes=参照画像(≤9)。動画/音声参照はasset_idリストで受ける
        rv_names, ra_names = [], []
        for aid in (params.get("ref_video_asset_ids") or [])[:3]:
            pth = _asset_path(int(aid))
            rv_names.append((await comfyui.upload_image(pth)).get("name", pth.name))
        for aid in (params.get("ref_audio_asset_ids") or [])[:3]:
            pth = _asset_path(int(aid))
            ra_names.append((await comfyui.upload_image(pth)).get("name", pth.name))
        length = h3_snap_length(int(round(duration * H3_FPS)))
        wf = build_minimax_h3_ref_video(
            prompt=prompt, ref_image_names=names[:9],
            ref_video_names=rv_names or None, ref_audio_names=ra_names or None,
            width=width, height=height, length=length,
            seed=seed, steps=int(params.get("steps") or 15),
            scheduler=str(params.get("scheduler") or "beta"),
            ref_image_size=str(params.get("ref_image_size") or "match"),
            easycache=params.get("easycache") is not False,   # 既定ON(明示OFFのみ無効)
            use_ref_video_audio=bool(params.get("use_ref_video_audio")),
            turbo_lora=(float(params["turbo_lora"]) if params.get("turbo_lora") else None),
            preview_steps=(int(params["preview_steps"]) if params.get("preview_steps") else None),
        )
        prompt_id = await comfyui.submit(wf)
        outputs = await comfyui.wait_for_outputs(
            prompt_id, lambda p: _update_progress(job.id, 0.05 + p * 0.89),
            phase_cb=lambda ph: _update_phase(job.id, ph), workflow=wf)
        video_path = None
        for out in outputs:
            fn = out.get("filename", "")
            if fn.endswith((".mp4", ".webm", ".mov")):
                video_path = await comfyui.download_output(
                    fn, out.get("subfolder", ""), out.get("type", "output"), dest_dir)
                break
        if not video_path:
            raise RuntimeError(f"H3 Ref2VAが動画を出力しませんでした: {outputs}")
        newp = dest_dir / f"h3r_{job.id}{video_path.suffix}"
        video_path.replace(newp)
        asset_id = _register_asset(project_id, newp, "generated", params)
        _update_result_assets(job.id, [asset_id])
        _place_result(params, asset_id)
        log.info(f"MiniMax H3 Ref2VA done: {length}f, refs={len(names)}img/{len(rv_names)}vid/{len(ra_names)}aud → {newp.name}")
        return

    # MiniMax H3: 映像+ネイティブ音声を1パス生成(最初/最後フレーム条件付け)
    if mode == "minimax-h3":
        from app.services.workflow_builder import build_minimax_h3_video, h3_snap_length, H3_FPS
        _update_progress(job.id, 0.08)
        first_name = names[0]
        last_name = names[-1] if len(names) >= 2 else None
        length = h3_snap_length(int(round(duration * H3_FPS)))
        wf = build_minimax_h3_video(
            prompt=prompt, width=width, height=height, length=length,
            first_image_name=first_name, last_image_name=last_name,
            seed=seed, steps=int(params.get("steps") or 15),
            easycache=params.get("easycache") is not False,   # 既定ON(明示OFFのみ無効)
            preview_steps=(int(params["preview_steps"]) if params.get("preview_steps") else None),
        )
        prompt_id = await comfyui.submit(wf)
        outputs = await comfyui.wait_for_outputs(
            prompt_id, lambda p: _update_progress(job.id, 0.08 + p * 0.86),
            phase_cb=lambda ph: _update_phase(job.id, ph), workflow=wf)
        # SaveVideoはmp4(音声込み)を直接出力する — フレーム再結合は不要
        video_path = None
        for out in outputs:
            fn = out.get("filename", "")
            if fn.endswith((".mp4", ".webm", ".mov")):
                video_path = await comfyui.download_output(
                    fn, out.get("subfolder", ""), out.get("type", "output"), dest_dir)
                break
        if not video_path:
            raise RuntimeError(f"H3が動画を出力しませんでした: {outputs}")
        newp = dest_dir / f"h3_{job.id}{video_path.suffix}"
        video_path.replace(newp)
        asset_id = _register_asset(project_id, newp, "generated", params)
        _update_result_assets(job.id, [asset_id])
        _place_result(params, asset_id)
        log.info(f"MiniMax H3 done: {length}f(+audio) → {newp.name}")
        return

    # VACE: 任意フレーム位置に1パスで釘打ち(区間連結なし=つなぎ目の断絶なし)
    if mode == "wan2.2-vace":
        from app.services.workflow_builder import build_wan22_vace_video
        length = max(5, int(round((total_len - 1) / 4)) * 4 + 1)   # Wan: 4n+1
        t0 = min(float(kf.get("time_sec", 0.0)) for kf in keyframes)
        t1 = max(float(kf.get("time_sec", 0.0)) for kf in keyframes)
        span = max(t1 - t0, 1e-6)
        kf_pos: list[tuple[str, int]] = []
        for name, kf in zip(names, keyframes):
            # time_sec があればタイムライン相対位置を尊重、無ければ等間隔
            if len(keyframes) > 1 and t1 > t0:
                frac = (float(kf.get("time_sec", 0.0)) - t0) / span
            else:
                frac = 0.0 if len(kf_pos) == 0 else len(kf_pos) / max(1, len(keyframes) - 1)
            # 4の倍数へスナップ: Wan VAEの時間4x圧縮でlatentフレーム境界に整列させる
            # (非整列だとキーフレームが数フレームに滲む)。0とlength-1(=4n)は常に整列。
            kf_pos.append((name, int(round(frac * (length - 1) / 4)) * 4))
        wf = build_wan22_vace_video(
            keyframes=kf_pos, prompt=prompt, negative_prompt=neg_prompt,
            width=width, height=height, length=length, seed=seed,
            use_lightning=use_light,
        )
        prompt_id = await comfyui.submit(wf)
        outputs = await comfyui.wait_for_outputs(
            prompt_id, lambda p: _update_progress(job.id, 0.10 + p * 0.80),
            phase_cb=lambda ph: _update_phase(job.id, ph), workflow=wf)
        all_frames = []
        for i, out in enumerate(outputs):
            fn = out.get("filename", "")
            if not fn:
                continue
            p = await comfyui.download_output(fn, out.get("subfolder", ""), out.get("type", "output"), dest_dir)
            newp = dest_dir / f"wanseg_{job.id}_00_{i:04d}{p.suffix}"
            p.replace(newp)
            all_frames.append(newp)
        all_frames.sort()
        if not all_frames:
            raise RuntimeError("Wan2.2 VACE がフレームを出力しませんでした")
        video_path = await _frames_to_video(all_frames, dest_dir, WAN22_FPS, job.id)
        asset_id = _register_asset(project_id, video_path, "generated", params)
        _update_result_assets(job.id, [asset_id])
        _place_result(params, asset_id)
        for fp in all_frames:
            fp.unlink(missing_ok=True)
        log.info(f"Wan2.2 VACE done: {len(all_frames)} frames, {len(kf_pos)} keyframes → {video_path.name}")
        return

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
    _place_result(params, asset_id)
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
    seed       = _resolve_seed(params)

    _update_progress(job.id, 0.1)
    if params.get("cover_src_asset"):
        # Cover: 原盤の旋律を保って歌詞差し替え(当て書きワークフロー)
        with Session(engine) as session:
            src = session.get(Asset, int(params["cover_src_asset"]))
            if not src:
                raise ValueError("cover元アセットが見つかりません")
            src_bytes = Path(src.file_path).read_bytes()
        audio_bytes = await acestep.cover(
            src_bytes, lyrics=lyrics, caption=caption,
            vocal_language=vocal_lang, seed=seed)
    elif params.get("repaint_src_asset"):
        # Repaint: 既存曲の区間だけを文脈保持で描き直す(一体感を保った過激化)
        with Session(engine) as session:
            src = session.get(Asset, int(params["repaint_src_asset"]))
            if not src:
                raise ValueError("repaint元アセットが見つかりません")
            src_bytes = Path(src.file_path).read_bytes()
        audio_bytes = await acestep.repaint(
            src_bytes, float(params["repaint_start"]), float(params["repaint_end"]),
            caption=caption, lyrics=lyrics, vocal_language=vocal_lang, seed=seed)
    else:
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

def _store_analysis(asset_id: int, kind: str, data: dict) -> None:
    """解析結果のupsert(同じ種別は1アセットに1件)"""
    from app.models.analysis import AnalysisResult
    with Session(engine) as session:
        old = session.exec(
            select(AnalysisResult)  # type: ignore[arg-type]
            .where(AnalysisResult.asset_id == asset_id)
            .where(AnalysisResult.analysis_type == kind)
        ).first()
        if old:
            session.delete(old)
        session.add(AnalysisResult(asset_id=asset_id, analysis_type=kind,
                                   result_json=json.dumps(data, ensure_ascii=False)))
        session.commit()


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

    # ── ステム(歌唱/伴奏)の自動検出 ────────────────────────────────────
    # 「<曲名>(歌唱).wav」「<曲名>(伴奏).wav」の命名で同じプロジェクトに置かれる。
    # ステムがあると駆動力を伴奏だけから取れる(混合はボーカルの低域が乗って濁る)。
    vocal_path = inst_path = None
    with Session(engine) as session:
        from app.models import Asset as _A
        stem = file_path.stem
        sibs = session.exec(select(_A).where(_A.project_id == asset.project_id)).all()
        for a2 in sibs:
            n = Path(a2.file_path).stem
            if not n.startswith(stem):
                continue
            if "歌唱" in n or "vocal" in n.lower():
                vocal_path = Path(a2.file_path)
            elif "伴奏" in n or "inst" in n.lower():
                inst_path = Path(a2.file_path)
    if vocal_path or inst_path:
        log.info(f"stems found: vocal={bool(vocal_path)} inst={bool(inst_path)}")

    # ── 楽曲構造(区間ラベル + サビ前の盛り上げ) ────────────────────────
    structure = None
    try:
        from app.services.audio_analyzer import analyze_song_structure
        _update_progress(job.id, 0.91)
        structure = await asyncio.get_event_loop().run_in_executor(
            None, analyze_song_structure, file_path, vocal_path, inst_path,
            result["downbeats"])
        _store_analysis(asset_id, "audio_structure", structure)
        log.info(f"Structure done: {len(structure['sections'])} sections")
    except Exception as e:
        log.warning(f"Structure failed: {e}")

    # ── 移動量バジェット(帯域別エネルギー→推奨移動量) ─────────────────────
    # 拍解析と同じ素材から続けて出す。失敗しても拍解析は残す(こちらは補助情報)。
    try:
        from app.services.audio_analyzer import analyze_motion_budget
        _update_progress(job.id, 0.93)
        mb = await asyncio.get_event_loop().run_in_executor(
            None, lambda: analyze_motion_budget(
                file_path, structure=structure,
                inst_path=inst_path, vocal_path=vocal_path)
        )
        _store_analysis(asset_id, "audio_motion", mb)
        log.info(f"Motion budget done: asset={asset_id} frames={mb['frames']}")
    except Exception as e:
        log.warning(f"Motion budget failed (beats kept): {e}")

    # ── 楽曲構造(副): allin1 ──────────────────────────────────────────
    # 主(自作)と併記して人が判断する。重い(CPUで約2.5分)ので最後に回す。
    try:
        from app.services.audio_analyzer import analyze_structure_allin1
        _update_progress(job.id, 0.94)
        a1 = await asyncio.get_event_loop().run_in_executor(
            None, analyze_structure_allin1, file_path)
        log.info(f"allin1 structure done: {len(a1['sections'])} sections")
        # 境界はallin1、盛り上げ判定は自作 —— 統合して主(audio_structure)にする。
        # 移動量バジェットはこの主を見るので、精度の高い境界がそのまま効く。
        #
        # 副(audio_structure_alt)には **自作** を入れる。ここにallin1を入れると
        # 主と同一内容になり、副の行がただの重複表示になってしまう(実測で確認)。
        # 副の役割は「主とどこが違うか」を見せることなので、比較対象は自作側。
        if structure:
            from app.services.audio_analyzer import merge_structures
            merged = merge_structures(structure, a1, result["downbeats"])
            _store_analysis(asset_id, "audio_structure_alt", structure)   # 自作=比較用
            _store_analysis(asset_id, "audio_structure", merged)          # 統合=主
            structure = merged
            log.info(f"structure merged: {len(merged['sections'])} sections, "
                     f"{len(merged['buildups'])} buildups")
        else:
            _store_analysis(asset_id, "audio_structure", a1)
    except Exception as e:
        log.warning(f"allin1 structure failed (主は残る): {e}")

    # ── ドラム個別打点(5クラス) ───────────────────────────────────────
    # 伴奏ステムがあればそちらを使う(歌が混ざると誤検出が増える)。
    try:
        from app.services.audio_analyzer import analyze_drums
        _update_progress(job.id, 0.96)
        src = inst_path or file_path
        dr = await asyncio.get_event_loop().run_in_executor(None, analyze_drums, src)
        _store_analysis(asset_id, "audio_drums", dr)
        log.info("Drums done: " + " ".join(
            f"{k}={len(v)}" for k, v in dr.get("classes", {}).items()))
    except Exception as e:
        log.warning(f"Drum transcription failed: {e}")


# ── アセット登録 ──────────────────────────────────────────────────────────────

def _register_asset(project_id: int, file_path: Path, source: str, gen_params: dict) -> int:
    """Register a generated file as an Asset in the DB. Returns asset_id."""
    from app.services.media_info import probe
    from app.services.thumbnail import generate_video_thumbnail, generate_image_thumbnail

    info = probe(file_path)
    slim = dict(gen_params or {})   # keyframes含む全パラメータ(再生成に使う)
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


# ── 復元(2026-08-21) ────────────────────────────────────────────────────────
# 会話ログに残っていたソースから復元した関数群。
# 事故: 解析ブロックを追記する際、置換範囲を『指定位置〜ファイル末尾』にしてしまい、
#       以降の関数定義13個を消した。バックアップもgitも無く、ログから拾い直した。


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


async def _separate_vocals(job: Job, params: dict) -> None:
    """
    audio-separator(BS-RoFormer)で音声アセットを歌唱/伴奏に分離し、
    「{name}(歌唱).wav」「{name}(伴奏).wav」として登録する。
    H3 Ref2VAのリップシンク参照音声(クリーンな歌声)用。
    GPUがOOM(ComfyUIのモデル常駐時)ならCPUで再試行する。
    """
    import os
    import tempfile

    asset_id = params["asset_id"]
    with Session(engine) as session:
        asset = session.get(Asset, asset_id)
        if not asset:
            raise ValueError(f"Asset {asset_id} not found")
        src = Path(asset.file_path)
        project_id = asset.project_id
        base = src.stem
    if not src.exists():
        raise ValueError(f"アセットファイルが見つかりません: {src}")
    if not SEPARATOR_BIN.exists():
        raise RuntimeError("audio-separatorが未インストールです(backend venv)")

    _update_progress(job.id, 0.05)
    with tempfile.TemporaryDirectory(prefix="sep_") as tmp:
        async def run(env_extra: dict[str, str]) -> tuple[int, str]:
            proc = await asyncio.create_subprocess_exec(
                str(SEPARATOR_BIN), str(src),
                "--model_filename", SEPARATOR_MODEL,
                "--output_dir", tmp, "--output_format", "wav",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env={**os.environ, **env_extra},
            )
            _, stderr = await proc.communicate()
            return proc.returncode, stderr.decode()

        rc, err = await run({})
        if rc != 0 and ("out of memory" in err.lower() or "cuda" in err.lower()):
            log.warning("separate_vocals: GPU失敗→CPUで再試行")
            _update_progress(job.id, 0.1)
            rc, err = await run({"CUDA_VISIBLE_DEVICES": ""})
        if rc != 0:
            raise RuntimeError(f"分離に失敗: {err[-400:]}")

        outs = list(Path(tmp).glob("*.wav"))
        vocals = next((p for p in outs if "(Vocals)" in p.name), None)
        inst = next((p for p in outs if "(Instrumental)" in p.name), None)
        if not vocals or not inst:
            raise RuntimeError(f"分離出力が見つかりません: {[p.name for p in outs]}")
        _update_progress(job.id, 0.85)

        dest_dir = Path(__file__).resolve().parents[2] / "data" / "assets" / str(project_id)
        dest_dir.mkdir(parents=True, exist_ok=True)
        ids = []
        for stem_path, label in ((vocals, "歌唱"), (inst, "伴奏")):
            dest = dest_dir / f"{base}({label}).wav"
            counter = 1
            while dest.exists():
                dest = dest_dir / f"{base}({label})_{counter}.wav"
                counter += 1
            stem_path.replace(dest)
            ids.append(_register_asset(project_id, dest, "separated",
                                       {"source_asset_id": asset_id, "stem": label}))
    _update_result_assets(job.id, ids)
    _update_progress(job.id, 1.0)


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
            raise RuntimeError(f"{cmd[1]} failed:\
{tail}")
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


async def _render_orbit3d(job: Job, params: dict) -> None:
    """既存の model3d アセットからカメラワーク付き透過webmを生成する独立ジョブ。"""
    project_id = params["project_id"]
    with Session(engine) as session:
        asset = session.get(Asset, params["asset_id"])
        if not asset:
            raise ValueError(f"Asset {params['asset_id']} not found")
        glb_path = Path(asset.file_path)
    _update_progress(job.id, 0.1)
    dest_dir = GENERATED_DIR / str(project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    webm = await _orbit_render(glb_path, dest_dir, params.get("orbit") or params)
    if not webm:
        raise RuntimeError("orbit render failed (render_orbit.mjs ログ参照)")
    asset_ids = [_register_asset(project_id, webm, "generated", params)]
    _update_result_assets(job.id, asset_ids)


async def _generate_3d(job: Job, params: dict) -> None:
    """
    3Dモデル生成。mode:
      object    — 単一画像 → Hunyuan3D-2 メッシュ(事前に cutout で背景透過推奨)
      object_mv — 正面/左/背面/右 マルチビュー → Hunyuan3D-2mv メッシュ
      relief    — 一枚絵 → MoGe-2 テクスチャ付きレリーフメッシュ(3Dフォト演出用)
    orbit パラメータ付きなら GLB 生成後にカメラワーク付き透過webmも作る。
    """
    from app.services.comfyui import comfyui
    from app.services.workflow_builder import (
        build_hunyuan3d_i23d, build_hunyuan3d_mv, build_moge_relief
    )

    if not await comfyui.is_available():
        raise RuntimeError("ComfyUI が起動していません。scripts/start.sh で起動してください。")

    project_id = params["project_id"]
    mode = params.get("mode", "object")

    def _asset_path(aid: int) -> Path:
        with Session(engine) as session:
            a = session.get(Asset, aid)
            if not a:
                raise ValueError(f"Asset {aid} not found")
            return Path(a.file_path)

    if mode == "object_mv":
        views = {}
        for v in ("front", "left", "back", "right"):
            aid = (params.get("views") or {}).get(v)
            if aid:
                p = _asset_path(int(aid))
                views[v] = (await comfyui.upload_image(p)).get("name", p.name)
        if "front" not in views:
            raise ValueError("object_mv には最低 front 画像が必要です")
        workflow = build_hunyuan3d_mv(
            views, seed=int(params.get("seed", -1)),
            steps=int(params.get("steps", 30)),
            octree_resolution=int(params.get("octree_resolution", 256)))
    else:
        p = _asset_path(int(params["image_asset_id"]))
        name = (await comfyui.upload_image(p)).get("name", p.name)
        if mode == "relief":
            workflow = build_moge_relief(
                name,
                resolution_level=int(params.get("resolution_level", 9)),
                decimation=int(params.get("decimation", 500000)),
                discontinuity_threshold=float(params.get("discontinuity_threshold", 0.03)),
                fov_x_degrees=float(params.get("fov_x_degrees", 60.0)))
        else:
            workflow = build_hunyuan3d_i23d(
                name, seed=int(params.get("seed", -1)),
                steps=int(params.get("steps", 30)),
                octree_resolution=int(params.get("octree_resolution", 256)))

    _update_progress(job.id, 0.05)
    prompt_id = await comfyui.submit(workflow)
    log.info(f"ComfyUI 3D job submitted: mode={mode} prompt_id={prompt_id}")

    def progress_cb(p): _update_progress(job.id, 0.05 + p * 0.75)
    outputs = await comfyui.wait_for_outputs(prompt_id, progress_cb)

    dest_dir = GENERATED_DIR / str(project_id)
    asset_ids = []
    glb_path: Path | None = None
    for out_info in outputs:
        filename = out_info.get("filename", "")
        if not filename:
            continue
        path = await comfyui.download_output(
            filename, out_info.get("subfolder", ""), out_info.get("type", "output"), dest_dir)
        if path.suffix.lower() in (".glb", ".gltf"):
            asset_ids.append(_register_model3d(project_id, path, params))
            glb_path = path
        else:
            asset_ids.append(_register_asset(project_id, path, "generated", params))

    # オプション: そのままカメラワーク付き透過webmへ
    orbit = params.get("orbit")
    if orbit and glb_path:
        _update_progress(job.id, 0.85)
        webm = await _orbit_render(glb_path, dest_dir, orbit)
        if webm:
            asset_ids.append(_register_asset(project_id, webm, "generated",
                                             {**params, "orbit_of": str(glb_path.name)}))

    _update_result_assets(job.id, asset_ids)
    log.info(f"3D generation done: {len(asset_ids)} asset(s)")


async def _generate_video_3dcam(job: Job, params: dict) -> None:
    """
    GLB(model3d) + カメラ指定 → 深度レンダ(render_orbit.mjs --style depth)
    → Wan2.2 Fun Control で ref_image の画風どおりの動画を生成する。
    「カメラワークは3Dで決め、絵はAIが描く」の本命ワークフロー。
    """
    from app.services.comfyui import comfyui
    from app.services.workflow_builder import build_wan22_fun_control

    if not await comfyui.is_available():
        raise RuntimeError("ComfyUI が起動していません。scripts/start.sh で起動してください。")

    project_id = params["project_id"]
    fps = 16
    length = int(params.get("length", 81))          # 4n+1
    length = max(5, (length - 1) // 4 * 4 + 1)
    width = int(params.get("width", 832))
    height = int(params.get("height", 480))

    def _asset_path(aid: int) -> Path:
        with Session(engine) as session:
            a = session.get(Asset, aid)
            if not a:
                raise ValueError(f"Asset {aid} not found")
            return Path(a.file_path)

    glb_path = _asset_path(int(params["model_asset_id"]))
    ref_path = _asset_path(int(params["ref_image_asset_id"]))
    dest_dir = GENERATED_DIR / str(project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)

    # 1) 深度コントロール動画をレンダ
    _update_progress(job.id, 0.03)
    kit = REPO_ROOT / "tools" / "3d-kit"
    depth_mp4 = dest_dir / f"depthctl_{job.id}.mp4"
    cmd = ["node", str(kit / "render_orbit.mjs"),
           "--glb", str(glb_path), "--out", str(depth_mp4),
           "--frames", str(length), "--fps", str(fps),
           "--width", str(width), "--height", str(height), "--style", "depth"]
    camera = params.get("camera") or {}
    if isinstance(camera, list):
        cmd += ["--camera-json", json.dumps(camera)]
    else:
        cmd += ["--preset", str(camera.get("preset", params.get("preset", "arc_r")))]
        if camera.get("turns") is not None:
            cmd += ["--turns", str(camera["turns"])]
    proc = await asyncio.create_subprocess_exec(
        *cmd, cwd=str(kit),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=600)
    if proc.returncode != 0 or not depth_mp4.exists():
        raise RuntimeError(f"深度レンダ失敗: {stdout.decode()[-800:]}")

    # 2) アップロード → Fun Control 生成
    _update_progress(job.id, 0.15)
    up_ref = (await comfyui.upload_image(ref_path)).get("name", ref_path.name)
    up_ctl = (await comfyui.upload_image(depth_mp4)).get("name", depth_mp4.name)

    wf = build_wan22_fun_control(
        ref_image_name=up_ref, control_video_name=up_ctl,
        prompt=params.get("prompt", ""),
        negative_prompt=params.get("negative_prompt", ""),
        width=width, height=height, length=length,
        seed=int(params.get("seed", -1)),
        use_lightning=bool(params.get("use_lightning", True)),
        total_steps=int(params.get("steps", 4)))
    prompt_id = await comfyui.submit(wf)
    log.info(f"Fun Control 3dcam submitted: prompt_id={prompt_id}")

    def cb(p): _update_progress(job.id, 0.15 + p * 0.75)
    outputs = await comfyui.wait_for_outputs(prompt_id, cb)

    frames: list[Path] = []
    for i, out in enumerate(outputs):
        fn = out.get("filename", "")
        if not fn:
            continue
        p = await comfyui.download_output(fn, out.get("subfolder", ""), out.get("type", "output"), dest_dir)
        newp = dest_dir / f"cam3d_{job.id}_{i:04d}{p.suffix}"
        p.replace(newp)
        frames.append(newp)
    if not frames:
        raise RuntimeError("Fun Control がフレームを出力しませんでした")

    video_path = await _frames_to_video(sorted(frames), dest_dir, fps, job.id)
    final = dest_dir / f"cam3d_{job.id}.mp4"
    video_path.replace(final)
    asset_ids = [_register_asset(project_id, final, "generated", params)]
    if params.get("keep_control_video"):
        asset_ids.append(_register_asset(project_id, depth_mp4, "generated",
                                         {**params, "control_of": final.name}))
    else:
        depth_mp4.unlink(missing_ok=True)
    for fp in frames:
        fp.unlink(missing_ok=True)
    _update_result_assets(job.id, asset_ids)
    log.info(f"3dcam video done: {final.name} ({len(frames)} frames)")


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


async def _analyze_video(job: Job, params: dict) -> None:
    """⚠ 未復元。2026-08-21の事故で失われ、ログからも完全な形で復元できなかった。

    ジョブ種別 "analyze_video" はこの関数が実装されるまで使えない。
    黙って失敗すると原因が分からなくなるので、明示的に失敗させる。
    """
    raise RuntimeError(
        "_analyze_video は2026-08-21の編集事故で失われ、未復元です。"
        "docs/incident-2026-08-21.md を参照してください。")


async def _vlm_review(job: Job, params: dict) -> None:
    """⚠ 未復元。2026-08-21の事故で失われ、ログからも完全な形で復元できなかった。

    ジョブ種別 "vlm_review" はこの関数が実装されるまで使えない。
    黙って失敗すると原因が分からなくなるので、明示的に失敗させる。
    """
    raise RuntimeError(
        "_vlm_review は2026-08-21の編集事故で失われ、未復元です。"
        "docs/incident-2026-08-21.md を参照してください。")


async def _puppet_clip(job: Job, params: dict) -> None:
    """⚠ 未復元。2026-08-21の事故で失われ、ログからも完全な形で復元できなかった。

    ジョブ種別 "puppet_clip" はこの関数が実装されるまで使えない。
    黙って失敗すると原因が分からなくなるので、明示的に失敗させる。
    """
    raise RuntimeError(
        "_puppet_clip は2026-08-21の編集事故で失われ、未復元です。"
        "docs/incident-2026-08-21.md を参照してください。")


async def _render_motion_graphics(job: Job, params: dict) -> None:
    """⚠ 未復元。2026-08-21の事故で失われ、ログからも完全な形で復元できなかった。

    ジョブ種別 "render_motion_graphics" はこの関数が実装されるまで使えない。
    黙って失敗すると原因が分からなくなるので、明示的に失敗させる。
    """
    raise RuntimeError(
        "_render_motion_graphics は2026-08-21の編集事故で失われ、未復元です。"
        "docs/incident-2026-08-21.md を参照してください。")


async def _interpolate(job: Job, params: dict) -> None:
    """⚠ 未復元。2026-08-21の事故で失われ、ログからも完全な形で復元できなかった。

    ジョブ種別 "interpolate" はこの関数が実装されるまで使えない。
    黙って失敗すると原因が分からなくなるので、明示的に失敗させる。
    """
    raise RuntimeError(
        "_interpolate は2026-08-21の編集事故で失われ、未復元です。"
        "docs/incident-2026-08-21.md を参照してください。")
