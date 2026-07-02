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
import json
import logging
import os
import tempfile
from pathlib import Path

import imageio_ffmpeg

log = logging.getLogger("motion_graphics")

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

_SEEK_JS = """
async (t) => {
  document.getAnimations().forEach(a => {
    try { a.pause(); a.currentTime = t; } catch (e) {}
  });
  if (typeof window.seek === 'function') {
    // window.seek may return a Promise (e.g. mad-kit waiting on <video> 'seeked'
    // events) — await it so every frame is captured fully settled.
    try { const r = window.seek(t); if (r && typeof r.then === 'function') await r; } catch (e) {}
  }
}
"""


async def render_html_to_video(
    html: str,
    out: Path,
    duration_sec: float,
    fps: float = 30.0,
    width: int = 1280,
    height: int = 720,
    transparent: bool = False,
    inject_data: dict | None = None,
    capture: str = "page",       # "page" (DOM screenshot) | "canvas" (WebGL toDataURL)
    progress_cb=None,
) -> Path:
    """Render an HTML animation to a video file. Returns `out`.

    transparent=True keeps the page background alpha (don't set a body
    background in the HTML) and encodes qtrle .mov — for overlay tracks
    (歌詞テロップ, frames, particles over footage).

    inject_data is exposed to the page as `window.kycha` BEFORE any page script
    runs — data-driven MGs read beats/bpm/lyrics/duration from it (e.g. a
    visualizer that pulses exactly on the song's real beats).
    """
    from playwright.async_api import async_playwright

    n_frames = max(1, round(duration_sec * fps))
    out.parent.mkdir(parents=True, exist_ok=True)

    # window.kycha injected into the HTML head BEFORE the page's own scripts.
    page_html = html
    if inject_data is not None:
        tag = (f"<script>window.kycha = "
               f"{json.dumps(inject_data, ensure_ascii=False)};</script>")
        if "<head>" in page_html:
            page_html = page_html.replace("<head>", "<head>" + tag, 1)
        elif "<body>" in page_html:
            page_html = page_html.replace("<body>", "<body>" + tag, 1)
        else:
            page_html = tag + page_html

    # Parallel frame capture: every frame is an INDEPENDENT deterministic seek, so
    # split the range across N headless pages (each its own renderer process) → uses
    # all cores. Frames are written as PNG files (frame_%06d.png) then encoded once.
    # (The old single-page → stdin pipe was strictly serial and the render bottleneck.)
    workers = max(1, min(8, (os.cpu_count() or 4) - 1))
    if n_frames < 2 * workers:
        workers = 1
    frame_dir = Path(tempfile.mkdtemp(prefix="mg_frames_"))
    done = [0]

    async def capture(p, idxs):
        # one INDEPENDENT browser process per worker → true multi-core (pages inside
        # a single browser share a compositor/IPC and barely parallelise).
        browser = await p.chromium.launch(args=[
            "--force-color-profile=srgb",
            # WebGL (Pixi/Three/shaders) in headless → SwiftShader software GL:
            # deterministic (no GPU nondeterminism) and works on aarch64/GB10.
            "--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
        ])
        try:
            page = await browser.new_page(viewport={"width": width, "height": height},
                                          device_scale_factor=1)
            await page.set_content(page_html, wait_until="load")
            await page.evaluate("document.fonts ? document.fonts.ready : null")
            # wait for ALL <img> (data-URL layers etc.) to finish decoding so the
            # very first captured frame already has the imagery.
            await page.evaluate(
                "Promise.all([...document.images].map(im => im.complete ? 0 : "
                "new Promise(r => { im.onload = im.onerror = r; })))")
            import base64 as _b64
            for i in idxs:
                await page.evaluate(_SEEK_JS, (i / fps) * 1000.0)
                if capture == "canvas":
                    # read the WebGL/2D canvas framebuffer directly — reliable for
                    # WebGL (page.screenshot can hang/blacken on GL canvases) and fast.
                    durl = await page.evaluate(
                        "() => { const c = document.querySelector('canvas');"
                        " return c ? c.toDataURL('image/png') : null; }")
                    (frame_dir / f"frame_{i:06d}.png").write_bytes(_b64.b64decode(durl.split(",", 1)[1]))
                else:
                    await page.screenshot(path=str(frame_dir / f"frame_{i:06d}.png"),
                                          type="png", omit_background=transparent)
                done[0] += 1
                if progress_cb and done[0] % 10 == 0:
                    progress_cb(done[0] / n_frames)
        finally:
            await browser.close()

    try:
        async with async_playwright() as p:
            chunks = [list(range(w, n_frames, workers)) for w in range(workers)]
            await asyncio.gather(*(capture(p, ch) for ch in chunks))

        # encode the PNG sequence in order
        if transparent:
            codec = ["-c:v", "qtrle"]                          # alpha .mov
            vf = ["-vf", "format=rgba"]
        else:
            codec = ["-c:v", "libx264", "-crf", "16", "-preset", "veryfast",
                     "-pix_fmt", "yuv420p", "-profile:v", "high"]
            vf = []
        cmd = [FFMPEG, "-y", "-framerate", str(fps),
               "-i", str(frame_dir / "frame_%06d.png"), *vf, *codec, str(out)]
        enc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _, stderr = await enc.communicate()
        if enc.returncode != 0:
            raise RuntimeError("FFmpeg encode failed:\n" + stderr.decode(errors="replace")[-2000:])
    finally:
        import shutil as _sh
        _sh.rmtree(frame_dir, ignore_errors=True)

    log.info(f"Motion graphics rendered: {out.name} ({n_frames}f @ {fps}fps, {workers} workers)")
    return out
