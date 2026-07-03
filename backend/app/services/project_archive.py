"""
Project export / import — one portable ``.kycha.zip`` per project.

Design goals (in priority order):

1. **後方互換が壊れない**こと。アーカイブは ``format_version`` を持ち、読み込み側は
   ``MIGRATIONS`` で古い版を現行版へ段階変換してから取り込む。将来スキーマが変わったら
   「バージョンを +1 して migrate 関数を1つ足す」だけでよい。
2. **寛容な読み込み**。未知のフィールドは無視、欠損フィールドはモデルのデフォルトで補完、
   参照はDBの数値IDではなくアーカイブ内の相対参照(配列順・相対パス・shot_id文字列)で
   保持する — インポート時にIDはすべて振り直される。
3. **自己完結**。アセット実ファイル・コメント・mad-kitプロジェクト(shotlist/beatgrid/
   音源/素材)を同梱し、別マシンでも復元できる。再生成可能なもの(サムネ/プロキシ/QA)は
   含めない。

Archive layout::

    manifest.json          {format_version, app, exported_at, project, counts}
    timeline.json          {tracks:[{...,clips:[...]}]}   # clip.asset → assets配列のindex
    assets.json            [{...row..., file: "assets/0007_name.png"}]
    assets/                asset files
    comments.jsonl         (optional)
    oplog.jsonl            (optional, 編集履歴)
    mad/link.json          (optional) mad-kit link {shotlist, shot_map(shot_idのみ)}
    mad/project/...        (optional) shotlist.json / beatgrid.json / music / assets/
"""
from __future__ import annotations

import json
import logging
import shutil
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from sqlmodel import Session, select

from app.db.database import engine
from app.models import Project, Track, Clip, Asset
from app.models.oplog import OperationLog

log = logging.getLogger("project_archive")

FORMAT_VERSION = 1
BACKEND = Path(__file__).resolve().parent.parent.parent
DATA = BACKEND / "data"
EXPORTS = DATA / "exports"
MAD_DIR = DATA / "mad"

# 再生成可能・成果物系はアーカイブに含めない(mad/project 配下の除外パターン)
MAD_EXCLUDE = ("qa", "gen", "gen_v1", "assets_v1", "shot_proxies", "analysis", "analysis_v4",
               "analysis_v5", "cutouts", "scripts")


def _dump(row) -> dict:
    d = row.model_dump()
    d.pop("id", None)
    for k, v in list(d.items()):
        if isinstance(v, datetime):
            d[k] = v.isoformat()
    return d


# ── export ────────────────────────────────────────────────────────────────────

