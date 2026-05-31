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


async def _extract_segment(src: str, out: Path, in_sec: float,
                            dur_sec: float, w: int, h: int, fps: float) -> None:
    """Extract and re-encode a clip segment to uniform resolution/fps."""
    cmd = [
        FFMPEG, "-y",
        "-ss", str(in_sec),
        "-t",  str(dur_sec),
        "-i",  src,
        "-vf", f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
               f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={fps}",
        "-c:v", "libx264", "-crf", "23", "-preset", "fast",
        "-an",               # strip audio here; mixed separately
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
    """Concatenate pre-encoded segments via FFmpeg concat demuxer."""
    list_file = out.parent / f"{out.stem}_concat.txt"
    with open(list_file, "w", encoding="utf-8") as f:
        for seg in segment_files:
            # FFmpeg requires forward slashes in concat lists
            f.write(f"file '{seg.as_posix()}'\n")
    cmd = [
        FFMPEG, "-y",
        "-f", "concat", "-safe", "0",
        "-i", str(list_file),
        "-c", "copy",
        str(out),
    ]
    await _run(cmd, progress_cb)
    list_file.unlink(missing_ok=True)


async def _extract_audio_segment(src: str, out: Path,
                                  in_sec: float, dur_sec: float,
                                  timeline_start: float) -> None:
    """Extract audio, pad with silence to match timeline position."""
    # First extract the clip audio
    raw = out.parent / f"{out.stem}_raw.aac"
    cmd = [
        FFMPEG, "-y",
        "-ss", str(in_sec), "-t", str(dur_sec),
        "-i", src,
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
        audio_map = "[1:a]"
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
        segs: list[Path] = []
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
                segs.append(gap_file)
                n += 1

            # Clip segment
            asset = asset_map.get(clip.asset_id)
            if asset and Path(asset.file_path).exists():
                seg_file = tmp_root / f"seg_{n:04d}.mp4"
                await _extract_segment(
                    asset.file_path, seg_file,
                    clip.asset_in_frame / fps,
                    clip.duration_frames / fps,
                    width, height, fps,
                )
                segs.append(seg_file)
            else:
                # Missing asset → black placeholder
                gap_file = tmp_root / f"missing_{n:04d}.mp4"
                await _black_segment(gap_file, clip.duration_frames / fps, width, height, fps)
                segs.append(gap_file)
            n += 1
            current_frame = clip.start_frame + clip.duration_frames

            if progress_cb:
                progress_cb(0.05 + 0.55 * (current_frame / total_frames))

        # Trailing gap if needed
        if not v_clips:
            # Pure audio project — generate silent black video
            blank = tmp_root / "blank.mp4"
            await _black_segment(blank, total_dur, width, height, fps)
            segs = [blank]

        # ── Concat video ──────────────────────────────────────────────────────
        video_only = tmp_root / "video_only.mp4"
        if len(segs) == 1:
            shutil.copy(segs[0], video_only)
        else:
            await _concat(segs, video_only,
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
