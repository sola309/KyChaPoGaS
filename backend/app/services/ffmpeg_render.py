"""
FFmpeg render service.

Phase 3 MVP scope:
  - Primary video track (first 'video' track): clips concatenated with black gaps
  - Primary audio track (first 'audio' track): mixed in
  - Resolution / FPS from project settings (overridable)
  - Output: H.264 MP4

Approach: temp-segment concat (avoids complex filter_complex for first pass)
  1. Extract each clip to a re-encoded temp segment (ensures uniform codec/fps)
  2. Fill gaps with generated black frames
  3. Concatenate via FFmpeg concat demuxer
  4. Mix audio track if present
"""

import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Optional

import imageio_ffmpeg

# The bundled (imageio) ffmpeg is a minimal static build WITHOUT NVENC. The system
# ffmpeg (if present) on this box is a full build WITH h264_nvenc — used for GPU
# encoding when the encoder is set to nvenc/auto.
_BUNDLED_FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
_SYSTEM_FFMPEG = shutil.which("ffmpeg")
FFMPEG = _BUNDLED_FFMPEG          # active binary (swapped by configure_encoder)
EXPORTS_DIR = Path(__file__).parent.parent.parent / "data" / "exports"


def _exports_path(project_id: int, job_id: int) -> Path:
    p = EXPORTS_DIR / str(project_id)
    p.mkdir(parents=True, exist_ok=True)
    return p / f"{job_id}.mp4"


async def _run(cmd: list[str], progress_cb=None) -> str:
    """Run an ffmpeg command, stream stderr, call progress_cb(pct: float)."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stderr_lines = []
    duration_sec: Optional[float] = None

    async def read_stderr():
        nonlocal duration_sec
        async for raw in proc.stderr:
            line = raw.decode(errors="replace").strip()
            stderr_lines.append(line)
            # Parse total duration once
            if "Duration:" in line and duration_sec is None:
                try:
                    t = line.split("Duration:")[1].split(",")[0].strip()
                    h, m, s = t.split(":")
                    duration_sec = int(h) * 3600 + int(m) * 60 + float(s)
                except Exception:
                    pass
            # Parse progress
            if progress_cb and "time=" in line and duration_sec:
                try:
                    t = line.split("time=")[1].split(" ")[0].strip()
                    h, m, s = t.split(":")
                    elapsed = int(h) * 3600 + int(m) * 60 + float(s)
                    pct = min(0.99, elapsed / duration_sec)
                    progress_cb(pct)
                except Exception:
                    pass

    await read_stderr()
    await proc.wait()

    if proc.returncode != 0:
        raise RuntimeError(
            f"FFmpeg failed (exit {proc.returncode}):\n" + "\n".join(stderr_lines[-20:])
        )
    return "\n".join(stderr_lines)


# Cubic-bezier easing presets (P0=(0,0), P3=(1,1)) for accel/decel speed ramps.
_EASE: dict[str, tuple[float, float, float, float]] = {
    "in":    (0.42, 0.0, 1.0,  1.0),   # slow start → accelerate
    "out":   (0.0,  0.0, 0.58, 1.0),   # fast start → decelerate
    "inout": (0.42, 0.0, 0.58, 1.0),   # ease in and out
}


def _ease_points(ease: str) -> tuple[float, float, float, float] | None:
    """Resolve an ease spec to bezier control points.

    Accepts preset names ('in'/'out'/'inout') or a custom curve from the graph
    editor: 'cubic:x1,y1,x2,y2' (P0=(0,0), P3=(1,1); x,y clamped to [0,1] so
    source time stays monotonic). Returns None for linear/unknown.
    """
    if ease in _EASE:
        return _EASE[ease]
    if ease.startswith("cubic:"):
        try:
            x1, y1, x2, y2 = (float(v) for v in ease[6:].split(","))
        except (ValueError, TypeError):
            return None
        clamp = lambda v: min(1.0, max(0.0, v))  # noqa: E731
        return clamp(x1), clamp(y1), clamp(x2), clamp(y2)
    return None


def _cubic_bezier_y_at_x(x: float, x1: float, y1: float, x2: float, y2: float, iters: int = 20) -> float:
    """Source-progress (y) for output-progress (x) on a cubic bezier easing curve."""
    def bx(t: float) -> float:
        mt = 1 - t
        return 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t

    def by(t: float) -> float:
        mt = 1 - t
        return 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t

    lo, hi = 0.0, 1.0
    for _ in range(iters):
        mid = (lo + hi) / 2
        if bx(mid) < x:
            lo = mid
        else:
            hi = mid
    return by((lo + hi) / 2)


@lru_cache(maxsize=512)
def _has_alpha(path: str) -> bool:
    """素材が透過を持つか(pix_fmtにアルファがあるか)。判定できなければ False。

    透過素材は全画面テロップ/FXとして contain で重ねる。不透明素材は cover で
    埋めないと、縦横比のわずかな差が端の隙間になって下のトラックが覗く。
    """
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=15)
        pix = (r.stdout or "").strip().lower()
    except Exception:
        return False
    return any(k in pix for k in ("rgba", "bgra", "argb", "abgr", "yuva", "ya8", "ya16", "pal8"))


@lru_cache(maxsize=512)
def _src_fps(path: str) -> float:
    """素材の実fps。プレビューと同じ『その時刻を含むフレーム』を選ぶために要る。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=20).stdout.strip()
        num, _, den = out.partition("/")
        return float(num) / float(den or 1)
    except Exception:
        return 0.0


