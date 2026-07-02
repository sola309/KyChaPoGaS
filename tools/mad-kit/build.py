#!/usr/bin/env python3
"""
mad-kit build tool — shotlist(JSON) → rendered MAD video.

Usage (from repo/backend/.venv python):
  build.py render  --project <dir> --shotlist shotlist.json [--w 640 --h 360 --fps 12] [--out qa.mp4]
  build.py final   --project <dir> --shotlist shotlist.json         # 1080p60 + music mux + beat check
  build.py check   --project <dir> --shotlist shotlist.json         # validate JSON only

The project dir must contain: assets/ (png/jpg by name), beatgrid.json,
and the music file referenced by shotlist meta.music.
Fonts are loaded from <project>/fonts or this directory's fonts/.
"""
import argparse
import asyncio
import base64
import json
import subprocess
import sys
from pathlib import Path

KIT_DIR = Path(__file__).resolve().parent
REPO_BACKEND = KIT_DIR.parent.parent / "backend"
sys.path.insert(0, str(REPO_BACKEND))

FONTS = [("MPR", "MPLUSRounded1c-Black.ttf"),
         ("Mochiy", "MochiyPopOne-Regular.ttf"),
         ("Yusei", "YuseiMagic-Regular.ttf")]


def b64(p: Path, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode()


def build_html(project: Path, shotlist_path: Path, offset: float = 0.0,
               asset_url_prefix: str | None = None, live: bool = False) -> tuple[str, dict, dict]:
    """Assemble the scene HTML.

    asset_url_prefix=None  → embed assets/fonts as data URLs (headless render).
    asset_url_prefix="..." → reference assets over HTTP (live Shot Editor;
                             tiny page, browser caches the images).
    """
    shotlist = json.loads(shotlist_path.read_text())
    grid = json.loads((project / "beatgrid.json").read_text())
    tpl = (KIT_DIR / "template.html").read_text()

    fonts_css = ""
    for fam, fn in FONTS:
        for base in (project / "fonts", KIT_DIR / "fonts"):
            if (base / fn).exists():
                src = (f"{asset_url_prefix}font/{fn}" if asset_url_prefix
                       else b64(base / fn, "font/ttf"))
                fonts_css += (f"@font-face {{ font-family:'{fam}'; "
                              f"src:url({src}) format('truetype'); }}\n")
                break

    assets = {}
    video_assets = []
    for f in sorted((project / "assets").iterdir()):
        if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".mp4", ".webm"):
            mime = {"png": "image/png", "mp4": "video/mp4", "webm": "video/webm"}.get(f.suffix[1:].lower(), "image/jpeg")
            assets[f.stem] = (f"{asset_url_prefix}asset/{f.name}" if asset_url_prefix
                              else b64(f, mime))
            if f.suffix.lower() in (".mp4", ".webm"):
                video_assets.append(f.stem)

    kycha = {"bpm": grid["bpm"], "duration": grid["duration"], "beats": grid["beats"],
             "downbeats": grid["downbeats"], "assets": assets, "shotlist": shotlist,
             "offset": offset, "live": live, "videoAssets": video_assets}
    live_js = (KIT_DIR / "mad-kit-live.js").read_text() if live else ""
    html = (tpl.replace("/*FONTS*/", fonts_css)
               .replace("/*KYCHA*/", "window.kycha = " + json.dumps(kycha) + ";")
               .replace("/*KIT*/", (KIT_DIR / "mad-kit.js").read_text())
               .replace("/*SCENES*/", (KIT_DIR / "mad-kit-scenes.js").read_text() + "\n" + live_js))
    return html, shotlist, grid


