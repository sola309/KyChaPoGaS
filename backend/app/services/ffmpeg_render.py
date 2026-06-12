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
import shutil
import tempfile
from pathlib import Path
from typing import Optional

import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
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


def _scale_pad_fps(w: int, h: int, fps: float, alpha: bool = False) -> str:
    pad_color = ":color=black@0" if alpha else ""
    fmt = ",format=rgba" if alpha else ""
    return (f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2{pad_color},fps={fps}{fmt}")


# Encoder args: alpha output uses QuickTime RLE in .mov (libx264 has no alpha)
_X264 = ["-c:v", "libx264", "-crf", "23", "-preset", "fast"]
_QTRLE = ["-c:v", "qtrle"]


async def _extract_segment(src: str, out: Path, in_sec: float,
                           dur_sec: float, w: int, h: int, fps: float,
                           speed: float = 1.0, ease: str = "linear",
                           keep_alpha: bool = False) -> None:
    """
    Extract a clip segment to uniform resolution/fps, applying a speed remap.

    dur_sec is the OUTPUT (timeline) duration; the segment consumes
    ``dur_sec * speed`` seconds of source. ease shapes accel/decel (bezier).
    keep_alpha preserves transparency (overlay clips; qtrle .mov, linear only).
    """
    speed = max(0.05, float(speed))
    source_span = dur_sec * speed
    vf = _scale_pad_fps(w, h, fps, alpha=keep_alpha)

    # Constant speed (linear) — single pass with setpts.
    # Clips shorter than ~0.5s also render linear: piecewise easing would
    # produce sub-frame parts (0-stream files), and a ramp that brief is
    # imperceptible anyway. Alpha output is linear-only.
    pts = _ease_points(ease)
    if dur_sec * fps < 16 or keep_alpha:
        pts = None
    if pts is None:
        cmd = [
            FFMPEG, "-y",
            "-ss", f"{in_sec:.6f}", "-t", f"{source_span:.6f}", "-i", src,
            "-vf", f"setpts=PTS/{speed:.6f},{vf}",
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
            "-vf", (f"setpts=PTS/{seg_speed:.6f},{vf},"
                    f"tpad=stop_mode=clone:stop_duration={seg_out:.6f}"),
            "-t", f"{seg_out:.6f}",
            "-c:v", "libx264", "-crf", "23", "-preset", "fast",
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
        "-c:v", "libx264", "-crf", "23", "-preset", "fast",
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
        "-c:v", "libx264", "-crf", "23", "-preset", "fast",
        "-an",
        str(out),
    ]
    await _run(cmd)


async def _image_segment(src: str, out: Path, dur_sec: float,
                         w: int, h: int, fps: float,
                         keep_alpha: bool = False) -> None:
    """Render a still image as a video segment of the given duration.
    (-ss/-t extraction on an image input yields a single frame, so stills
    need -loop 1 instead.)"""
    cmd = [
        FFMPEG, "-y",
        "-loop", "1", "-framerate", str(fps), "-t", f"{dur_sec:.6f}",
        "-i", src,
        "-vf", _scale_pad_fps(w, h, fps, alpha=keep_alpha),
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
        "-c:v", "libx264", "-crf", "23", "-preset", "fast",
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
        "-c:v", "libx264", "-crf", "23", "-preset", "fast",
        "-an",
        str(out),
    ]
    await _run(cmd, progress_cb)
    list_file.unlink(missing_ok=True)


# ── Transform (zoom / pan / shake — 静止画MADの核) ────────────────────────────

# Presets resolve to keyframes: t = 0..1 over the clip,
# scale ≥ 1, x/y = pan as fraction of the frame (-0.5..0.5), shake = px amplitude.
_TRANSFORM_PRESETS: dict[str, dict] = {
    "kenburns_in":  {"keyframes": [{"t": 0, "scale": 1.0}, {"t": 1, "scale": 1.18}]},
    "kenburns_out": {"keyframes": [{"t": 0, "scale": 1.18}, {"t": 1, "scale": 1.0}]},
    "punch_in":     {"keyframes": [{"t": 0, "scale": 1.28}, {"t": 0.22, "scale": 1.0}]},
    "punch_out":    {"keyframes": [{"t": 0, "scale": 1.0}, {"t": 0.18, "scale": 1.25},
                                    {"t": 0.5, "scale": 1.25}, {"t": 1, "scale": 1.25}]},
    "pan_lr":       {"keyframes": [{"t": 0, "scale": 1.15, "x": -0.06},
                                    {"t": 1, "scale": 1.15, "x": 0.06}]},
    "pan_rl":       {"keyframes": [{"t": 0, "scale": 1.15, "x": 0.06},
                                    {"t": 1, "scale": 1.15, "x": -0.06}]},
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


def parse_transform(raw: str) -> dict | None:
    """Resolve clip.transform_json (preset name or keyframes) to keyframe form."""
    if not raw or not raw.strip():
        return None
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return _TRANSFORM_PRESETS.get(raw.strip())   # bare preset name
    if isinstance(data, dict) and data.get("preset"):
        base = _TRANSFORM_PRESETS.get(data["preset"])
        return base
    if isinstance(data, dict) and data.get("keyframes"):
        return data
    return None


async def _transform_pass(src: Path, out: Path, transform: dict,
                          dur_sec: float, fps: float, w: int, h: int) -> None:
    """
    Apply animated zoom/pan/shake to a pre-rendered segment.

    Upscales 2x first so zoompan's integer sampling doesn't shimmer, then
    drives zoom/x/y with piecewise-linear expressions per output frame.
    """
    n = max(1, round(dur_sec * fps))
    kfs = sorted(transform.get("keyframes", []), key=lambda k: k.get("t", 0))
    if not kfs:
        kfs = [{"t": 0, "scale": 1.0}]
    z_pts  = [(k.get("t", 0) * n, max(1.0, float(k.get("scale", 1.0)))) for k in kfs]
    px_pts = [(k.get("t", 0) * n, float(k.get("x", 0.0))) for k in kfs]
    py_pts = [(k.get("t", 0) * n, float(k.get("y", 0.0))) for k in kfs]
    z_expr  = _piecewise_expr(z_pts)
    px_expr = _piecewise_expr(px_pts)
    py_expr = _piecewise_expr(py_pts)

    shake = transform.get("shake")
    sx = sy = "0"
    if shake:
        amp = float(shake.get("amp", 12)) * 2   # 2x-upscaled pixels
        decay = float(shake.get("decay", 1.0))
        # decaying pseudo-random jitter (two incommensurate sines)
        env = f"exp(-{decay:.3f}*on/{max(1, n):.1f}*4)"
        sx = f"({amp:.1f}*{env}*sin(on*12.9898))"
        sy = f"({amp:.1f}*{env}*cos(on*78.233))"

    # zoompan: x/y are the crop origin in (upscaled) input pixels
    x_expr = f"(iw-iw/zoom)/2+({px_expr})*iw+{sx}"
    y_expr = f"(ih-ih/zoom)/2+({py_expr})*ih+{sy}"
    vf = (
        f"scale={w * 2}:{h * 2}:flags=lanczos,"
        f"zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}'"
        f":d=1:s={w}x{h}:fps={fps}"
    )
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
                        w: int, h: int) -> None:
    """
    Composite one overlay segment onto the base video at its timeline position.

    blend 'normal' uses alpha overlay (transparent MGs float over footage);
    'screen'/'add'/'multiply' use the blend filter (MAD staples for light FX).
    Frames outside [start, start+dur] pass through unchanged.
    """
    end_sec = start_sec + dur_sec
    enable = f"between(t,{start_sec:.6f},{end_sec:.6f})"
    if blend in ("screen", "add", "multiply"):
        # blend needs equal-length streams → pad the overlay to the base span.
        fc = (
            f"[1:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,format=gbrp,"
            f"tpad=start_duration={start_sec:.6f}:start_mode=add:color=black,"
            f"tpad=stop_duration=3600:stop_mode=add:color=black[ov];"
            f"[0:v]format=gbrp[b];"
            f"[b][ov]blend=all_mode={blend}:all_opacity={opacity:.3f}:shortest=1:enable='{enable}',format=yuv420p[v]"
        )
    else:
        # alpha overlay; opacity scales the overlay's alpha channel
        fc = (
            f"[1:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
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
        "-c:v", "libx264", "-crf", "21", "-preset", "fast",
        "-an",
        str(out),
    ]
    await _run(cmd)


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
        "-vn", "-c:a", "aac", "-b:a", "192k",
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
            "-map", "[outa]", "-c:a", "aac", "-b:a", "192k",
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
        "-c:a", "aac", "-b:a", "192k",
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
) -> Path:
    """
    Render the timeline to an MP4 file.
    Returns the output file path.
    """
    tmp_root = Path(tempfile.mkdtemp(prefix=f"kychapogas_render_{job_id}_"))

    try:
        asset_map = {a.id: a for a in assets}

        # ── Identify tracks ───────────────────────────────────────────────────
        # First video track (by order) is the BASE; further video tracks are
        # OVERLAYS composited on top (alpha/blend), in track order.
        video_tracks = sorted([t for t in tracks if t.track_type == "video"],
                              key=lambda t: t.order)
        audio_tracks = [t for t in tracks if t.track_type == "audio"]

        v_track = video_tracks[0] if video_tracks else None
        a_track = audio_tracks[0] if audio_tracks else None
        overlay_tracks = video_tracks[1:]

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
            asset = asset_map.get(clip.asset_id)
            if asset and Path(asset.file_path).exists():
                seg_file = tmp_root / f"seg_{n:04d}.mp4"
                # Still images (freeze-frames / placeholders) loop for the clip
                # duration; videos are extracted with speed remap.
                is_image = (asset.asset_type == "image"
                            or (asset.asset_type == "generated" and asset.duration_sec is None))
                if is_image:
                    await _image_segment(asset.file_path, seg_file, clip_dur,
                                         width, height, fps)
                else:
                    await _extract_segment(
                        asset.file_path, seg_file,
                        clip.asset_in_frame / fps,
                        clip_dur,
                        width, height, fps,
                        speed=getattr(clip, "speed", 1.0) or 1.0,
                        ease=getattr(clip, "speed_ease", "linear") or "linear",
                    )
                # Animated zoom/pan/shake (transform keyframes)
                tr = parse_transform(getattr(clip, "transform_json", "") or "")
                if tr:
                    tr_file = tmp_root / f"seg_{n:04d}_tr.mp4"
                    await _transform_pass(seg_file, tr_file, tr, clip_dur, fps, width, height)
                    seg_file = tr_file
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
        # Each overlay clip is extracted, then composited onto the running base
        # at its timeline position with its opacity/blend. Transparent MGs
        # (alpha .mov) float over the footage — 歌詞テロップ etc.
        for oi, (t_idx, oc) in enumerate(o_clips):
            asset = asset_map.get(oc.asset_id)
            if not asset or not Path(asset.file_path).exists():
                continue
            oc_dur = oc.duration_frames / fps
            oseg = tmp_root / f"ovseg_{oi:04d}.mov"   # mov preserves alpha
            is_image = (asset.asset_type == "image"
                        or (asset.asset_type == "generated" and asset.duration_sec is None))
            if is_image:
                await _image_segment(asset.file_path, oseg, oc_dur, width, height, fps,
                                     keep_alpha=True)
            else:
                await _extract_segment(
                    asset.file_path, oseg,
                    oc.asset_in_frame / fps, oc_dur,
                    width, height, fps,
                    speed=getattr(oc, "speed", 1.0) or 1.0,
                    ease=getattr(oc, "speed_ease", "linear") or "linear",
                    keep_alpha=True,
                )
            merged_out = tmp_root / f"ovbase_{oi:04d}.mp4"
            await _overlay_pass(
                video_only, oseg, merged_out,
                start_sec=oc.start_frame / fps, dur_sec=oc_dur,
                opacity=max(0.0, min(1.0, getattr(oc, "opacity", 1.0) or 1.0)),
                blend=(getattr(oc, "blend", "normal") or "normal"),
                w=width, h=height,
            )
            video_only = merged_out

        if progress_cb:
            progress_cb(0.78)

        # ── Audio segments ────────────────────────────────────────────────────
        audio_segs: list[Path] = []
        for i, clip in enumerate(a_clips):
            asset = asset_map.get(clip.asset_id)
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
