#!/usr/bin/env python3
"""
Import a mad-kit shotlist into KyChaPoGaS as a real project:

  * project (fps=60) + "MAD Shots" video track + "Music" audio track
  * one clip per shot, backed by a per-shot proxy video asset (so the
    existing timeline UI can scrub/play it)
  * the song as an audio asset/clip
  * data/mad/<project_id>.json  → {shotlist_path, shot_map} so tools can map
    timeline clips back to shotlist entries (UI/LLM edits round-trip)

Usage:
  import_to_app.py --project-dir outputs/mad-build --shotlist shotlist_2026.json
"""
import argparse
import asyncio
import json
import shutil
import subprocess
import sys
from pathlib import Path

KIT_DIR = Path(__file__).resolve().parent
BACKEND = KIT_DIR.parent.parent / "backend"
sys.path.insert(0, str(BACKEND))

from build import build_html  # noqa: E402

PROXY_W, PROXY_H, PROXY_FPS = 640, 360, 30


def T_of(v, db):
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and v.startswith("db:"):
        f = float(v[3:])
        i, fr = int(f), f - int(f)
        base = db[min(i, len(db) - 1)]
        if fr and i + 1 < len(db):
            base += (db[i + 1] - db[i]) * fr
        return base
    return float(v)


async def render_shot_proxies(project_dir: Path, shotlist_path: Path, out_dir: Path):
    from app.services.motion_graphics import render_html_to_video
    shotlist = json.loads(shotlist_path.read_text())
    grid = json.loads((project_dir / "beatgrid.json").read_text())
    db = grid["downbeats"]
    out_dir.mkdir(parents=True, exist_ok=True)
    spans = []
    for shot in shotlist["shots"]:
        t0, t1 = T_of(shot["from"], db), T_of(shot["to"], db)
        end = float(shotlist["meta"].get("end_sec") or grid["duration"])
        t1 = min(t1, end)
        out = out_dir / f"shot_{shot['id']}.mp4"
        spans.append((shot["id"], t0, t1, out))
        if out.exists():
            continue
        html, *_ = build_html(project_dir, shotlist_path, offset=t0)
        await render_html_to_video(html, out, duration_sec=t1 - t0,
                                   fps=PROXY_FPS, width=PROXY_W, height=PROXY_H)
        print(f"  proxy {shot['id']}  {t1 - t0:.2f}s")
    return spans, shotlist, grid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project-dir", required=True)
    ap.add_argument("--shotlist", required=True)
    ap.add_argument("--name", default=None)
    a = ap.parse_args()
    project_dir = Path(a.project_dir).resolve()
    shotlist_path = (project_dir / a.shotlist) if not Path(a.shotlist).is_absolute() else Path(a.shotlist)

    proxies = project_dir / "shot_proxies"
    spans, shotlist, grid = asyncio.run(render_shot_proxies(project_dir, shotlist_path, proxies))

    # ---- register in the app DB ----
    from sqlmodel import Session, select
    from app.db.database import engine
    from app.models.project import Project
    from app.models.track import Track
    from app.models.asset import Asset
    from app.models.clip import Clip

    name = a.name or shotlist["meta"].get("title", "mad-kit import")
    fps = 60
    with Session(engine) as s:
        existing = s.exec(select(Project).where(Project.name == name)).first()
        if existing:
            print(f"project '{name}' already exists (id={existing.id}) — aborting to avoid duplicates")
            sys.exit(1)
        proj = Project(name=name, fps=fps, width=1920, height=1080)
        s.add(proj); s.commit(); s.refresh(proj)

        vtrack = Track(project_id=proj.id, name="MAD Shots", track_type="video", order=0)
        atrack = Track(project_id=proj.id, name="Music", track_type="audio", order=1)
        s.add(vtrack); s.add(atrack); s.commit(); s.refresh(vtrack); s.refresh(atrack)

        asset_dir = BACKEND / "data" / "assets" / str(proj.id)
        asset_dir.mkdir(parents=True, exist_ok=True)

        # music
        music_src = project_dir / shotlist["meta"]["music"]
        music_dst = asset_dir / music_src.name
        shutil.copy2(music_src, music_dst)
        end_sec = float(shotlist["meta"].get("end_sec") or grid["duration"])
        m_asset = Asset(project_id=proj.id, name="theme song", asset_type="audio",
                        file_path=str(music_dst), duration_sec=grid["duration"])
        s.add(m_asset); s.commit(); s.refresh(m_asset)
        s.add(Clip(track_id=atrack.id, asset_id=m_asset.id, start_frame=0,
                   duration_frames=round(end_sec * fps), fade_out_frames=round(1.2 * fps)))

        shot_map = {}
        for shot_id, t0, t1, path in spans:
            dst = asset_dir / path.name
            shutil.copy2(path, dst)
            asset = Asset(project_id=proj.id, name=f"shot:{shot_id}", asset_type="generated",
                          file_path=str(dst), duration_sec=t1 - t0,
                          width=PROXY_W, height=PROXY_H)
            s.add(asset); s.commit(); s.refresh(asset)
            clip = Clip(track_id=vtrack.id, asset_id=asset.id,
                        start_frame=round(t0 * fps), duration_frames=max(1, round((t1 - t0) * fps)),
                        kind="mg_shot", attrs_json=json.dumps({"shot_id": shot_id}))
            s.add(clip); s.commit(); s.refresh(clip)
            shot_map[shot_id] = {"clip_id": clip.id, "asset_id": asset.id,
                                 "t0": round(t0, 3), "t1": round(t1, 3)}
        s.commit()

        mad_dir = BACKEND / "data" / "mad"
        mad_dir.mkdir(exist_ok=True)
        (mad_dir / f"{proj.id}.json").write_text(json.dumps({
            "project_id": proj.id, "shotlist_path": str(shotlist_path),
            "project_dir": str(project_dir), "shot_map": shot_map}, ensure_ascii=False, indent=1))
        print(f"imported: project id={proj.id} '{name}'  shots={len(shot_map)}")


if __name__ == "__main__":
    main()
