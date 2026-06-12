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


def _scale_pad_fps(w: int, h: int, fps: float) -> str:
    return (f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={fps}")


async def _extract_segment(src: str, out: Path, in_sec: float,
                           dur_sec: float, w: int, h: int, fps: float,
                           speed: float = 1.0, ease: str = "linear") -> None:
    """
    Extract a clip segment to uniform resolution/fps, applying a speed remap.

    dur_sec is the OUTPUT (timeline) duration; the segment consumes
    ``dur_sec * speed`` seconds of source. ease shapes accel/decel (bezier).
    """
    speed = max(0.05, float(speed))
    source_span = dur_sec * speed
    vf = _scale_pad_fps(w, h, fps)

    # Constant speed (linear) — single pass with setpts.
    if ease == "linear" or ease not in _EASE:
        cmd = [
            FFMPEG, "-y",
            "-ss", f"{in_sec:.6f}", "-t", f"{source_span:.6f}", "-i", src,
            "-vf", f"setpts=PTS/{speed:.6f},{vf}",
            "-c:v", "libx264", "-crf", "23", "-preset", "fast",
            "-an",
            str(out),
        ]
        await _run(cmd)
        return

    # Variable speed (accel/decel) — piecewise-constant approximation of the
    # bezier speed ramp: split into K sub-segments, each at its own setpts.
    x1, y1, x2, y2 = _EASE[ease]
    K = 12
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
            "-vf", f"setpts=PTS/{seg_speed:.6f},{vf}",
            "-c:v", "libx264", "-crf", "23", "-preset", "fast",
            "-an",
            str(part),
        ]
        await _run(cmd)
        parts.append(part)
    await _concat(parts, out)
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
                         w: int, h: int, fps: float) -> None:
    """Render a still image as a video segment of the given duration.
    (-ss/-t extraction on an image input yields a single frame, so stills
    need -loop 1 instead.)"""
    cmd = [
        FFMPEG, "-y",
        "-loop", "1", "-framerate", str(fps), "-t", f"{dur_sec:.6f}",
        "-i", src,
        "-vf", _scale_pad_fps(w, h, fps),
        "-c:v", "libx264", "-crf", "23", "-preset", "fast",
        "-pix_fmt", "yuv420p",
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

        # ── Identify primary tracks ───────────────────────────────────────────
        video_tracks = [t for t in tracks if t.track_type == "video"]
        audio_tracks = [t for t in tracks if t.track_type == "audio"]

        v_track = video_tracks[0] if video_tracks else None
        a_track = audio_tracks[0] if audio_tracks else None

        v_clips = sorted(
            [c for c in clips if v_track and c.track_id == v_track.id],
            key=lambda c: c.start_frame,
        )
        a_clips = sorted(
            [c for c in clips if a_track and c.track_id == a_track.id],
            key=lambda c: c.start_frame,
        )

        all_clips = v_clips + a_clips
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

        if progress_cb:
            progress_cb(0.75)

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