def _scale_pad_fps(w: int, h: int, fps: float, alpha: bool = False,
                   fit: str = "contain", fps_start: float = 0.0) -> str:
    fmt = ",format=rgba" if alpha else ""
    # lanczos = sharper up/down-scaling than the default (bicubic), which matters
    # for crisp footage/MG and avoids the "soft" look on rescale.
    if fit == "cover":
        # fill the frame (crop overflow) — matches the preview compositor's
        # cover-fit, so a transformed LAYER lines up with what you see.
        body = (f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={w}:{h}")
    else:
        pad_color = ":color=black@0" if alpha else ""
        body = (f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2{pad_color}")
    # round=up: 出力時刻に対して「その時刻を含む(=以前の)素材フレーム」を選ぶ。
    # プレビュー(video.currentTime が指すフレーム)と同じ規則になる。
    # start_time: -ss を素材フレーム境界へ丸めた分の位相を戻す。
    st = f":start_time={fps_start:.6f}" if fps_start > 1e-9 else ""
    return f"{body},fps={fps}:round=up{st}{fmt}"


# Video encoder args. The timeline is assembled by re-encoding each clip into temp
# segments and re-encoding again at concat/overlay — so EVERY pass must be near
# visually-lossless or the loss compounds. Two backends:
#   x264  — crf 16 + medium + high profile ≈ visually lossless (CPU, smaller files)
#   nvenc — GPU h264_nvenc, cq 19 + p6/hq + AQ (faster on long passes, bigger files)
_X264_ARGS = ["-c:v", "libx264", "-crf", "16", "-preset", "medium",
              "-profile:v", "high", "-pix_fmt", "yuv420p"]   # 4:2:0 (high profile rejects 4:4:4)
# Same crf (= same visual quality) but a faster preset: ~2× quicker, slightly larger
# files. crf controls quality, preset controls compression efficiency/speed — so this
# is the cheapest real speedup with no quality loss. Best default for this pipeline
# (many short ffmpeg passes make NVENC's per-process GPU overhead a net loss).
_X264_FAST_ARGS = ["-c:v", "libx264", "-crf", "16", "-preset", "veryfast",
                   "-profile:v", "high", "-pix_fmt", "yuv420p"]
_NVENC_ARGS = ["-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq",
               "-rc", "vbr", "-cq", "19", "-b:v", "0",
               "-spatial-aq", "1", "-temporal-aq", "1",
               "-profile:v", "high", "-pix_fmt", "yuv420p"]
_VENC = _X264_ARGS          # active encoder args (swapped by configure_encoder)
_X264 = _VENC               # back-compat alias used by older call sites
# alpha output uses QuickTime RLE in .mov (NVENC/x264 have no alpha)
_QTRLE = ["-c:v", "qtrle"]

_NVENC_OK: Optional[bool] = None   # cached probe result


def _nvenc_available() -> bool:
    """True if the system ffmpeg has a WORKING h264_nvenc (probe-encodes once)."""
    if not _SYSTEM_FFMPEG:
        return False
    try:
        enc = subprocess.run([_SYSTEM_FFMPEG, "-hide_banner", "-encoders"],
                             capture_output=True, text=True, timeout=10).stdout
        if "h264_nvenc" not in enc:
            return False
        r = subprocess.run([_SYSTEM_FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
                            "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.1",
                            "-c:v", "h264_nvenc", "-f", "null", "-"],
                           capture_output=True, timeout=20)
        return r.returncode == 0
    except Exception:
        return False


def configure_encoder(mode: str = "auto") -> str:
    """Select the encoder for this render. Sets the module's FFMPEG binary + _VENC
    args (helpers read these at call time). Returns the chosen backend.
      auto       — fast x264 (best for this many-pass pipeline; benchmarked fastest)
      x264_fast  — libx264 crf16 veryfast (same quality, ~2× faster, slightly larger)
      x264       — libx264 crf16 medium (smallest files, slowest)
      nvenc      — GPU h264_nvenc (only wins on few long clips / 4K; system ffmpeg)
    """
    global FFMPEG, _VENC, _X264, _NVENC_OK
    if mode == "nvenc":
        if _NVENC_OK is None:
            _NVENC_OK = _nvenc_available()
        if _NVENC_OK:
            FFMPEG, _VENC, _X264 = _SYSTEM_FFMPEG, _NVENC_ARGS, _NVENC_ARGS
            return "nvenc"
        mode = "x264_fast"   # requested nvenc but unavailable → fall back
    if mode == "x264":
        FFMPEG, _VENC = _BUNDLED_FFMPEG, _X264_ARGS
        _X264 = _VENC
        return "x264"
    # auto / x264_fast / anything else → fast x264
    FFMPEG, _VENC = _BUNDLED_FFMPEG, _X264_FAST_ARGS
    _X264 = _VENC
    return "x264_fast"


def parse_remap(raw: str, dur_frames: int, asset_in_frame: int) -> list[dict] | None:
    """remap_json → 完全なキー列(暗黙の端点を補ったもの)。無効/空なら None。

    返り値: [{"t": 出力フレーム, "src": 素材フレーム, "hold": fps}] 昇順・2点以上。
    先頭キーが t>0 なら {t:0, src:asset_in_frame} を暗黙追加。
    最終キーが t<dur なら等速(1x)で末尾まで継続する暗黙キーを追加。
    """
    if not raw or not raw.strip():
        return None
    try:
        keys = json.loads(raw).get("keys") or []
    except Exception:
        return None
    ks = sorted(
        ({"t": int(k["t"]), "src": float(k["src"]), "hold": float(k.get("hold") or 0)}
         for k in keys if isinstance(k, dict) and "t" in k and "src" in k),
        key=lambda k: k["t"])
    # 同一tは後勝ちで潰す(線形補間の分母0を防ぐ)
    dedup: list[dict] = []
    for k in ks:
        if dedup and dedup[-1]["t"] == k["t"]:
            dedup[-1] = k
        else:
            dedup.append(k)
    ks = [k for k in dedup if 0 <= k["t"] <= dur_frames]
    if not ks:
        return None
    if ks[0]["t"] > 0:
        ks.insert(0, {"t": 0, "src": float(asset_in_frame), "hold": 0})
    last = ks[-1]
    if last["t"] < dur_frames:
        ks.append({"t": dur_frames, "src": last["src"] + (dur_frames - last["t"]),
                   "hold": last["hold"]})
    return ks if len(ks) >= 2 else None


async def _extract_remap_segment(src: str, out: Path, keys: list[dict],
                                 dur_sec: float, w: int, h: int, fps: float,
                                 fit: str = "contain", keep_alpha: bool = False) -> None:
    """キー列(parse_remap済み)に従い、区分ごとの等速リマップで切り出して連結する。

    各区間: 出力尺 = Δt/fps、消費ソース = Δsrc/fps、速度 = Δsrc/Δt。
    Δsrc=0 はフリーズ(1フレームを tpad で伸ばす)。hold はその区間のコマ打ち。
    """
    vf = _scale_pad_fps(w, h, fps, alpha=keep_alpha, fit=fit)
    enc = _QTRLE if keep_alpha else _X264
    parts: list[Path] = []
    for i in range(len(keys) - 1):
        k0, k1 = keys[i], keys[i + 1]
        seg_out = max(1.0 / fps, (k1["t"] - k0["t"]) / fps)
        seg_src = max(0.0, (k1["src"] - k0["src"]) / fps)
        hold_fps = float(k0.get("hold") or 0)
        hold = (f"fps={hold_fps:g}," if 0.5 < hold_fps < fps else "")
        part = out.parent / (f"{out.stem}_rm{i:02d}.mov" if keep_alpha else f"{out.stem}_rm{i:02d}.mp4")
        if seg_src < 0.5 / fps:
            # フリーズ区間: 開始位置の1フレームを尺いっぱいに伸ばす
            cmd = [FFMPEG, "-y",
                   "-ss", f"{k0['src'] / fps:.6f}", "-i", src,
                   "-vf", f"{vf},tpad=stop_mode=clone:stop_duration={seg_out:.6f}",
                   "-t", f"{seg_out:.6f}", *enc, "-an", str(part)]
        else:
            seg_speed = max(0.05, seg_src / seg_out)
            cmd = [FFMPEG, "-y",
                   "-ss", f"{k0['src'] / fps:.6f}", "-t", f"{seg_src:.6f}", "-i", src,
                   "-vf", (f"setpts=PTS/{seg_speed:.6f},{hold}{vf},"
                           f"tpad=stop_mode=clone:stop_duration={seg_out:.6f}"),
                   "-t", f"{seg_out:.6f}", *enc, "-an", str(part)]
        await _run(cmd)
        parts.append(part)
    joined = out.parent / (f"{out.stem}_rmj.mov" if keep_alpha else f"{out.stem}_rmj.mp4")
    await _concat(parts, joined)
    cmd = [FFMPEG, "-y", "-i", str(joined),
           "-vf", f"tpad=stop_mode=clone:stop_duration={dur_sec:.6f}",
           "-t", f"{dur_sec:.6f}", *(_QTRLE if keep_alpha else _VENC), "-an", str(out)]
    await _run(cmd)
    joined.unlink(missing_ok=True)
    for pt in parts:
        pt.unlink(missing_ok=True)


async def _extract_segment(src: str, out: Path, in_sec: float,
                           dur_sec: float, w: int, h: int, fps: float,
                           speed: float = 1.0, ease: str = "linear",
                           keep_alpha: bool = False, fit: str = "contain",
                           hold_fps: float = 0) -> None:
    """
    Extract a clip segment to uniform resolution/fps, applying a speed remap.

    dur_sec is the OUTPUT (timeline) duration; the segment consumes
    ``dur_sec * speed`` seconds of source. ease shapes accel/decel (bezier).
    keep_alpha preserves transparency (overlay clips; qtrle .mov, linear only).
    fit='cover' fills the frame (for transformed layers); 'contain' letterboxes.
    """
    speed = max(0.05, float(speed))
    source_span = dur_sec * speed
    vf = _scale_pad_fps(w, h, fps, alpha=keep_alpha, fit=fit)
    # コマ打ち: 速度リマップ後(出力タイムベース)でフレームを間引き、後段のfps正規化で
    # 複製される→「2コマ/3コマ打ち」のホールド感になる。
    hold = f"fps={float(hold_fps):g}," if hold_fps and float(hold_fps) > 0.5 and float(hold_fps) < fps else ""

    # Constant speed (linear) — single pass with setpts.
    # Clips shorter than ~0.5s also render linear: piecewise easing would
    # produce sub-frame parts (0-stream files), and a ramp that brief is
    # imperceptible anyway. Alpha output is linear-only.
    # 速度エンベロープ("curve:r1,..,rN" — 出力位置ごとの相対速度、平均1想定)。
    # 実速度 = speed * r_k。尺・速度はフロントで平均から計算済みなので、ここでは
    # 区分ごとにソース消費を r_k に比例配分するだけでよい。
    if ease and ease.startswith("curve:") and not keep_alpha and dur_sec * fps >= 16:
        try:
            rel = [max(0.05, float(x)) for x in ease[6:].split(";")[0].split(",") if x.strip()]
        except ValueError:
            rel = []
        if len(rel) >= 2:
            K = len(rel)
            m = sum(rel) / K
            rel = [r / m for r in rel]          # 正規化(消費合計=source_span厳守)
            parts: list[Path] = []
            src_cursor = in_sec
            for k in range(K):
                seg_out = dur_sec / K
                seg_src_dur = max(1e-3, seg_out * speed * rel[k])
                seg_speed = max(0.05, seg_src_dur / seg_out)
                part = out.parent / f"{out.stem}_v{k:02d}.mp4"
                cmd = [
                    FFMPEG, "-y",
                    "-ss", f"{src_cursor:.6f}", "-t", f"{seg_src_dur:.6f}", "-i", src,
                    "-vf", (f"setpts=PTS/{seg_speed:.6f},{hold}{vf},"
                            f"tpad=stop_mode=clone:stop_duration={seg_out:.6f}"),
                    "-t", f"{seg_out:.6f}",
                    *_VENC,
                    "-an",
                    str(part),
                ]
                await _run(cmd)
                parts.append(part)
                src_cursor += seg_src_dur
            joined = out.parent / f"{out.stem}_joined.mp4"
            await _concat(parts, joined)
            cmd = [
                FFMPEG, "-y",
                "-i", str(joined),
                "-vf", f"tpad=stop_mode=clone:stop_duration={dur_sec:.6f}",
                "-t", f"{dur_sec:.6f}",
                *_VENC,
                "-an",
                str(out),
            ]
            await _run(cmd)
            joined.unlink(missing_ok=True)
            for pt in parts:
                pt.unlink(missing_ok=True)
            return

    pts = _ease_points(ease)
    if dur_sec * fps < 16 or keep_alpha:
        pts = None
    if pts is None:
        # 出力の尺はフレーム数で確定させる。-t(秒)任せだと、素材fpsで割り切れない
        # 尺(例: 83f=2.7667秒 は 24fps素材の66.4コマ)のときに1フレーム多く出て、
        # 連結するほどカット位置がタイムラインから後ろへずれていく(音ズレの原因)。
        # 開始位置(-ss)は一切変えない — ここを動かすと絵が別のフレームになる。
        n_out = max(1, int(round(dur_sec * fps)))
        # 開始位置は「その時刻を含む素材フレームの先頭」へ丸める。
        # -ss に生の秒を渡すと、ffmpeg は PTS>=指定時刻 の次フレームを掴むため、
        # プレビュー(その時刻を含むフレームを表示)より1コマ先の絵で始まってしまう。
        sfps = _src_fps(src)
        ss = (int(in_sec * sfps + 1e-6) / sfps) if sfps > 0 else in_sec
        vf = _scale_pad_fps(w, h, fps, alpha=keep_alpha, fit=fit, fps_start=in_sec - ss)
        cmd = [
            FFMPEG, "-y",
            "-ss", f"{ss:.6f}", "-t", f"{source_span + 2.0 / fps:.6f}", "-i", src,
            "-vf", (f"setpts=PTS/{speed:.6f},{hold}{vf},"
                    f"tpad=stop_mode=clone:stop_duration={2.0 / fps:.6f}"),
            "-frames:v", str(n_out),
            *(_QTRLE if keep_alpha else _X264),
            "-an",
            str(out),
        ]
        await _run(cmd)
        return

    # Variable speed (accel/decel) — piecewise-constant approximation of the
    # bezier speed ramp: split into K sub-segments, each at its own setpts.
    # Each part is clamped to EXACTLY its share of the output duration
    # (tpad-clone + output-side -t): with extreme curves a near-zero source
    # span quantizes to 1 frame and a slow setpts would otherwise inflate it.
    x1, y1, x2, y2 = pts
    # Each piece must be several frames long or quantization dominates.
    K = min(12, max(2, int(dur_sec * fps / 4)))
    parts: list[Path] = []
    for k in range(K):
        u0, u1 = k / K, (k + 1) / K
        sp0 = _cubic_bezier_y_at_x(u0, x1, y1, x2, y2)
        sp1 = _cubic_bezier_y_at_x(u1, x1, y1, x2, y2)
        seg_out = (u1 - u0) * dur_sec
        seg_src_in = in_sec + sp0 * source_span
        seg_src_dur = max(1e-3, (sp1 - sp0) * source_span)
        seg_speed = max(0.05, seg_src_dur / seg_out)
        part = out.parent / f"{out.stem}_e{k:02d}.mp4"
        cmd = [
            FFMPEG, "-y",
            "-ss", f"{seg_src_in:.6f}", "-t", f"{seg_src_dur:.6f}", "-i", src,
            "-vf", (f"setpts=PTS/{seg_speed:.6f},{hold}{vf},"
                    f"tpad=stop_mode=clone:stop_duration={seg_out:.6f}"),
            "-t", f"{seg_out:.6f}",
            *_VENC,
            "-an",
            str(part),
        ]
        await _run(cmd)
        parts.append(part)
    # Concat the parts, then clamp the WHOLE clip to exactly dur_sec —
    # per-part ±1-frame quantization would otherwise accumulate and shift
    # everything after this clip off the beat grid.
    joined = out.parent / f"{out.stem}_joined.mp4"
    await _concat(parts, joined)
    cmd = [
        FFMPEG, "-y",
        "-i", str(joined),
        "-vf", f"tpad=stop_mode=clone:stop_duration={dur_sec:.6f}",
        "-t", f"{dur_sec:.6f}",
        *_VENC,
        "-an",
        str(out),
    ]
    await _run(cmd)
    joined.unlink(missing_ok=True)
    for p in parts:
        p.unlink(missing_ok=True)


# xfade transition names for clip.transition_in values
_XFADE: dict[str, str] = {
    "cross": "fade",        # crossfade
    "white": "fadewhite",   # flash to white
    "black": "fadeblack",   # dip to black
}


async def _xfade_merge(a: Path, b: Path, out: Path, transition: str,
                       d_sec: float, a_dur: float) -> None:
    """
    Merge two pre-encoded segments with a duration-preserving transition.

    The first segment is freeze-extended (clone last frame) by the transition
    duration, then xfade consumes exactly that extension — so the merged length
    is a_dur + b_dur and the timeline (music sync) never shifts.
    """
    trans = _XFADE.get(transition, "fade")
    fc = (f"[0:v]tpad=stop_mode=clone:stop_duration={d_sec:.6f}[a];"
          f"[a][1:v]xfade=transition={trans}:duration={d_sec:.6f}:offset={a_dur:.6f}[v]")
    cmd = [
        FFMPEG, "-y",
        "-i", str(a), "-i", str(b),
        "-filter_complex", fc,
        "-map", "[v]",
        *_VENC,
        "-an",
        str(out),
    ]
    await _run(cmd)


async def _image_segment(src: str, out: Path, dur_sec: float,
                         w: int, h: int, fps: float,
                         keep_alpha: bool = False, fit: str = "contain") -> None:
    """Render a still image as a video segment of the given duration.
    (-ss/-t extraction on an image input yields a single frame, so stills
    need -loop 1 instead.)"""
    cmd = [
        FFMPEG, "-y",
        "-loop", "1", "-framerate", str(fps), "-t", f"{dur_sec:.6f}",
        "-i", src,
        "-vf", _scale_pad_fps(w, h, fps, alpha=keep_alpha, fit=fit),
        *(_QTRLE if keep_alpha else [*_X264, "-pix_fmt", "yuv420p"]),
        "-an",
        str(out),
    ]
    await _run(cmd)


async def _black_segment(out: Path, dur_sec: float, w: int, h: int, fps: float) -> None:
    """Generate a black-frame segment."""
    cmd = [
        FFMPEG, "-y",
        "-f", "lavfi",
        "-i", f"color=black:s={w}x{h}:r={fps}:d={dur_sec}",
        *_VENC,
        str(out),
    ]
    await _run(cmd)


async def _concat(segment_files: list[Path], out: Path, progress_cb=None) -> None:
    """
    Concatenate pre-encoded segments via the FFmpeg concat demuxer.

    Re-encodes instead of stream-copying: xfade-merged segments and plain
    segments have slightly different timestamp layouts, and `-c copy` drops
    packets at those boundaries (video ends early / non-monotonic DTS).
    """
    list_file = out.parent / f"{out.stem}_concat.txt"
    with open(list_file, "w", encoding="utf-8") as f:
        for seg in segment_files:
            # FFmpeg requires forward slashes in concat lists
            f.write(f"file '{seg.as_posix()}'\n")
    cmd = [
        FFMPEG, "-y",
        "-f", "concat", "-safe", "0",
        "-i", str(list_file),
        "-fps_mode", "cfr",
        *_VENC,
        "-an",
        str(out),
    ]
    await _run(cmd, progress_cb)
    list_file.unlink(missing_ok=True)


# ── Transform (zoom / pan / shake — 静止画MADの核) ────────────────────────────

# Presets resolve to keyframes: t = 0..1 over the clip,
# scale ≥ 1, x/y = pan as fraction of the frame (-0.5..0.5), shake = px amplitude.
# Musical default eases match frontend Preview/transformEval.PRESETS.
_TRANSFORM_PRESETS: dict[str, dict] = {
    "kenburns_in":  {"keyframes": [{"t": 0, "scale": 1.0}, {"t": 1, "scale": 1.18, "ease": "sineInOut"}]},
    "kenburns_out": {"keyframes": [{"t": 0, "scale": 1.18}, {"t": 1, "scale": 1.0, "ease": "sineInOut"}]},
    "punch_in":     {"keyframes": [{"t": 0, "scale": 1.28}, {"t": 0.22, "scale": 1.0, "ease": "expoOut"}]},
    "punch_out":    {"keyframes": [{"t": 0, "scale": 1.0}, {"t": 0.18, "scale": 1.25, "ease": "backOut"},
                                    {"t": 1, "scale": 1.0, "ease": "power2Out"}]},
    "pan_lr":       {"keyframes": [{"t": 0, "scale": 1.15, "x": -0.06},
                                    {"t": 1, "scale": 1.15, "x": 0.06, "ease": "power2InOut"}]},
    "pan_rl":       {"keyframes": [{"t": 0, "scale": 1.15, "x": 0.06},
                                    {"t": 1, "scale": 1.15, "x": -0.06, "ease": "power2InOut"}]},
    "shake":        {"keyframes": [{"t": 0, "scale": 1.08}, {"t": 1, "scale": 1.08}],
                     "shake": {"amp": 14, "decay": 1.0}},
}


def _piecewise_expr(points: list[tuple[float, float]], var: str = "on") -> str:
    """Build an ffmpeg piecewise-linear expression over output frame `var`.
    points = [(frame, value), ...] sorted by frame."""
    if len(points) == 1:
        return f"{points[0][1]:.6f}"
    expr = f"{points[-1][1]:.6f}"
    for (f0, v0), (f1, v1) in reversed(list(zip(points, points[1:]))):
        span = max(1e-6, f1 - f0)
        seg = f"({v0:.6f}+({v1:.6f}-{v0:.6f})*({var}-{f0:.3f})/{span:.3f})"
        expr = f"if(lt({var},{f1:.3f}),{seg},{expr})"
    first = f"{points[0][1]:.6f}"
    return f"if(lt({var},{points[0][0]:.3f}),{first},{expr})"


_TPROPS = ("scale", "x", "y", "rotation", "opacity")


def _normalize_transform(data: dict | None) -> dict | None:
    """Resolve a transform dict to a uniform {keyframes, base, shake, anchor} form.

    A property without any keyframe falls back to its static `base` value (or the
    property default) — mirrors the frontend transformEval.sampleProp().
    """
    if not isinstance(data, dict):
        return None
    kfs = data.get("keyframes") or []
    base = {k: float(data[k]) for k in _TPROPS if isinstance(data.get(k), (int, float))}
    if not kfs and not base and not data.get("shake"):
        return None
    if not kfs and base:                       # static base only → one constant kf
        kfs = [dict(t=0.0, **base)]
    out: dict = {"keyframes": kfs, "base": base}
    if data.get("shake"):
        out["shake"] = data["shake"]
    if isinstance(data.get("anchor"), (list, tuple)):
        out["anchor"] = list(data["anchor"])
    return out


# ── Easing (mirror of frontend Preview/easing.ts) ───────────────────────────
# An eased segment is SAMPLED into many linear sub-points so ffmpeg's piecewise-
# linear expressions follow the curve — same formulas as the preview → match.
import math as _math

_c1 = 1.70158
_c3 = _c1 + 1
_c4 = (2 * _math.pi) / 3
_c5 = (2 * _math.pi) / 4.5


def _bounce_out(p: float) -> float:
    n1, d1 = 7.5625, 2.75
    if p < 1 / d1:
        return n1 * p * p
    if p < 2 / d1:
        p -= 1.5 / d1; return n1 * p * p + 0.75
    if p < 2.5 / d1:
        p -= 2.25 / d1; return n1 * p * p + 0.9375
    p -= 2.625 / d1; return n1 * p * p + 0.984375


_EASES = {
    "linear": lambda p: p,
    "sineIn": lambda p: 1 - _math.cos((p * _math.pi) / 2),
    "sineOut": lambda p: _math.sin((p * _math.pi) / 2),
    "sineInOut": lambda p: -(_math.cos(_math.pi * p) - 1) / 2,
    "power2In": lambda p: p * p,
    "power2Out": lambda p: 1 - (1 - p) ** 2,
    "power2InOut": lambda p: 2 * p * p if p < 0.5 else 1 - ((-2 * p + 2) ** 2) / 2,
    "power3In": lambda p: p ** 3,
    "power3Out": lambda p: 1 - (1 - p) ** 3,
    "power3InOut": lambda p: 4 * p ** 3 if p < 0.5 else 1 - ((-2 * p + 2) ** 3) / 2,
    "expoIn": lambda p: 0.0 if p == 0 else 2 ** (10 * p - 10),
    "expoOut": lambda p: 1.0 if p == 1 else 1 - 2 ** (-10 * p),
    "expoInOut": lambda p: 0.0 if p == 0 else 1.0 if p == 1 else
        (2 ** (20 * p - 10)) / 2 if p < 0.5 else (2 - 2 ** (-20 * p + 10)) / 2,
    "backIn": lambda p: _c3 * p ** 3 - _c1 * p * p,
    "backOut": lambda p: 1 + _c3 * (p - 1) ** 3 + _c1 * (p - 1) ** 2,
    "backInOut": lambda p:
        ((2 * p) ** 2 * ((_c1 * 1.525 + 1) * 2 * p - _c1 * 1.525)) / 2 if p < 0.5 else
        ((2 * p - 2) ** 2 * ((_c1 * 1.525 + 1) * (p * 2 - 2) + _c1 * 1.525) + 2) / 2,
    "elasticOut": lambda p: 0.0 if p == 0 else 1.0 if p == 1 else
        2 ** (-10 * p) * _math.sin((p * 10 - 0.75) * _c4) + 1,
    "elasticInOut": lambda p: 0.0 if p == 0 else 1.0 if p == 1 else
        (-(2 ** (20 * p - 10) * _math.sin((20 * p - 11.125) * _c5))) / 2 if p < 0.5 else
        (2 ** (-20 * p + 10) * _math.sin((20 * p - 11.125) * _c5)) / 2 + 1,
    "bounceOut": _bounce_out,
}


def _apply_ease(name: str | None, p: float) -> float:
    f = _EASES.get(name) if name else None
    return f(max(0.0, min(1.0, p))) if f else p


def _prop_points(kfs: list, base: dict, key: str, default: float,
                 coord_scale: float, lo: float | None = None,
                 samples: int = 16) -> list[tuple[float, float]]:
    """Build piecewise points for one property, expanding eased segments into
    `samples` linear sub-points (linear segments stay 2-point). coord_scale maps
    keyframe t (0..1) to the expr's coordinate (output frame or seconds)."""
    sel = [(k.get("t", 0), float(k[key]), k.get("ease"))
           for k in kfs if isinstance(k.get(key), (int, float))]

    def clamp(v: float) -> float:
        return max(lo, v) if lo is not None else v

    if not sel:
        return [(0.0, clamp(float(base.get(key, default))))]
    pts: list[tuple[float, float]] = [(sel[0][0] * coord_scale, clamp(sel[0][1]))]
    for (ta, va, _), (tb, vb, easeb) in zip(sel, sel[1:]):
        if easeb and easeb != "linear" and easeb in _EASES:
            for j in range(1, samples + 1):
                u = j / samples
                e = _apply_ease(easeb, u)
                pts.append(((ta + (tb - ta) * u) * coord_scale, clamp(va + (vb - va) * e)))
        else:
            pts.append((tb * coord_scale, clamp(vb)))
    return pts


def parse_transform(raw: str) -> dict | None:
    """Resolve clip.transform_json (preset / keyframes / static base) to keyframe form."""
    if not raw or not raw.strip():
        return None
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return _normalize_transform(_TRANSFORM_PRESETS.get(raw.strip()))   # bare preset
    if not isinstance(data, dict):
        return None
    if data.get("kind") == "text":             # element clip, not a transform
        return None
    if data.get("preset"):
        merged = dict(_TRANSFORM_PRESETS.get(data["preset"]) or {})
        for k in (*_TPROPS, "anchor"):         # base overrides alongside a preset
            if k in data:
                merged[k] = data[k]
        return _normalize_transform(merged)
    return _normalize_transform(data)


async def _transform_pass(src: Path, out: Path, transform: dict,
                          dur_sec: float, fps: float, w: int, h: int) -> None:
    """
    Apply animated zoom/pan/shake to a pre-rendered segment.

    zoompan rounds its crop origin to INTEGER source pixels every frame, which
    shimmers on slow zoom/pan. Upscaling SS× first makes one output pixel = SS
    source pixels, so that rounding error is ≤1/SS of an output pixel → smooth.
    SS=3 (was 2) noticeably removes the 静止画MAD Ken-Burns jitter.
    """
    SS = 3
    n = max(1, round(dur_sec * fps))
    kfs = sorted(transform.get("keyframes", []), key=lambda k: k.get("t", 0))
    base = transform.get("base") or {}

    # Per-property points (eased segments sampled into linear sub-points); only
    # keyframes that CARRY a prop contribute, else the property is constant at its
    # static base. Matches the frontend transformEval.sampleProp() so preview==render.
    z_pts  = _prop_points(kfs, base, "scale", 1.0, n, lo=1.0)   # zoompan zooms IN only (≥1)
    px_pts = _prop_points(kfs, base, "x", 0.0, n)
    py_pts = _prop_points(kfs, base, "y", 0.0, n)
    z_expr  = _piecewise_expr(z_pts)
    px_expr = _piecewise_expr(px_pts)
    py_expr = _piecewise_expr(py_pts)

    shake = transform.get("shake")
    sx = sy = "0"
    if shake:
        amp = float(shake.get("amp", 12)) * SS   # SS×-upscaled pixels
        decay = float(shake.get("decay", 1.0))
        # decaying pseudo-random jitter (two incommensurate sines)
        env = f"exp(-{decay:.3f}*on/{max(1, n):.1f}*4)"
        sx = f"({amp:.1f}*{env}*sin(on*12.9898))"
        sy = f"({amp:.1f}*{env}*cos(on*78.233))"

    # zoompan: x/y are the crop origin in (upscaled) input pixels
    x_expr = f"(iw-iw/zoom)/2+({px_expr})*iw+{sx}"
    y_expr = f"(ih-ih/zoom)/2+({py_expr})*ih+{sy}"
    vf = (
        f"scale={w * SS}:{h * SS}:flags=lanczos,"
        f"zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}'"
        f":d=1:s={w}x{h}:fps={fps}"
    )

    # Rotation (degrees → radians), eased+keyframed over output frame `n`. Only
    # added when non-zero so unrotated clips keep the cheap path. Frame stays w×h
    # (corners fill black on the base track).
    rot_deg = _prop_points(kfs, base, "rotation", 0.0, n)
    rot_pts = [(c, v * _math.pi / 180.0) for c, v in rot_deg]
    if any(abs(v) > 1e-4 for _, v in rot_pts):
        rot_expr = _piecewise_expr(rot_pts, var="n")
        vf += f",rotate=a='{rot_expr}':ow=iw:oh=ih:c=black"
    cmd = [
        FFMPEG, "-y",
        "-i", str(src),
        "-vf", vf,
        *_X264,
        "-an",
        str(out),
    ]
    await _run(cmd)


async def _overlay_pass(base: Path, seg: Path, out: Path,
                        start_sec: float, dur_sec: float,
                        opacity: float, blend: str,
                        w: int, h: int, fps: float = 30.0) -> None:
    """
    Composite one overlay segment onto the base video at its timeline position.

    blend 'normal' uses alpha overlay (transparent MGs float over footage);
    'screen'/'add'/'multiply' use the blend filter (MAD staples for light FX).
    Frames outside [start, start+dur] pass through unchanged.
    """
    end_sec = start_sec + dur_sec
    # 区間の判定はフレームの中心で行う。境界を秒でそのまま書くと、
    # 413/30=13.7666666… のように6桁表示が実値より大きくなる位置で
    # 先頭1フレームが区間から外れ、そのカットだけ1フレーム遅れて出る。
    half = 0.5 / max(1.0, fps)
    enable = f"between(t,{start_sec - half:.6f},{end_sec - half:.6f})"
    if blend in ("screen", "add", "multiply"):
        # blend needs equal-length streams → pad the overlay to the base span.
        fc = (
            f"[1:v]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,format=gbrp,"
            f"tpad=start_duration={start_sec:.6f}:start_mode=add:color=black,"
            f"tpad=stop_duration=3600:stop_mode=add:color=black[ov];"
            f"[0:v]format=gbrp[b];"
            f"[b][ov]blend=all_mode={blend}:all_opacity={opacity:.3f}:shortest=1:enable='{enable}',format=yuv420p[v]"
        )
    else:
        # alpha overlay; opacity scales the overlay's alpha channel
        fc = (
            f"[1:v]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba,"
            f"colorchannelmixer=aa={opacity:.3f},"
            f"setpts=PTS+{start_sec:.6f}/TB[ov];"
            f"[0:v][ov]overlay=0:0:enable='{enable}',format=yuv420p[v]"
        )
    cmd = [
        FFMPEG, "-y",
        "-i", str(base), "-i", str(seg),
        "-filter_complex", fc,
        "-map", "[v]",
        *_VENC,
        "-an",
        str(out),
    ]
    await _run(cmd)


async def _overlay_transform_pass(seg: Path, out: Path, transform: dict,
                                  dur_sec: float, fps: float, w: int, h: int) -> None:
    """
    Bake a per-LAYER transform (scale / position / rotation) into a cover-fit
    overlay segment, producing a WxH transparent .mov with the layer placed —
    so the existing alpha composite can overlay it at 0:0. Mirrors the preview
    compositor's drawLayer: cover-fit × scale, panned by (x,y), rotated about
    centre. Scale/position/rotation may all be keyframed (eval=frame).

    Opacity is handled by the composite step (static); animated opacity on an
    overlay is the one prop that still bakes flat here — keyframe it on the base
    track for now.
    """
    kfs = sorted(transform.get("keyframes", []), key=lambda k: k.get("t", 0))
    base = transform.get("base") or {}

    # eased points over SECONDS (overlay/rotate exprs use `t`)
    z_expr = _piecewise_expr(_prop_points(kfs, base, "scale", 1.0, dur_sec, lo=0.01), var="t")
    x_expr = _piecewise_expr(_prop_points(kfs, base, "x", 0.0, dur_sec), var="t")
    y_expr = _piecewise_expr(_prop_points(kfs, base, "y", 0.0, dur_sec), var="t")
    rot_pts = [(c, v * _math.pi / 180.0) for c, v in _prop_points(kfs, base, "rotation", 0.0, dur_sec)]
    has_rot = any(abs(v) > 1e-4 for _, v in rot_pts)

    # layer: cover WxH seg → animated scale → optional rotation (alpha-safe)
    chain = (f"[0:v]format=rgba,"
             f"scale=w='iw*({z_expr})':h='ih*({z_expr})':eval=frame:flags=bilinear")
    if has_rot:
        rexpr = _piecewise_expr(rot_pts, var="t")
        # constant max bbox (hypot) keeps overlay_w/h stable → centring doesn't jitter
        chain += f",rotate=a='{rexpr}':ow=hypot(iw\\,ih):oh=hypot(iw\\,ih):c=none"
    chain += "[lyr];"
    bg = f"color=c=black@0:s={w}x{h}:r={fps}:d={dur_sec:.6f},format=rgba[bg];"
    comp = (f"[bg][lyr]overlay=eval=frame:"
            f"x='(W-w)/2+({x_expr})*{w}':y='(H-h)/2+({y_expr})*{h}':format=auto[v]")
    cmd = [
        FFMPEG, "-y",
        "-i", str(seg),
        "-filter_complex", chain + bg + comp,
        "-map", "[v]",
        *_QTRLE, "-an",
        str(out),
    ]
    await _run(cmd)


async def _composite_one(base: Path, overlays: list[dict], out: Path, w: int, h: int,
                         base_ss: float = 0.0, base_t: Optional[float] = None,
                         progress_cb=None, fps: float = 30.0) -> None:
    """Composite overlays onto base in ONE filter_complex pass. Optionally over a
    time WINDOW of the base ([base_ss, base_ss+base_t]) with per-overlay input seek
    — this is what lets the dispatcher run independent time-chunks in parallel.
    Overlay start/dur/enable are window-relative (the caller adjusts them)."""
    if not overlays:
        # still honour the window (trim) if requested
        cmd = [FFMPEG, "-y"]
        if base_ss > 0: cmd += ["-ss", f"{base_ss:.6f}"]
        cmd += ["-i", str(base)]
        if base_t is not None: cmd += ["-t", f"{base_t:.6f}"]
        cmd += [*_VENC, "-an", str(out)]
        await _run(cmd); return
    inputs: list[str] = []
    if base_ss > 0: inputs += ["-ss", f"{base_ss:.6f}"]
    inputs += ["-i", str(base)]
    parts: list[str] = []
    prev = "0:v"
    for i, ov in enumerate(overlays):
        seek = float(ov.get("seek", 0.0))
        if seek > 0: inputs += ["-ss", f"{seek:.6f}"]
        inputs += ["-i", str(ov["path"])]
        idx = i + 1
        start = float(ov["start"]); dur = float(ov["dur"]); end = start + dur
        op = max(0.0, min(1.0, float(ov.get("opacity", 1.0))))
        blend = ov.get("blend", "normal") or "normal"
        half = 0.5 / max(1.0, fps)
        enable = f"between(t,{start - half:.6f},{end - half:.6f})"
        if blend in ("screen", "add", "multiply"):
            parts.append(
                f"[{idx}:v]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,format=gbrp,"
                f"tpad=start_duration={start:.6f}:start_mode=add:color=black,"
                f"tpad=stop_duration=3600:stop_mode=add:color=black[ov{i}]")
            parts.append(
                f"[{prev}]format=gbrp[b{i}];"
                f"[b{i}][ov{i}]blend=all_mode={blend}:all_opacity={op:.3f}:shortest=1:"
                f"enable='{enable}',format=yuv420p[v{i}]")
        else:
            parts.append(
                f"[{idx}:v]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba,"
                f"colorchannelmixer=aa={op:.3f},setpts=PTS+{start:.6f}/TB[ov{i}]")
            parts.append(f"[{prev}][ov{i}]overlay=0:0:enable='{enable}'[v{i}]")
        prev = f"v{i}"
    parts.append(f"[{prev}]format=yuv420p[vout]")
    cmd = [FFMPEG, "-y", *inputs, "-filter_complex", ";".join(parts), "-map", "[vout]"]
    if base_t is not None: cmd += ["-t", f"{base_t:.6f}"]
    cmd += [*_VENC, "-an", str(out)]
    await _run(cmd, progress_cb)


def parse_layout(raw: str) -> dict | None:
    """track.layout_json を {x,y,w,h,fit} に正規化する。全画面(既定)なら None。

    x/y/w/h は出力画面に対する比率(0..1)。レイヤーを AE のコンポジションのように
    画面内の任意の矩形へ収める。比較用に「Shots=左半分 / Video=右半分」と置けば、
    1回のレンダーの中で並ぶので、2本の動画を突き合わせる工程自体が要らなくなる。
    """
    if not raw or not str(raw).strip():
        return None
    try:
        d = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(d, dict):
        return None
    x, y = float(d.get("x", 0.0)), float(d.get("y", 0.0))
    w, h = float(d.get("w", 1.0)), float(d.get("h", 1.0))
    if (x, y, w, h) == (0.0, 0.0, 1.0, 1.0):
        return None
    return {"x": x, "y": y, "w": max(0.01, w), "h": max(0.01, h),
            "fit": d.get("fit", "contain"), "bg": d.get("bg", "black")}


async def _layout_pass(src: Path, out: Path, lay: dict, w: int, h: int,
                       fps: float, keep_alpha: bool = False) -> None:
    """全画面のセグメントを、レイアウトが指す矩形へ縮小配置する。

    出力サイズは変えない。矩形外は透明(オーバーレイ)または背景色(ベース)で埋める。
    整数丸めで1pxずれないよう、矩形は偶数に揃える。
    """
    iw = max(2, int(round(w * lay["w"])) // 2 * 2)
    ih = max(2, int(round(h * lay["h"])) // 2 * 2)
    ox, oy = int(round(w * lay["x"])), int(round(h * lay["y"]))
    fitv = ("increase" if lay["fit"] == "cover" else "decrease")
    inner = (f"scale={iw}:{ih}:force_original_aspect_ratio={fitv}:flags=lanczos,"
             + (f"crop={iw}:{ih}" if lay["fit"] == "cover"
                else f"pad={iw}:{ih}:(ow-iw)/2:(oh-ih)/2:color=black@0"))
    pad_col = "black@0" if keep_alpha else lay.get("bg", "black")
    vf = f"{inner},pad={w}:{h}:{ox}:{oy}:color={pad_col}"
    if keep_alpha:
        vf = "format=rgba," + vf + ",format=rgba"
    args = [*_QTRLE] if keep_alpha else [*_X264, "-pix_fmt", "yuv420p"]
    await _run([FFMPEG, "-y", "-i", str(src), "-vf", vf, "-r", str(fps), *args, str(out)])


async def _composite_overlays(base: Path, overlays: list[dict], out: Path,
                              w: int, h: int, total_dur: float = 0.0, fps: float = 30.0,
                              progress_cb=None) -> None:
    """Composite ALL overlays onto the base — the heaviest render stage (one chained
    filter_complex over the whole timeline is ~single-threaded, dominating render time
    with many overlays). So split the timeline into time-CHUNKS and composite them in
    PARALLEL (one ffmpeg per chunk, only the overlays active in that chunk), then concat
    — using all CPU cores on the bottleneck. Each overlay carries {path,start,dur,
    opacity,blend}; alpha MGs use `overlay`, light-FX (screen/add/multiply) use `blend`.
    Falls back to a single pass for short/simple timelines or on any chunk error."""
    if not overlays:
        shutil.copy(base, out)
        return
    import math
    cores = os.cpu_count() or 4
    total_frames = max(1, round(total_dur * fps)) if total_dur > 0 else 0
    n = min(cores, max(1, math.ceil(total_dur / 4.0))) if total_dur > 0 else 1
    if n <= 1 or len(overlays) < 3 or cores < 2 or total_frames < 2 * n:
        await _composite_one(base, overlays, out, w, h, progress_cb=progress_cb, fps=fps)
        return
    try:
        chunk_frames = math.ceil(total_frames / n)
        chunk_files: list[Path] = []
        tasks = []
        for ci in range(n):
            f0 = ci * chunk_frames
            f1 = min(total_frames, (ci + 1) * chunk_frames)
            if f0 >= f1:
                break
            c0, clen = f0 / fps, (f1 - f0) / fps
            cf = out.parent / f"{out.stem}_ck{ci:02d}.mp4"
            chunk_files.append(cf)
            ovs = []
            for ov in overlays:
                s = float(ov["start"]); e = s + float(ov["dur"])
                if s < c0 + clen and e > c0:                 # overlaps this chunk
                    a0, a1 = max(s, c0), min(e, c0 + clen)
                    ovs.append({**ov, "start": a0 - c0, "dur": a1 - a0, "seek": max(0.0, c0 - s)})
            tasks.append(_composite_one(base, ovs, cf, w, h, base_ss=c0, base_t=clen, fps=fps))
        await asyncio.gather(*tasks)
        await _concat(chunk_files, out, progress_cb)
    except Exception:
        # any issue with chunking → safe single-pass fallback
        await _composite_one(base, overlays, out, w, h, progress_cb=progress_cb, fps=fps)


async def _extract_audio_segment(src: str, out: Path,
                                  in_sec: float, dur_sec: float,
                                  timeline_start: float,
                                  fade_in_sec: float = 0.0,
                                  fade_out_sec: float = 0.0) -> None:
    """Extract audio, apply fades, pad with silence to match timeline position."""
    # First extract the clip audio (with optional fade in/out)
    raw = out.parent / f"{out.stem}_raw.aac"
    afilters = []
    if fade_in_sec > 0.01:
        afilters.append(f"afade=t=in:st=0:d={fade_in_sec:.3f}")
    if fade_out_sec > 0.01:
        st = max(0.0, dur_sec - fade_out_sec)
        afilters.append(f"afade=t=out:st={st:.3f}:d={fade_out_sec:.3f}")
    cmd = [
        FFMPEG, "-y",
        "-ss", str(in_sec), "-t", str(dur_sec),
        "-i", src,
    ]
    if afilters:
        cmd += ["-af", ",".join(afilters)]
    cmd += [
        "-vn", "-c:a", "aac", "-b:a", "320k",
        str(raw),
    ]
    await _run(cmd)

    # Prepend silence for timeline offset
    if timeline_start > 0.01:
        cmd2 = [
            FFMPEG, "-y",
            "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo:d={timeline_start}",
            "-i", str(raw),
            "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[outa]",
            "-map", "[outa]", "-c:a", "aac", "-b:a", "320k",
            str(out),
        ]
        await _run(cmd2)
        raw.unlink(missing_ok=True)
    else:
        raw.rename(out)


async def _mix_audio_into_video(video: Path, audio_segments: list[Path],
                                 total_dur: float, out: Path,
                                 progress_cb=None) -> None:
    """Mix multiple audio segments and mux with video."""
    if not audio_segments:
        # No audio — just copy video
        shutil.copy(video, out)
        return

    inputs = ["-i", str(video)]
    filter_parts = []
    for i, seg in enumerate(audio_segments):
        inputs += ["-i", str(seg)]
        filter_parts.append(f"[{i+1}:a]")

    if len(audio_segments) == 1:
        audio_map = "1:a"          # direct stream map (brackets = filtergraph label, wrong here)
        filter_str = None
    else:
        mix_label = "[amix]"
        filter_str = "".join(filter_parts) + f"amix=inputs={len(audio_segments)}:normalize=0{mix_label}"
        audio_map = mix_label

    cmd = [FFMPEG, "-y"] + inputs
    if filter_str:
        cmd += ["-filter_complex", filter_str]
    cmd += [
        "-map", "0:v",
        "-map", audio_map,
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "320k",
        "-movflags", "+faststart",   # moov atom up front → instant web/iOS playback
        "-t", str(total_dur),
        str(out),
    ]
    await _run(cmd, progress_cb)


# ── Public entry point ────────────────────────────────────────────────────────

async def render_timeline(
    job_id: int,
    project_id: int,
    tracks: list,
    clips: list,
    assets: list,
    fps: float,
    width: int,
    height: int,
    progress_cb=None,
    encoder: str | None = None,
) -> Path:
    """
    Render the timeline to an MP4 file.
    Returns the output file path.
    """
    # Pick CPU (x264) or GPU (nvenc) encoder for this render.
    # encoder引数(ジョブ単位の上書き — 720pレビュー等) > 設定 > config の順。
    try:
        from app import config
        from app.services import settings_store as _S
        backend = configure_encoder(encoder or _S.get("RENDER_ENCODER", config.RENDER_ENCODER))
    except Exception:
        backend = configure_encoder(encoder or "x264")
    import logging as _lg
    _lg.getLogger(__name__).info(f"render encoder = {backend} ({FFMPEG})")

    tmp_root = Path(tempfile.mkdtemp(prefix=f"kychapogas_render_{job_id}_"))

    try:
        asset_map = {a.id: a for a in assets}

        # ── ⬆ 高解像度版への自動差し替え ──────────────────────────────────
        # scripts/upscale_assets.py が作った拡大版アセットは
        # gen_params_json に {"upscale_of": <元アセットID>} を持つ。
        # 書き出しの縦解像度が元素材より大きいときだけ、そちらを使う。
        # タイムライン/プレビューは軽い元素材のままなので操作感は変わらない。
        upscaled: dict[int, object] = {}
        for a in assets:
            origin = None
            gp = getattr(a, "gen_params_json", "") or ""
            if "upscale_of" in gp:
                try:
                    origin = json.loads(gp).get("upscale_of")
                except Exception:
                    origin = None
            if origin is None:
                # 命名規約からの復元: up_<元アセットID>_<元の名前>.mp4
                m = re.match(r"^up_(\d+)_", getattr(a, "name", "") or "")
                if m:
                    origin = int(m.group(1))
            if not isinstance(origin, int):
                continue
            cur = upscaled.get(origin)
            # 同じ元に複数あれば大きいほうを採る
            if cur is None or (a.height or 0) > (getattr(cur, "height", 0) or 0):
                upscaled[origin] = a

        def _pick(asset):
            """書き出し解像度に見合う素材を選ぶ(無ければ元のまま)"""
            if asset is None:
                return None
            up = upscaled.get(asset.id)
            if up is None or not Path(up.file_path).exists():
                return asset
            if (asset.height or 0) >= height:
                return asset          # 元で足りているなら拡大版は使わない
            return up

        if upscaled:
            _lg.getLogger(__name__).info(
                f"upscaled assets available: {len(upscaled)} (render height={height})")

        # ── Identify tracks ───────────────────────────────────────────────────
        # First video track (by order) is the BASE; further video tracks are
        # OVERLAYS composited on top (alpha/blend), in track order.
        # UI上で上にあるトラック(order小)ほど最前面。ベースは最下段(order最大)、
        # オーバーレイは下から上へ順に重ねる(最後に適用=最前面)。
        video_tracks = sorted([t for t in tracks
                               if t.track_type == "video" and not getattr(t, "hidden", False)],
                              key=lambda t: -t.order)
        audio_tracks = [t for t in tracks
                        if t.track_type == "audio" and not getattr(t, "hidden", False)]

        v_track = video_tracks[0] if video_tracks else None
        a_track = audio_tracks[0] if audio_tracks else None
        overlay_tracks = video_tracks[1:]
        base_layout = parse_layout(getattr(v_track, "layout_json", "") or "") if v_track else None
        overlay_layouts = [parse_layout(getattr(t, "layout_json", "") or "")
                           for t in overlay_tracks]

        v_clips = sorted(
            [c for c in clips if v_track and c.track_id == v_track.id],
            key=lambda c: c.start_frame,
        )
        a_clips = sorted(
            [c for c in clips if a_track and c.track_id == a_track.id],
            key=lambda c: c.start_frame,
        )
        o_clips = [
            (t_idx, c) for t_idx, t in enumerate(overlay_tracks)
            for c in sorted([c for c in clips if c.track_id == t.id],
                            key=lambda c: c.start_frame)
        ]

        all_clips = v_clips + a_clips + [c for _, c in o_clips]
        if not all_clips:
            raise ValueError("タイムラインにクリップがありません")

        total_frames = max(c.start_frame + c.duration_frames for c in all_clips)
        total_dur = total_frames / fps

        # ── Video segments ────────────────────────────────────────────────────
        # Each entry: [path, duration_sec, transition_in, transition_sec]
        # (transition_in joins the segment to the PREVIOUS one, duration-preserving)
        segs: list[list] = []
        current_frame = 0
        n = 0

        if progress_cb:
            progress_cb(0.05)

        for clip in v_clips:
            # Gap → black
            if clip.start_frame > current_frame:
                gap_dur = (clip.start_frame - current_frame) / fps
                gap_file = tmp_root / f"gap_{n:04d}.mp4"
                await _black_segment(gap_file, gap_dur, width, height, fps)
                segs.append([gap_file, gap_dur, "", 0.0])
                n += 1

            clip_dur = clip.duration_frames / fps
            trans = getattr(clip, "transition_in", "") or ""
            trans_sec = (getattr(clip, "transition_frames", 0) or 0) / fps
            # A transition needs a previous segment and a sane duration
            if trans and (not segs or trans_sec < 0.02):
                trans = ""
            trans_sec = min(trans_sec, clip_dur * 0.9, 2.0)

            # Clip segment
            asset = _pick(asset_map.get(clip.asset_id))
            if asset and Path(asset.file_path).exists():
                seg_file = tmp_root / f"seg_{n:04d}.mp4"
                # Still images (freeze-frames / placeholders) loop for the clip
                # duration; videos are extracted with speed remap.
                is_image = (asset.asset_type == "image"
                            or (asset.asset_type == "generated" and asset.duration_sec is None))
                # Base track fills the frame (cover) to match the preview
                # compositor (drawLayer is cover-fit) — true WYSIWYG, no letterbox.
                if is_image:
                    await _image_segment(asset.file_path, seg_file, clip_dur,
                                         width, height, fps, fit="cover")
                else:
                    remap_keys = parse_remap(getattr(clip, "remap_json", "") or "",
                                             clip.duration_frames, clip.asset_in_frame)
                    if remap_keys:
                        # ⏱ 時間リマップ: キー列が speed/ease/posterize より優先
                        await _extract_remap_segment(
                            asset.file_path, seg_file, remap_keys,
                            clip_dur, width, height, fps, fit="cover")
                    else:
                        await _extract_segment(
                            asset.file_path, seg_file,
                            clip.asset_in_frame / fps,
                            clip_dur,
                            width, height, fps,
                            speed=getattr(clip, "speed", 1.0) or 1.0,
                            ease=getattr(clip, "speed_ease", "linear") or "linear",
                            fit="cover",
                            hold_fps=getattr(clip, "posterize_fps", 0) or 0,
                        )
                # Animated zoom/pan/shake (transform keyframes)
                tr = parse_transform(getattr(clip, "transform_json", "") or "")
                if tr:
                    tr_file = tmp_root / f"seg_{n:04d}_tr.mp4"
                    await _transform_pass(seg_file, tr_file, tr, clip_dur, fps, width, height)
                    seg_file = tr_file
                # レイヤー(トラック)のレイアウト。比較表示で左右に分けるのはここ。
                if base_layout:
                    ly_file = tmp_root / f"seg_{n:04d}_ly.mp4"
                    await _layout_pass(seg_file, ly_file, base_layout, width, height, fps)
                    seg_file = ly_file
                segs.append([seg_file, clip_dur, trans, trans_sec])
            else:
                # Missing asset → black placeholder
                gap_file = tmp_root / f"missing_{n:04d}.mp4"
                await _black_segment(gap_file, clip_dur, width, height, fps)
                segs.append([gap_file, clip_dur, trans, trans_sec])
            n += 1
            current_frame = clip.start_frame + clip.duration_frames

            if progress_cb:
                progress_cb(0.05 + 0.5 * (current_frame / total_frames))

        # ── Transition merge pass ─────────────────────────────────────────────
        # Left-fold: whenever a segment declares a transition, xfade-merge it
        # into the accumulated previous segment (freeze-extended, so the total
        # length is unchanged and the music stays in sync).
        merged: list[list] = []
        m = 0
        for seg in segs:
            if seg[2] and merged:
                prev = merged[-1]
                out_file = tmp_root / f"xf_{m:04d}.mp4"
                m += 1
                await _xfade_merge(prev[0], seg[0], out_file,
                                   transition=seg[2], d_sec=seg[3], a_dur=prev[1])
                merged[-1] = [out_file, prev[1] + seg[1], prev[2], prev[3]]
            else:
                merged.append(seg)
        seg_files = [s[0] for s in merged]

        if progress_cb:
            progress_cb(0.6)

        # Trailing gap if needed
        if not v_clips:
            # Pure audio project — generate silent black video
            blank = tmp_root / "blank.mp4"
            await _black_segment(blank, total_dur, width, height, fps)
            seg_files = [blank]

        # ── Concat video ──────────────────────────────────────────────────────
        video_only = tmp_root / "video_only.mp4"
        if len(seg_files) == 1:
            shutil.copy(seg_files[0], video_only)
        else:
            await _concat(seg_files, video_only,
                          progress_cb=lambda p: progress_cb(0.6 + 0.15 * p) if progress_cb else None)

        # ── Overlay tracks (video tracks above the first) ─────────────────────
        # Each overlay clip is extracted once, then ALL are composited onto the base
        # in a SINGLE filter_complex pass (see _composite_overlays) — so the base is
        # encoded only once instead of once per overlay (no compounding loss with
        # many 歌詞テロップ). Transparent MGs (alpha .mov) float over the footage.
        overlays: list[dict] = []
        for oi, (t_idx, oc) in enumerate(o_clips):
            asset = _pick(asset_map.get(oc.asset_id))
            if not asset or not Path(asset.file_path).exists():
                continue
            oc_dur = oc.duration_frames / fps
            oseg = tmp_root / f"ovseg_{oi:04d}.mov"   # mov preserves alpha
            is_image = (asset.asset_type == "image"
                        or (asset.asset_type == "generated" and asset.duration_sec is None))
            # フィットの決め方:
            #   LAYER変換あり → cover(プレビューの合成と揃えて焼き込みをずらさない)
            #   透過素材(テロップ/FX)  → contain(全画面前提。切ると端の絵が欠ける)
            #   不透明な映像/画像      → cover
            # 不透明素材をcontainにすると、素材と出力の縦横比がわずかに違うだけで
            # 上下(または左右)に数ピクセルの余白ができ、そこから下のトラックが覗く。
            # 生成物は864x480(1.800)や1344x768(1.750)で、出力1280x720(1.778)と
            # 完全一致しないため必ず起きる。短辺基準で埋めて溢れを切る。
            o_tr = parse_transform(getattr(oc, "transform_json", "") or "")
            ofit = "cover" if (o_tr or not _has_alpha(asset.file_path)) else "contain"
            if is_image:
                await _image_segment(asset.file_path, oseg, oc_dur, width, height, fps,
                                     keep_alpha=True, fit=ofit)
            else:
                # ⏱時間リマップは重ね合わせ側でも効かせる。Scenes等は必ずこちらを通るため、
                # ここに無いとプレビューだけ合っていて書き出しに反映されない。
                o_remap = parse_remap(getattr(oc, "remap_json", "") or "",
                                      oc.duration_frames, oc.asset_in_frame)
                if o_remap:
                    await _extract_remap_segment(
                        asset.file_path, oseg, o_remap, oc_dur,
                        width, height, fps, fit=ofit, keep_alpha=True)
                else:
                    await _extract_segment(
                        asset.file_path, oseg,
                        oc.asset_in_frame / fps, oc_dur,
                        width, height, fps,
                        speed=getattr(oc, "speed", 1.0) or 1.0,
                        ease=getattr(oc, "speed_ease", "linear") or "linear",
                        hold_fps=getattr(oc, "posterize_fps", 0) or 0,
                        keep_alpha=True, fit=ofit,
                    )
            if o_tr:
                otr_seg = tmp_root / f"ovseg_{oi:04d}_tr.mov"
                await _overlay_transform_pass(oseg, otr_seg, o_tr, oc_dur, fps, width, height)
                oseg = otr_seg
            o_lay = overlay_layouts[t_idx] if t_idx < len(overlay_layouts) else None
            if o_lay:
                oly_seg = tmp_root / f"ovseg_{oi:04d}_ly.mov"
                await _layout_pass(oseg, oly_seg, o_lay, width, height, fps, keep_alpha=True)
                oseg = oly_seg
            overlays.append({
                "path": oseg,
                "start": oc.start_frame / fps,
                "dur": oc_dur,
                "opacity": max(0.0, min(1.0, getattr(oc, "opacity", 1.0) or 1.0)),
                "blend": (getattr(oc, "blend", "normal") or "normal"),
            })
        if overlays:
            merged_out = tmp_root / "overlaid.mp4"
            await _composite_overlays(
                video_only, overlays, merged_out, width, height,
                total_dur=total_dur, fps=fps,
                progress_cb=lambda p: progress_cb(0.75 + 0.03 * p) if progress_cb else None,
            )
            video_only = merged_out

        if progress_cb:
            progress_cb(0.78)

        # ── Audio segments ────────────────────────────────────────────────────
        audio_segs: list[Path] = []
        for i, clip in enumerate(a_clips):
            asset = _pick(asset_map.get(clip.asset_id))
            if not asset or not Path(asset.file_path).exists():
                continue
            seg_file = tmp_root / f"audio_{i:04d}.aac"
            await _extract_audio_segment(
                asset.file_path, seg_file,
                clip.asset_in_frame / fps,
                clip.duration_frames / fps,
                clip.start_frame / fps,
                fade_in_sec=(getattr(clip, "fade_in_frames", 0) or 0) / fps,
                fade_out_sec=(getattr(clip, "fade_out_frames", 0) or 0) / fps,
            )
            audio_segs.append(seg_file)

        if progress_cb:
            progress_cb(0.85)

        # ── Mux audio + video ─────────────────────────────────────────────────
        output = _exports_path(project_id, job_id)
        await _mix_audio_into_video(
            video_only, audio_segs, total_dur, output,
            progress_cb=lambda p: progress_cb(0.85 + 0.14 * p) if progress_cb else None,
        )

        if progress_cb:
            progress_cb(1.0)

        return output

    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def export_path(project_id: int, job_id: int) -> Path:
    return _exports_path(project_id, job_id)
