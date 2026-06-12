"""
Code-based motion graphics — render HTML/CSS/JS to a video clip.

A headless Chromium (Playwright) loads the given HTML and captures it frame by
frame DETERMINISTICALLY (no realtime screencast jitter):

  - CSS animations / transitions / Web Animations API:
      every animation's `currentTime` is set explicitly per frame via
      `document.getAnimations()` — frame-exact, no wall-clock involved.
  - Custom JS animations:
      if the page defines `window.seek(t_ms)`, it is called once per frame
      with the virtual time; drive any canvas/JS animation from it.

Frames are piped to FFmpeg and encoded as H.264 MP4 at the project fps, ready
to be placed on the timeline like any generated asset.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import imageio_ffmpeg

log = logging.getLogger("motion_graphics")

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

_SEEK_JS = """
(t) => {
  document.getAnimations().forEach(a => {
    try { a.pause(); a.currentTime = t; } catch (e) {}
  });
  if (typeof window.seek === 'function') { try { window.seek(t); } catch (e) {} }
}
"""


async def render_html_to_video(
    html: str,
    out: Path,
    duration_sec: float,
    fps: float = 30.0,
    width: int = 1280,
    height: int = 720,
    progress_cb=None,
) -> Path:
    """Render an HTML animation to an MP4 file. Returns `out`."""
    from playwright.async_api import async_playwright

    n_frames = max(1, round(duration_sec * fps))
    out.parent.mkdir(parents=True, exist_ok=True)

    # FFmpeg consumes raw PNG frames on stdin
    cmd = [
        FFMPEG, "-y",
        "-f", "image2pipe", "-framerate", str(fps), "-i", "-",
        "-vf", "format=yuv420p",
        "-c:v", "libx264", "-crf", "20", "-preset", "fast",
        str(out),
    ]
    ff = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(args=["--force-color-profile=srgb"])
            page = await browser.new_page(
                viewport={"width": width, "height": height},
                device_scale_factor=1,
            )
            await page.set_content(html, wait_until="load")
            # Give fonts a moment to settle (deterministic content otherwise)
            await page.evaluate("document.fonts ? document.fonts.ready : null")

            for i in range(n_frames):
                t_ms = (i / fps) * 1000.0
                await page.evaluate(_SEEK_JS, t_ms)
                png = await page.screenshot(type="png")
                ff.stdin.write(png)
                await ff.stdin.drain()
                if progress_cb and i % 10 == 0:
                    progress_cb(i / n_frames)

            await browser.close()
    finally:
        ff.stdin.close()
        _, stderr = await ff.communicate()
        if ff.returncode != 0:
            raise RuntimeError(
                "FFmpeg encode failed:\n" + stderr.decode(errors="replace")[-2000:]
            )

    log.info(f"Motion graphics rendered: {out.name} ({n_frames}f @ {fps}fps)")
    return out
