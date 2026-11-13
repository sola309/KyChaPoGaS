#!/usr/bin/env python
"""comp-kit の描画テスト。

自前の小さなサーバ(comp-kit と mg-libs を /api/comps/engine/ に平らに並べる)を空きポートで立て、
player.html に例の JSON を埋めてヘッドレス Chromium で描く。

  render_test.py examples/01_kinetic_type.json --frames 0,12,48 --out /tmp/x
  render_test.py examples/01_kinetic_type.json --video /tmp/x/out.mov
  render_test.py examples/01_kinetic_type.json --frames 12 --out /tmp/x --mode preview   # プレビュー経路で描く

サーバは読むだけ:
  /api/comps/engine/<file>     comp-kit → mg-libs の順に探す
  /api/comps/<id>              examples/*.json のうち id が合うもの(入れ子の確認用)
  /api/comps/vframe/<a>/<n>    本番の素材ファイルから ffmpeg で 1 コマ切り出す(本番 API の代わり)
  /api/assets/...              本番バックエンド(既定 http://127.0.0.1:8002)へ GET を中継
  /preview/<example>.json      プレビュー用のページ
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import http.server
import json
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
REPO = KIT.parent.parent
LIBS = REPO / "tools" / "mg-libs"
BACKEND = "http://127.0.0.1:8002"
sys.path.insert(0, str(REPO / "backend"))

MIME = {".js": "text/javascript", ".html": "text/html; charset=utf-8", ".json": "application/json",
        ".png": "image/png", ".jpg": "image/jpeg", ".glb": "model/gltf-binary", ".mp4": "video/mp4", ".webm": "video/webm"}
CHROME_ARGS = ["--force-color-profile=srgb", "--use-gl=angle", "--use-angle=swiftshader",
               "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
EXTRA_DIR = KIT / "examples"  # 例の JSON を置いた場所(examples の外の JSON を渡したとき用)
_vframe_dir = Path(tempfile.mkdtemp(prefix="compkit_vframe_"))


def build_html(comp: dict, mode: str, api_base: str) -> str:
    boot = {"comp": comp, "mode": mode, "apiBase": api_base, "engineBase": "/api/comps/engine/"}
    html = (KIT / "player.html").read_text(encoding="utf-8")
    assert "/*__COMP_BOOT__*/" in html
    return html.replace("/*__COMP_BOOT__*/", "window.__COMP_BOOT = " + json.dumps(boot, ensure_ascii=False) + ";")


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # 静かに
        pass

    def _send(self, code: int, body: bytes, ctype: str = "application/octet-stream"):
        # Range つきの要求には 206 で返す(<video> のシークに要る)
        rng = self.headers.get("Range") if code == 200 else None
        total = len(body)
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].partition("-")
            start = int(a or 0)
            end = min(int(b) if b else total - 1, total - 1)
            body = body[start:end + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        else:
            self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            self._get()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            self._send(500, str(e).encode())

    def _get(self):
        path, _, query = self.path.partition("?")
        if path.startswith("/api/comps/engine/"):
            name = path.rsplit("/", 1)[1]
            for d in (KIT, LIBS, EXTRA_DIR):
                f = d / name
                if f.is_file():
                    return self._send(200, f.read_bytes(), MIME.get(f.suffix, "application/octet-stream"))
            return self._send(404, b"not found")
        if path.startswith("/api/comps/vframe/"):
            _, _, _, _, aid, n = path.split("/")
            fps = float(dict(q.split("=") for q in query.split("&") if "=" in q).get("fps", 30))
            return self._vframe(int(aid), int(n), fps)
        if path.startswith("/api/comps/"):
            cid = path.rsplit("/", 1)[1]
            for f in sorted([*(KIT / "examples").glob("*.json"), *EXTRA_DIR.glob("*.json")]):
                c = json.loads(f.read_text(encoding="utf-8"))
                if str(c.get("id")) == cid:
                    return self._send(200, json.dumps(c).encode(), MIME[".json"])
            return self._send(404, b"{}", MIME[".json"])
        if path.startswith("/preview/"):
            f = KIT / "examples" / path.rsplit("/", 1)[1]
            if not f.is_file():
                f = EXTRA_DIR / f.name
            comp = json.loads(f.read_text(encoding="utf-8"))
            return self._send(200, build_html(comp, "preview", "").encode(), MIME[".html"])
        if path.startswith("/api/assets/"):
            # 本番へは GET の中継だけ(Range も通す。動画のシークに要る)
            req = urllib.request.Request(BACKEND + self.path)
            if self.headers.get("Range"):
                req.add_header("Range", self.headers["Range"])
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    body = r.read()
                    self.send_response(r.status)
                    for h in ("Content-Type", "Content-Range", "Accept-Ranges"):
                        if r.headers.get(h):
                            self.send_header(h, r.headers[h])
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(body)
            except urllib.error.HTTPError as e:
                self._send(e.code, b"")
            return
        self._send(404, b"not found")

    def _vframe(self, aid: int, n: int, fps: float):
        out = _vframe_dir / f"{aid}_{fps}_{n}.png"
        if not out.exists():
            import imageio_ffmpeg
            meta = json.loads(urllib.request.urlopen(f"{BACKEND}/api/assets/{aid}", timeout=10).read())
            cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-y", "-ss", f"{n / fps:.6f}", "-i", meta["file_path"],
                   "-frames:v", "1", str(out)]
            subprocess.run(cmd, check=False, timeout=60)
        if not out.exists():
            return self._send(404, b"")
        self._send(200, out.read_bytes(), "image/png")


def start_server() -> tuple[http.server.ThreadingHTTPServer, str]:
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


async def render_frames(comp: dict, frames: list[int], out: Path, base: str, mode: str, example: str, tag: str):
    from playwright.async_api import async_playwright
    out.mkdir(parents=True, exist_ok=True)
    stats = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=CHROME_ARGS)
        page = await browser.new_page(viewport={"width": comp["width"], "height": comp["height"]}, device_scale_factor=1)
        page.on("console", lambda m: print(f"  [console.{m.type}] {m.text}") if m.type in ("warning", "error") else None)
        page.on("pageerror", lambda e: print(f"  [pageerror] {e}"))
        grab = "() => document.querySelector('canvas').toDataURL('image/png')"
        if mode == "capture":
            await page.set_content(build_html(comp, "capture", base), wait_until="load")
            await page.evaluate("window.__madAssetsReady || 0")
        for f in frames:
            t0 = time.perf_counter()
            if mode == "capture":
                await page.evaluate("(t) => window.seek(t)", f / comp["fps"] * 1000.0)
            else:
                # プレビュー経路: ページを URL で開き、capture と同じ「素材がそろうまで待つ」だけ足す
                await page.goto(f"{base}/preview/{example}?frame={f}&scale=1", wait_until="load")
                await page.evaluate("window.__madAssetsReady")
                await page.evaluate(
                    "async (f) => { const e = window.__compEngine; for (let i = 0; i < 200; i++) {"
                    " e.env.pending.length = 0; e.scene.prepare(f, ['x']); if (!e.env.pending.length) break;"
                    " await Promise.all(e.env.pending.slice()); } await e.renderFrame(f); }", f)
            t1 = time.perf_counter()
            durl = await page.evaluate(grab)
            name = out / f"{tag}_{f:04d}.png"
            name.write_bytes(base64.b64decode(durl.split(",", 1)[1]))
            stats.append((f, (t1 - t0) * 1000))
            print(f"  frame {f}: {(t1 - t0) * 1000:.0f} ms → {name}")
        await browser.close()
    return stats


async def render_video(comp: dict, out: Path, base: str):
    from app.services.motion_graphics import render_html_to_video
    transparent = comp["data"].get("bg") is None
    t0 = time.perf_counter()
    await render_html_to_video(build_html(comp, "capture", base), out, comp["duration_frames"] / comp["fps"],
                               fps=comp["fps"], width=comp["width"], height=comp["height"],
                               transparent=transparent, capture="canvas")
    dt = time.perf_counter() - t0
    print(f"  video: {comp['duration_frames']} frames in {dt:.1f}s ({dt / comp['duration_frames'] * 1000:.0f} ms/frame wall) → {out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("example")
    ap.add_argument("--frames", default="")
    ap.add_argument("--out", default="/tmp/claude-1000/comp-kit-work/out")
    ap.add_argument("--video", default="")
    ap.add_argument("--mode", default="capture", choices=["capture", "preview"])
    ap.add_argument("--tag", default="")
    ap.add_argument("--serve", action="store_true", help="サーバだけ立てて待つ(手で確認する用)")
    a = ap.parse_args()
    ex = Path(a.example)
    if not ex.is_file():
        ex = KIT / a.example
    comp = json.loads(ex.read_text(encoding="utf-8"))
    global EXTRA_DIR
    EXTRA_DIR = ex.resolve().parent
    srv, base = start_server()
    try:
        if a.serve:
            print(f"{base}/preview/{ex.name}")
            threading.Event().wait()
        if a.frames:
            frames = [int(x) for x in a.frames.split(",") if x.strip() != ""]
            tag = a.tag or (ex.stem + ("_pv" if a.mode == "preview" else ""))
            asyncio.run(render_frames(comp, frames, Path(a.out), base, a.mode, ex.name, tag))
        if a.video:
            asyncio.run(render_video(comp, Path(a.video), base))
    finally:
        srv.shutdown()


if __name__ == "__main__":
    main()
