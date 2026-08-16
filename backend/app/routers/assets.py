import json
import mimetypes
import shutil
import subprocess
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse
from sqlmodel import Session, select

from app.db.database import get_session
from app.models import Asset, AssetCreate, AssetRead
from app.models.job import Job
from app.services.media_info import probe
from app.services.thumbnail import generate_video_thumbnail, generate_image_thumbnail, thumbnail_path


def _queue_proxy(session: Session, asset: Asset) -> int:
    """Queue a low-res proxy generation job for a video asset."""
    job = Job(
        project_id=asset.project_id, job_type="create_proxy",
        params=json.dumps({"asset_id": asset.id, "project_id": asset.project_id}),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job.id

ASSETS_DIR = Path(__file__).parent.parent.parent / "data" / "assets"

router = APIRouter(prefix="/assets", tags=["assets"])


def _asset_dir(project_id: int) -> Path:
    d = ASSETS_DIR / str(project_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


_fps_cache: dict[str, tuple[float, float] | None] = {}


def _src_video_info(path: Path) -> tuple[float, float] | None:
    """動画の実fps(avg_frame_rate)と長さ。抽出時刻の源フレームグリッドスナップに使う。"""
    key = str(path)
    if key in _fps_cache:
        return _fps_cache[key]
    import subprocess as sp
    try:
        out = sp.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=avg_frame_rate", "-show_entries", "format=duration",
             "-of", "csv=p=0", key],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip().split("\n")
        num, den = out[0].split("/")
        fps = float(num) / float(den) if float(den) else 0.0
        dur = float(out[1]) if len(out) > 1 else 0.0
        info = (fps, dur) if fps > 0 else None
    except Exception:
        info = None
    _fps_cache[key] = info
    return info


def _snap_seek(path: Path, time_sec: float) -> float:
    """
    抽出時刻を「その時刻にプレビューが表示している源フレーム」に合わせる。
    ブラウザは floor(t*fps) のフレームを表示するが、ffmpegの-ssは「t以降の最初の
    フレーム」(切り上げ)を選ぶため、境界に乗らない時刻では1フレームずれる。
    → 対象フレームn=floor(t*fps)を確実に選ぶよう (n-0.5)/fps へスナップする。
    タイムラインが源動画より長い場合は最終フレームにクランプ。
    """
    info = _src_video_info(path)
    if not info:
        return max(0.0, time_sec)
    fps, dur = info
    n = int(time_sec * fps + 1e-6)
    if dur > 0:
        n = min(n, max(0, int(dur * fps - 0.5) - 1))
    return max(0.0, (n - 0.5) / fps)


def _make_thumbnail(asset: Asset) -> None:
    src = Path(asset.file_path)
    if not src.exists():
        return
    if asset.asset_type == "video":
        generate_video_thumbnail(src, asset.id)
    elif asset.asset_type == "image":
        generate_image_thumbnail(src, asset.id)


@router.get("/", response_model=list[AssetRead])
def list_assets(project_id: int | None = None, session: Session = Depends(get_session)):
    query = select(Asset)
    if project_id is not None:
        # ⭐スター付きアセットはプロジェクトを跨いで共有表示される
        query = query.where((Asset.project_id == project_id) | (Asset.starred == True))  # noqa: E712
    return session.exec(query).all()


@router.post("/{asset_id}/star", response_model=AssetRead)
def toggle_star(asset_id: int, session: Session = Depends(get_session)):
    """⭐トグル: スター付きアセットは全プロジェクトのアセットパネルに現れる。"""
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    asset.starred = not asset.starred
    session.add(asset)
    session.commit()
    session.refresh(asset)
    return asset


@router.post("/upload", response_model=AssetRead, status_code=201)
async def upload_asset(
    background_tasks: BackgroundTasks,
    project_id: int = Form(...),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
):
    dest_dir = _asset_dir(project_id)
    dest = dest_dir / file.filename
    # avoid name collisions
    counter = 1
    while dest.exists():
        stem, suffix = Path(file.filename).stem, Path(file.filename).suffix
        dest = dest_dir / f"{stem}_{counter}{suffix}"
        counter += 1

    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    info = probe(dest)

    asset = Asset(
        project_id=project_id,
        name=dest.name,
        asset_type=info.asset_type,
        file_path=str(dest),
        duration_sec=info.duration_sec,
        width=info.width,
        height=info.height,
        file_size_bytes=info.file_size_bytes,
    )
    session.add(asset)
    session.commit()
    session.refresh(asset)

    background_tasks.add_task(_make_thumbnail, asset)

    # Auto-generate a lightweight preview proxy.
    # video → 640px mp4 / audio → AAC 96k m4a(回線越しプレビューでPCM wavは重すぎるため)
    if info.asset_type in ("video", "audio"):
        _queue_proxy(session, asset)

    return asset


@router.post("/{asset_id}/extract-frame", response_model=AssetRead, status_code=201)
def extract_frame(
    asset_id: int,
    background_tasks: BackgroundTasks,
    time_sec: float = 0.0,
    long_edge: int | None = None,   # 出力の長辺px(lanczos)。None=元解像度
    session: Session = Depends(get_session),
):
    """
    Extract a single frame from a video asset at ``time_sec`` and register it as a
    new image asset. Used to pick a source frame from the timeline (slider/playhead)
    for I2V keyframes or I2I input.
    """
    import subprocess
    import imageio_ffmpeg

    src_asset = session.get(Asset, asset_id)
    if not src_asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    src = Path(src_asset.file_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source file not found on disk")

    dest_dir = _asset_dir(src_asset.project_id)
    t = _snap_seek(src, max(0.0, time_sec))   # プレビュー表示フレームと一致させる
    dest = dest_dir / f"frame_{asset_id}_{int(t * 1000)}ms.png"
    counter = 1
    while dest.exists():
        dest = dest_dir / f"frame_{asset_id}_{int(t * 1000)}ms_{counter}.png"
        counter += 1

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    # long_edge指定時は長辺をそのpxへlanczosリスケール(高解像度素材の縮小/低解像度素材の拡大の両対応)
    vf = []
    if long_edge and long_edge > 0:
        vf = ["-vf",
              f"scale='if(gte(iw,ih),{long_edge},-2)':'if(gte(iw,ih),-2,{long_edge})':flags=lanczos"]
    proc = subprocess.run(
        [ffmpeg, "-y", "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1", *vf, str(dest)],
        capture_output=True,
    )
    if proc.returncode != 0 or not dest.exists():
        raise HTTPException(status_code=400, detail=f"Frame extraction failed: {proc.stderr.decode()[-300:]}")

    info = probe(dest)
    asset = Asset(
        project_id=src_asset.project_id,
        name=dest.name,
        asset_type="image",
        file_path=str(dest),
        duration_sec=None,
        width=info.width,
        height=info.height,
        file_size_bytes=info.file_size_bytes,
    )
    session.add(asset)
    session.commit()
    session.refresh(asset)
    background_tasks.add_task(_make_thumbnail, asset)
    return asset


@router.post("/{asset_id}/extract-audio", response_model=AssetRead, status_code=201)
def extract_audio(asset_id: int, session: Session = Depends(get_session)):
    """
    動画アセットから音声トラックをwavで抽出し、音声アセットとして登録する。
    → 既存のBPM解析・ビートグリッド・音ハメスコアがそのまま使えるようになる。
    """
    import subprocess
    import imageio_ffmpeg
    from app.services.media_info import probe

    src_asset = session.get(Asset, asset_id)
    if not src_asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    src = Path(src_asset.file_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source file not found")

    dest_dir = _asset_dir(src_asset.project_id)
    dest = dest_dir / f"{src.stem}_audio.wav"
    counter = 1
    while dest.exists():
        dest = dest_dir / f"{src.stem}_audio_{counter}.wav"
        counter += 1

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    proc = subprocess.run(
        [ffmpeg, "-y", "-i", str(src), "-vn", "-acodec", "pcm_s16le", "-ar", "44100", str(dest)],
        capture_output=True,
    )
    if proc.returncode != 0 or not dest.exists() or dest.stat().st_size < 1024:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="音声がない素材か、抽出に失敗しました")

    info = probe(dest)
    asset = Asset(
        project_id=src_asset.project_id, name=dest.name, asset_type="audio",
        file_path=str(dest), duration_sec=info.duration_sec,
        width=None, height=None, file_size_bytes=info.file_size_bytes,
    )
    session.add(asset)
    session.commit()
    session.refresh(asset)
    return asset


@router.get("/{asset_id}/frame-preview")
def frame_preview(asset_id: int, time_sec: float = 0.0, height: int = 360,
                  session: Session = Depends(get_session)):
    """
    スクラブ用の軽量フレームプレビュー(JPEG、アセット登録なし)。
    フレームピッカーのスライダー操作で叩かれる想定なので小さめ+高速シークで返す。
    """
    import subprocess
    import imageio_ffmpeg
    from fastapi.responses import Response

    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    src = Path(asset.file_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source file not found")
    t = _snap_seek(src, max(0.0, time_sec))   # 挿入されるフレーム(extract-frame)と一致させる
    h = max(64, min(720, height))
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    proc = subprocess.run(
        [ffmpeg, "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1",
         "-vf", f"scale=-2:{h}", "-f", "image2", "-c:v", "mjpeg", "-q:v", "4", "pipe:1"],
        capture_output=True,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise HTTPException(status_code=400, detail="preview failed")
    return Response(content=proc.stdout, media_type="image/jpeg",
                    headers={"Cache-Control": "max-age=3600"})


FILMSTRIP_DIR = Path(__file__).parent.parent.parent / "data" / "proxies"


@router.get("/{asset_id}/filmstrip")
def get_filmstrip(asset_id: int, count: int = 10, session: Session = Depends(get_session)):
    """A horizontal sprite of N evenly-spaced frames (cached) for the clip background."""
    import subprocess
    import imageio_ffmpeg

    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    if asset.asset_type not in ("video", "generated") or not asset.duration_sec:
        raise HTTPException(status_code=404, detail="No filmstrip for this asset")
    src = Path(asset.file_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source not found")

    n = max(2, min(40, count))
    dest_dir = FILMSTRIP_DIR / str(asset.project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{asset_id}_strip96_{n}.jpg"
    if not dest.exists():
        fps = n / max(0.1, asset.duration_sec)
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        proc = subprocess.run(
            [ffmpeg, "-y", "-i", str(src),
             "-vf", f"fps={fps:.4f},scale=96:54:force_original_aspect_ratio=increase,crop=96:54,tile={n}x1",
             "-frames:v", "1", str(dest)],
            capture_output=True,
        )
        if proc.returncode != 0 or not dest.exists():
            raise HTTPException(status_code=400, detail="Filmstrip generation failed")
    return FileResponse(dest, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=86400"})


@router.get("/{asset_id}/thumbnail")
def get_thumbnail(asset_id: int, session: Session = Depends(get_session)):
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    thumb = thumbnail_path(asset_id)
    if not thumb.exists():
        # generate on demand if not yet ready
        if asset.asset_type == "video":
            generate_video_thumbnail(Path(asset.file_path), asset_id)
        elif asset.asset_type == "image":
            generate_image_thumbnail(Path(asset.file_path), asset_id)

    if not thumb.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not available")

    return FileResponse(thumb, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=86400"})


@router.get("/{asset_id}/file")
def get_asset_file(asset_id: int, proxy: bool = False, download: bool = False,
                   session: Session = Depends(get_session)):
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    path = Path(asset.file_path)
    # Serve the low-res proxy for preview when requested and available.
    if proxy and asset.proxy_path and Path(asset.proxy_path).exists():
        path = Path(asset.proxy_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")
    media_type, _ = mimetypes.guess_type(str(path))
    headers = {}
    if download:
        # download=true のときだけ添付扱いにする。既定はインライン(プレビュー再生用)。
        name = asset.name or path.name
        if not Path(name).suffix:
            name += path.suffix
        headers["Content-Disposition"] = f'attachment; filename="{name}"'
    return FileResponse(path, media_type=media_type or "application/octet-stream",
                        headers=headers)


@router.post("/{asset_id}/extract-clip", response_model=AssetRead, status_code=201)
def extract_clip(
    asset_id: int,
    background_tasks: BackgroundTasks,
    start_sec: float = 0.0,
    dur_sec: float = 5.0,
    end_sec: float | None = None,   # 指定時: 動画はこの時刻に表示中の源フレームまで「包含」で切る(フレーム厳密)
    pad_to_sec: float | None = None,  # 動画のみ: 出力がこれ未満なら最終フレームをフリーズして延長(H3参照の最小2秒対策)
    crop_aspect: float | None = None,  # 動画のみ: この比へ中央クロップ(H3は参照と出力のアスペクト一致で構図が安定)
    session: Session = Depends(get_session),
):
    """
    動画/音声アセットの区間[start_sec, start_sec+dur_sec)を切り出して新アセットに登録。
    H3 Ref2Vの参照動画・参照音声(歌唱セグメント等)に使う。
    フレーム精度のため再エンコード(-c copyはキーフレーム境界に丸まるため不可)。
    """
    import subprocess as sp
    import imageio_ffmpeg

    src_asset = session.get(Asset, asset_id)
    if not src_asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    src = Path(src_asset.file_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source file not found on disk")

    audio_exts = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aiff", ".aif"}
    is_audio = src_asset.asset_type == "audio" or src.suffix.lower() in audio_exts

    dest_dir = _asset_dir(src_asset.project_id)
    # 動画はプレビュー表示フレームへスナップ(音声はそのまま)
    t = max(0.0, start_sec) if is_audio else _snap_seek(src, max(0.0, start_sec))
    # end_sec指定時はフレーム厳密: [開始フレーム..終了フレーム]包含。
    # -t(秒指定)はB-frame並べ替えの影響で±1フレームぶれるため、
    # 動画は出力フレーム数を-frames:vで直接固定する。
    frames_cap: int | None = None
    if end_sec is not None and end_sec > start_sec:
        if is_audio:
            dur_sec = end_sec - start_sec
        else:
            info = _src_video_info(src)
            if info:
                fps, _ = info
                n0 = int(round(t * fps + 0.5))          # 先頭フレーム(スナップ済みtの直後)
                n_end = int(end_sec * fps + 1e-6)
                frames_cap = max(1, n_end - n0 + 1)
                dur_sec = (frames_cap + 2) / fps        # 読み込み範囲(余裕込み)。本命はframes_cap
            else:
                dur_sec = end_sec - start_sec
    ext = ".wav" if is_audio else ".mp4"
    dest = dest_dir / f"ref_{asset_id}_{int(t * 1000)}ms_{int(dur_sec * 1000)}ms{ext}"
    counter = 1
    while dest.exists():
        dest = dest_dir / f"ref_{asset_id}_{int(t * 1000)}ms_{int(dur_sec * 1000)}ms_{counter}{ext}"
        counter += 1

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    if is_audio:
        # 5msフェードで切り出し境界のクリックノイズを防ぐ(H3参照音声はセグメント端も条件になる)
        d = max(0.1, dur_sec)
        codec = ["-vn", "-af", f"afade=t=in:d=0.005,afade=t=out:st={d - 0.005:.3f}:d=0.005",
                 "-acodec", "pcm_s16le", "-ar", "44100"]
    else:
        codec = ["-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
                 "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
        # アスペクト合わせの中央クロップ(生成解像度と一致させると構図ドリフトが減る)
        vf_chain = []
        if crop_aspect and crop_aspect > 0:
            vf_chain.append(
                f"crop='if(gt(iw/ih,{crop_aspect}),ih*{crop_aspect},iw)':"
                f"'if(gt(iw/ih,{crop_aspect}),ih,iw/{crop_aspect})'")
        # 短い参照動画の自動延長: 最終フレームのフリーズで pad_to_sec まで伸ばす。
        # (H3の参照クリップは公式2〜15秒 — 2秒未満のカットをそのまま渡すと仕様割れになるため)
        if pad_to_sec and frames_cap is not None:
            info = _src_video_info(src)
            if info:
                fps_v = info[0]
                target_frames = int(pad_to_sec * fps_v + 0.999)
                if target_frames > frames_cap:
                    pad = (target_frames - frames_cap) / fps_v + 0.02
                    vf_chain.append(f"tpad=stop_mode=clone:stop_duration={pad:.3f}")
                    frames_cap = target_frames
        if vf_chain:
            codec = ["-vf", ",".join(vf_chain), *codec]
        if frames_cap is not None:
            codec = ["-frames:v", str(frames_cap), *codec]
    proc = sp.run(
        [ffmpeg, "-y", "-ss", f"{t:.3f}", "-t", f"{max(0.1, dur_sec):.3f}", "-i", str(src),
         *codec, str(dest)],
        capture_output=True,
    )
    if proc.returncode != 0 or not dest.exists():
        raise HTTPException(status_code=400, detail=f"Clip extraction failed: {proc.stderr.decode()[-300:]}")

    info = probe(dest)
    asset = Asset(
        project_id=src_asset.project_id,
        name=dest.name,
        asset_type="audio" if is_audio else "video",
        file_path=str(dest),
        duration_sec=info.duration_sec,
        width=info.width,
        height=info.height,
        file_size_bytes=info.file_size_bytes,
    )
    session.add(asset)
    session.commit()
    session.refresh(asset)
    background_tasks.add_task(_make_thumbnail, asset)
    # 注: Ref2V用の参照切り出し(ref_*)はプレビュー再生しないためプロキシ生成しない
    # (以前は全切り出しにプロキシジョブが走り、キューの雑音になっていた)
    return asset


@router.get("/{asset_id}/preview")
def get_preview_image(asset_id: int, long_edge: int = 640, session: Session = Depends(get_session)):
    """
    プレビュー合成用の縮小画像(JPEG)。フル解像度PNG(1MB級)をタイムラインの
    ピン100本規模で配るとロードが数分かかるため、軽量モードはこちらを使う。
    ディスクキャッシュ+1日Cache-Control。
    """
    import subprocess as sp
    import imageio_ffmpeg

    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    src = Path(asset.file_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")
    le = max(160, min(1280, long_edge))
    cache_dir = src.parent / ".preview"
    dest = cache_dir / f"{asset_id}_{le}.jpg"
    if not dest.exists() or dest.stat().st_mtime < src.stat().st_mtime:
        cache_dir.mkdir(exist_ok=True)
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        proc = sp.run(
            [ffmpeg, "-y", "-i", str(src),
             "-vf", f"scale='if(gte(iw,ih),{le},-2)':'if(gte(iw,ih),-2,{le})':flags=lanczos",
             "-frames:v", "1", "-q:v", "4", str(dest)],
            capture_output=True,
        )
        if proc.returncode != 0 or not dest.exists():
            raise HTTPException(status_code=400, detail="preview generation failed")
    return FileResponse(dest, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=86400"})


@router.get("/{asset_id}/peaks")
def get_peaks(asset_id: int, buckets: int = 2000, session: Session = Depends(get_session)):
    """
    波形ピーク(0..1のmax絶対値、buckets個)を返す。タイムラインの波形描画用。
    従来はブラウザが素材ファイル全体(数十MB)をDLしてデコードしていたのを、
    サーバ側ffmpegで計算した約8KBのJSONに置き換える。結果はディスクにキャッシュ。
    """
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    src = Path(asset.file_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")
    cache_dir = src.parent / ".peaks"
    cache = cache_dir / f"{asset_id}_{buckets}.json"
    cache_headers = {"Cache-Control": "public, max-age=86400"}
    if cache.exists() and cache.stat().st_mtime >= src.stat().st_mtime:
        return JSONResponse(json.loads(cache.read_text()), headers=cache_headers)

    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(src),
         "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0 or not proc.stdout:
        return {"peaks": []}   # 音声なし素材
    import numpy as np  # noqa: PLC0415
    data = np.abs(np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32)) / 32768.0
    n = max(1, len(data) // buckets)
    trimmed = data[: n * buckets].reshape(-1, n) if len(data) >= buckets else data.reshape(1, -1)
    peaks = trimmed.max(axis=1)
    result = {"peaks": [round(float(p), 4) for p in peaks]}
    cache_dir.mkdir(exist_ok=True)
    cache.write_text(json.dumps(result))
    return JSONResponse(result, headers=cache_headers)


@router.post("/{asset_id}/separate-vocals", status_code=202)
def separate_vocals(asset_id: int, session: Session = Depends(get_session)):
    """音楽アセットを歌唱/伴奏に分離(demucs)。完了で「(歌唱)」「(伴奏)」アセットが増える。"""
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    job = Job(
        project_id=asset.project_id, job_type="separate_vocals",
        params=json.dumps({"asset_id": asset.id, "project_id": asset.project_id}),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return {"job_id": job.id, "status": "queued"}


@router.post("/{asset_id}/proxy", status_code=202)
def make_proxy(asset_id: int, session: Session = Depends(get_session)):
    """Queue (or re-queue) low-res proxy generation for a video asset."""
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    job_id = _queue_proxy(session, asset)
    return {"job_id": job_id, "status": "queued"}


@router.get("/{asset_id}", response_model=AssetRead)
def get_asset(asset_id: int, session: Session = Depends(get_session)):
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


@router.delete("/{asset_id}", status_code=204)
def delete_asset(asset_id: int, session: Session = Depends(get_session)):
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    dest = Path(asset.file_path)
    if dest.exists():
        dest.unlink()
    thumb = thumbnail_path(asset_id)
    if thumb.exists():
        thumb.unlink()
    session.delete(asset)
    session.commit()


# ── 生成来歴からの再生成(要件7.4) ────────────────────────────────────────────

from pydantic import BaseModel as _BM


class RegenerateRequest(_BM):
    prompt_override: str | None = None
    seed: int | None = None          # None → 新しいシード(元seed+1000)


@router.post("/{asset_id}/regenerate", status_code=201)
def regenerate(asset_id: int, req: RegenerateRequest, session: Session = Depends(get_session)):
    """このアセットの生成条件(gen_params_json)を元に新しい生成ジョブを投入する。"""
    import json as _json
    from app.routers.generation import _create_job
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="asset not found")
    if not asset.gen_params_json:
        raise HTTPException(status_code=400, detail="このアセットには生成来歴がありません(手動アップロード等)")
    params = _json.loads(asset.gen_params_json)
    job_type = ("generate_audio" if "lyrics" in params
                else "generate_video_i2v" if params.get("model", "").startswith("wan")
                else "generate_image")
    if req.prompt_override:
        params["prompt"] = req.prompt_override
    params["seed"] = req.seed if req.seed is not None else int(params.get("seed", 0) or 0) + 1000
    params["project_id"] = asset.project_id
    params.setdefault("_lab", {})["regenerated_from"] = asset_id
    return _create_job(session, asset.project_id, job_type, params)


# ── 高品質切り抜き(マッティング+デフリンジ) ─────────────────────────────────

class CutoutRequest(_BM):
    model: str = "isnet-anime"      # isnet-anime(アニメ生成) / birefnet-general(写真・汎用)
    bg: str = "white"               # 生成時の背景色。写真は "none"
    feather: float = 1.0
    crop: bool = True


@router.post("/{asset_id}/cutout", status_code=201)
def cutout(asset_id: int, req: CutoutRequest, session: Session = Depends(get_session)):
    """画像アセット → 透過PNGアセット(新規登録)。lightレーンで数秒。"""
    from app.routers.generation import _create_job
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="asset not found")
    return _create_job(session, asset.project_id, "cutout", {
        "project_id": asset.project_id, "asset_id": asset_id,
        "model": req.model, "bg": req.bg, "feather": req.feather, "crop": req.crop,
    })


class InterpolateRequest(_BM):
    fps: int = 60


@router.post("/{asset_id}/interpolate", status_code=201)
def interpolate(asset_id: int, req: InterpolateRequest, session: Session = Depends(get_session)):
    """低fps生成動画→高fps補間(minterpolate)。webmは透過保持。"""
    from app.routers.generation import _create_job
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="asset not found")
    return _create_job(session, asset.project_id, "interpolate", {
        "project_id": asset.project_id, "asset_id": asset_id, "fps": req.fps,
    })


class VlmReviewRequest(_BM):
    frames: int = 12


@router.post("/{asset_id}/vlm-review", status_code=201)
def vlm_review(asset_id: int, req: VlmReviewRequest, session: Session = Depends(get_session)):
    """レンダー動画をローカルVLMで意味QA(可読性/寂しさ/破綻)→コメント自動起票。"""
    from app.routers.generation import _create_job
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="asset not found")
    return _create_job(session, asset.project_id, "vlm_review", {
        "project_id": asset.project_id, "asset_id": asset_id, "frames": req.frames,
    })


@router.get("/library/search")
def library_search(q: str = "", kind: str = "", limit: int = 60,
                   session: Session = Depends(get_session)):
    """プロジェクト横断の素材検索。q=名前/来歴の部分一致、kind=cutout|interpolate|generated等。
    切り抜き済み・補間済み素材を別プロジェクトから再利用するための土台。"""
    from sqlmodel import select as _select
    rows = session.exec(_select(Asset).order_by(Asset.id.desc())).all()
    out = []
    for a in rows:
        gp = a.gen_params_json or ""
        if kind:
            src_kind = ""
            try:
                import json as _j
                src_kind = "cutout" if "src_asset_id" in gp and "model" in gp else ""
                d = _j.loads(gp) if gp else {}
                if d.get("method") == "minterpolate":
                    src_kind = "interpolate"
            except Exception:
                pass
            if kind not in (src_kind, a.asset_type or ""):
                continue
        if q and q.lower() not in (a.name or "").lower() and q.lower() not in gp.lower():
            continue
        out.append({"id": a.id, "project_id": a.project_id, "name": a.name,
                    "asset_type": a.asset_type, "width": a.width, "height": a.height,
                    "duration_sec": a.duration_sec})
        if len(out) >= limit:
            break
    return {"items": out}


@router.get("/{asset_id}/motion-series")
def get_motion_series(asset_id: int, session: Session = Depends(get_session)):
    """フレーム間差分(輝度)の時系列 — カット/画面全体の動き量の数値化。
    tblend=difference + signalstats.YAVG を160px縮小で計測(1本1〜2秒, キャッシュ)。
    差分再生モードのグラフ・音ハメ加速の指標検証用。"""
    import re
    import subprocess
    import imageio_ffmpeg

    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    if asset.asset_type not in ("video", "generated"):
        raise HTTPException(status_code=400, detail="video assets only")
    src = Path(asset.file_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source not found")

    dest_dir = FILMSTRIP_DIR / str(asset.project_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    cache = dest_dir / f"{asset_id}_motion.json"
    if cache.exists():
        return json.loads(cache.read_text())

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    proc = subprocess.run(
        [ffmpeg, "-i", str(src),
         "-vf", "scale=160:-2,tblend=all_mode=difference,signalstats,"
                "metadata=print:key=lavfi.signalstats.YAVG:file=-",
         "-f", "null", "-"],
        capture_output=True, text=True, timeout=300)
    vals = [round(float(m), 4) for m in
            re.findall(r"YAVG=([\d.]+)", proc.stdout or "")]
    if not vals:
        raise HTTPException(status_code=400, detail="motion extraction failed")
    # フレームレート実測(値数/長さ)
    fps = round(len(vals) / max(0.1, asset.duration_sec or 1), 3)
    # カット検出: 中央値の6倍超のスパイク
    import statistics
    med = statistics.median(vals) or 0.01
    cuts = [round(i / fps, 3) for i, v in enumerate(vals) if v > med * 6 and v > 2.0]
    data = {"fps": fps, "values": vals, "median": round(med, 4), "cuts": cuts,
            "duration_sec": asset.duration_sec}
    cache.write_text(json.dumps(data))
    return data


# ── 🗂 テイク紐付けの追従 ─────────────────────────────────────────────────────
# テイク(生成アセット)は gen_params.place.start_frame でカットに紐付く。
# カット割りのピンを動かすと開始フレームがずれ、テイク履歴から消えてしまうため、
# ピン編集のたびにこのエンドポイントで「現在のカット開始」へ寄せ直す。
# 生成時の位置は place.orig_start_frame に一度だけ退避し、来歴は失わない。
class RemapTakes(_BM):
    project_id: int
    starts: list[int]        # 現在のカット開始フレーム(昇順)
    tolerance: int = 24      # この範囲内のズレだけ寄せる(別カットへの誤吸着を防ぐ)


@router.post("/remap-takes")
def remap_takes(body: RemapTakes, session: Session = Depends(get_session)):
    if not body.starts:
        return {"updated": 0, "detail": []}
    starts = sorted(body.starts)
    rows = session.exec(select(Asset).where(Asset.project_id == body.project_id)).all()
    updated, detail = 0, []
    for a in rows:
        if not a.gen_params_json:
            continue
        try:
            p = json.loads(a.gen_params_json)
        except Exception:
            continue
        place = p.get("place")
        if not isinstance(place, dict) or not isinstance(place.get("start_frame"), int):
            continue
        cur = place["start_frame"]
        if cur in starts:
            continue
        near = min(starts, key=lambda s: abs(s - cur))
        # 許容幅は「隣のカット開始までの距離の半分」を超えない。
        # 0.3秒カットが連続する箇所(C11/C12, C39/C40 等)で固定24フレームの許容を
        # 使うと、隣のカットへ取り違えて紐付けてしまうため。
        i = starts.index(near)
        gap = min([abs(near - starts[j]) for j in (i - 1, i + 1) if 0 <= j < len(starts)] or [10 ** 9])
        limit = min(body.tolerance, max(1, gap // 2))
        if abs(near - cur) > limit:
            continue          # 遠いものは触らない(消えたカットのテイクは孤立のまま残す)
        place.setdefault("orig_start_frame", cur)
        place["start_frame"] = near
        p["place"] = place
        a.gen_params_json = json.dumps(p, ensure_ascii=False)
        session.add(a)
        updated += 1
        detail.append({"asset": a.id, "from": cur, "to": near})
    if updated:
        session.commit()
    return {"updated": updated, "detail": detail[:50]}