def check(shotlist: dict) -> list[str]:
    """Cheap validation with LLM-friendly error messages."""
    errs = []
    known = ["mg_intro", "title_card", "showcase_pattern", "showcase_card", "showcase_fullbleed",
             "panels_strip", "bands_repeat", "cv_card", "rapid_cuts", "riser", "mg_peak",
             "profile_card", "breakdown_pan", "finale_cuts", "lineup", "outro_credits"]
    for i, s in enumerate(shotlist.get("shots", [])):
        where = f"shots[{i}] (id={s.get('id', '?')})"
        if s.get("template") not in known:
            errs.append(f"{where}: unknown template '{s.get('template')}'. Use one of: {', '.join(known)}")
        for k in ("from", "to"):
            v = s.get(k)
            if v is None:
                errs.append(f"{where}: missing '{k}' (seconds or 'db:<bar>')")
            elif isinstance(v, str) and not v.startswith("db:"):
                try:
                    float(v)
                except ValueError:
                    errs.append(f"{where}: bad time '{v}' — use a number or 'db:12'")
    return errs


async def render(project: Path, shotlist_path: Path, w: int, h: int, fps: float,
                 out: Path, duration: float | None):
    from app.services.motion_graphics import render_html_to_video
    html, shotlist, grid = build_html(project, shotlist_path)
    errs = check(shotlist)
    if errs:
        print("SHOTLIST ERRORS:\n" + "\n".join(errs))
        sys.exit(1)
    dur = duration or float(shotlist.get("meta", {}).get("end_sec") or grid["duration"])
    print(f"html {len(html)//1024} KB / {dur}s / {w}x{h}@{fps}")
    out.parent.mkdir(parents=True, exist_ok=True)
    await render_html_to_video(html, out, duration_sec=dur, fps=fps, width=w, height=h,
                               progress_cb=lambda p: print(f"  {p*100:.0f}%", flush=True))
    print("rendered:", out)
    return dur


def mux_and_verify(project: Path, shotlist_path: Path, video: Path, dur: float):
    shotlist = json.loads(shotlist_path.read_text())
    music = project / shotlist["meta"]["music"]
    title = shotlist["meta"].get("title", "final")
    # never overwrite finished pieces — auto-version _v1, _v2, ...
    n = 1
    while (project / f"{title}_v{n}.mp4").exists():
        n += 1
    out = project / f"{title}_v{n}.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(video), "-i", str(music),
                    "-filter_complex", f"[1:a]atrim=0:{dur},afade=t=out:st={dur-1.2}:d=1.2[a]",
                    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
                    "-movflags", "+faststart", str(out)], check=True)
    print("muxed:", out)
    # beat alignment
    import numpy as np
    from scenedetect import open_video, SceneManager
    from scenedetect.detectors import ContentDetector
    v = open_video(str(out)); m = SceneManager(); m.add_detector(ContentDetector(threshold=27.0))
    m.detect_scenes(v, show_progress=False)
    cuts = np.array([s.get_seconds() for s, e in m.get_scene_list()][1:])
    beats = np.array(json.loads((project / "beatgrid.json").read_text())["beats"])
    if len(cuts):
        d = np.abs(cuts[:, None] - beats[None, :]).min(axis=1)
        for tol in (0.05, 0.1):
            print(f"cut-beat alignment ±{int(tol*1000)}ms: {(d<=tol).mean()*100:.0f}% ({(d<=tol).sum()}/{len(cuts)})")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["render", "final", "check"])
    ap.add_argument("--project", required=True)
    ap.add_argument("--shotlist", required=True)
    ap.add_argument("--w", type=int, default=640)
    ap.add_argument("--h", type=int, default=360)
    ap.add_argument("--fps", type=float, default=12)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    project = Path(a.project).resolve()
    shotlist_path = project / a.shotlist if not Path(a.shotlist).is_absolute() else Path(a.shotlist)

    if a.cmd == "check":
        errs = check(json.loads(shotlist_path.read_text()))
        print("\n".join(errs) if errs else "OK")
        sys.exit(1 if errs else 0)
    if a.cmd == "render":
        out = Path(a.out) if a.out else project / "qa" / "qa_kit.mp4"
        asyncio.run(render(project, shotlist_path, a.w, a.h, a.fps, out, None))
    if a.cmd == "final":
        out = Path(a.out) if a.out else project / "final_kit.mp4"
        dur = asyncio.run(render(project, shotlist_path, 1920, 1080, 60, out, None))
        mux_and_verify(project, shotlist_path, out, dur)


if __name__ == "__main__":
    main()