def export_project(pid: int, include_mad_media: bool = True) -> Path:
    with Session(engine) as s:
        proj = s.get(Project, pid)
        if not proj:
            raise ValueError(f"project {pid} not found")
        tracks = s.exec(select(Track).where(Track.project_id == pid).order_by(Track.order)).all()
        assets = s.exec(select(Asset).where(Asset.project_id == pid)).all()
        ops = s.exec(select(OperationLog).where(OperationLog.project_id == pid)).all()
        clips_by_track = {t.id: s.exec(select(Clip).where(Clip.track_id == t.id)).all() for t in tracks}

    asset_index = {a.id: i for i, a in enumerate(assets)}
    EXPORTS.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe = "".join(c for c in proj.name if c not in '\\/:*?"<>|')[:60] or f"project_{pid}"
    out = EXPORTS / f"{safe}_{stamp}.kycha.zip"

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        # assets (metadata + files)
        assets_meta = []
        for i, a in enumerate(assets):
            meta = _dump(a)
            src = Path(a.file_path)
            rel = None
            if src.exists():
                rel = f"assets/{i:04d}_{src.name}"
                z.write(src, rel)
            meta["file"] = rel
            meta.pop("file_path", None)
            meta.pop("proxy_path", None)          # 再生成可能
            assets_meta.append(meta)
        z.writestr("assets.json", json.dumps(assets_meta, ensure_ascii=False, indent=1))

        # timeline (clips reference assets by archive index)
        tl = []
        for t in tracks:
            td = _dump(t); td.pop("project_id", None)
            td["clips"] = []
            for c in clips_by_track[t.id]:
                cd = _dump(c)
                cd.pop("track_id", None)
                cd["asset_index"] = asset_index.get(c.asset_id)
                cd.pop("asset_id", None)
                td["clips"].append(cd)
            tl.append(td)
        z.writestr("timeline.json", json.dumps({"tracks": tl}, ensure_ascii=False, indent=1))

        # comments / oplog
        cpath = DATA / "comments" / f"{pid}.jsonl"
        if cpath.exists():
            z.write(cpath, "comments.jsonl")
        if ops:
            z.writestr("oplog.jsonl", "\n".join(json.dumps(_dump(o), ensure_ascii=False) for o in ops))

        # mad-kit link + project dir
        mad_link = MAD_DIR / f"{pid}.json"
        counts_mad = 0
        if mad_link.exists():
            m = json.loads(mad_link.read_text())
            z.writestr("mad/link.json", json.dumps({
                "shotlist_name": Path(m["shotlist_path"]).name,
                "shot_map": {sid: {k: v for k, v in e.items() if k in ("t0", "t1")}
                             for sid, e in m.get("shot_map", {}).items()},
            }, ensure_ascii=False, indent=1))
            pdir = Path(m["project_dir"])
            if include_mad_media and pdir.exists():
                for f in pdir.rglob("*"):
                    if not f.is_file():
                        continue
                    rel = f.relative_to(pdir)
                    if rel.parts[0] in MAD_EXCLUDE or f.suffix == ".mp4":
                        continue
                    z.write(f, f"mad/project/{rel}")
                    counts_mad += 1

        z.writestr("manifest.json", json.dumps({
            "format_version": FORMAT_VERSION,
            "app": "KyChaPoGaS",
            "exported_at": datetime.now().isoformat(timespec="seconds"),
            "project": _dump(proj),
            "counts": {"tracks": len(tracks), "assets": len(assets),
                       "clips": sum(len(v) for v in clips_by_track.values()),
                       "oplog": len(ops), "mad_files": counts_mad},
        }, ensure_ascii=False, indent=1))
    log.info(f"exported project {pid} → {out.name}")
    return out


# ── migrations ────────────────────────────────────────────────────────────────
# アーカイブ全体(dict of 解凍済みJSON)を受け取り、次バージョンの形に変換して返す。
# 例: format_version 2 で clip.speed_ease の名称が変わったら:
#   def _migrate_1_to_2(ar): ...; MIGRATIONS[1] = _migrate_1_to_2
MIGRATIONS: dict[int, Callable[[dict], dict]] = {}


def _migrate(ar: dict) -> dict:
    v = ar["manifest"].get("format_version", 1)
    while v < FORMAT_VERSION:
        if v not in MIGRATIONS:
            raise ValueError(f"format_version {v} からの移行手順がありません")
        ar = MIGRATIONS[v](ar)
        v += 1
        ar["manifest"]["format_version"] = v
    return ar


def _row_kwargs(model, data: dict) -> dict:
    """未知フィールドを落とし、欠損はモデルのデフォルトに任せ、ISO日時文字列は
    datetimeへ戻す(寛容な読み込み)。"""
    out = {}
    for k, f in model.model_fields.items():
        if k not in data:
            continue
        v = data[k]
        if isinstance(v, str) and "datetime" in str(f.annotation):
            try:
                v = datetime.fromisoformat(v)
            except ValueError:
                continue
        out[k] = v
    return out


# ── import ────────────────────────────────────────────────────────────────────

def import_project(zip_path: Path) -> int:
    with zipfile.ZipFile(zip_path) as z:
        names = set(z.namelist())
        ar: dict[str, Any] = {
            "manifest": json.loads(z.read("manifest.json")),
            "timeline": json.loads(z.read("timeline.json")),
            "assets": json.loads(z.read("assets.json")),
        }
        ar = _migrate(ar)

        with Session(engine) as s:
            pdata = _row_kwargs(Project, ar["manifest"]["project"])
            base = pdata.get("name") or "imported"
            name = base
            n = 2
            while s.exec(select(Project).where(Project.name == name)).first():
                name = f"{base} ({n})"; n += 1
            pdata["name"] = name
            proj = Project(**pdata)
            s.add(proj); s.commit(); s.refresh(proj)
            pid = proj.id

            # assets: files → data/assets/<pid>/, rows with new ids
            adir = DATA / "assets" / str(pid)
            adir.mkdir(parents=True, exist_ok=True)
            new_asset_ids: list[int | None] = []
            for meta in ar["assets"]:
                rel = meta.get("file")
                dest = None
                if rel and rel in names:
                    dest = adir / Path(rel).name.split("_", 1)[-1]
                    with z.open(rel) as fsrc, open(dest, "wb") as fdst:
                        shutil.copyfileobj(fsrc, fdst)
                kw = _row_kwargs(Asset, meta)
                kw["project_id"] = pid
                kw["file_path"] = str(dest) if dest else ""
                a = Asset(**kw)
                s.add(a); s.commit(); s.refresh(a)
                new_asset_ids.append(a.id)

            # tracks + clips
            shot_clip_map: dict[str, int] = {}
            for td in ar["timeline"]["tracks"]:
                kw = _row_kwargs(Track, td); kw["project_id"] = pid
                t = Track(**kw); s.add(t); s.commit(); s.refresh(t)
                for cd in td.get("clips", []):
                    ckw = _row_kwargs(Clip, cd)
                    ckw["track_id"] = t.id
                    ai = cd.get("asset_index")
                    ckw["asset_id"] = new_asset_ids[ai] if ai is not None and ai < len(new_asset_ids) else None
                    c = Clip(**ckw); s.add(c); s.commit(); s.refresh(c)
                    if c.kind == "mg_shot":
                        try:
                            sid = json.loads(c.attrs_json or "{}").get("shot_id")
                            if sid:
                                shot_clip_map[sid] = c.id
                        except Exception:
                            pass

        # comments
        if "comments.jsonl" in names:
            cdir = DATA / "comments"; cdir.mkdir(exist_ok=True)
            (cdir / f"{pid}.jsonl").write_bytes(z.read("comments.jsonl"))

        # mad project (self-contained restore under data/mad_projects/<pid>)
        if "mad/link.json" in names:
            link = json.loads(z.read("mad/link.json"))
            pdir = DATA / "mad_projects" / str(pid)
            for nm in names:
                if nm.startswith("mad/project/"):
                    rel = nm[len("mad/project/"):]
                    dest = pdir / rel
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(nm) as fsrc, open(dest, "wb") as fdst:
                        shutil.copyfileobj(fsrc, fdst)
            shotlist_path = pdir / link["shotlist_name"]
            if shotlist_path.exists():
                # rebuild asset_id/clip_id links from shot_id + timing
                shot_map = {}
                with Session(engine) as s:
                    for sid, e in link.get("shot_map", {}).items():
                        cid = shot_clip_map.get(sid)
                        aid = None
                        if cid:
                            aid = s.get(Clip, cid).asset_id
                        shot_map[sid] = {"clip_id": cid, "asset_id": aid, **e}
                MAD_DIR.mkdir(exist_ok=True)
                (MAD_DIR / f"{pid}.json").write_text(json.dumps({
                    "project_id": pid, "shotlist_path": str(shotlist_path),
                    "project_dir": str(pdir), "shot_map": shot_map}, ensure_ascii=False, indent=1))

    log.info(f"imported {zip_path.name} → project {pid} '{name}'")
    return pid
