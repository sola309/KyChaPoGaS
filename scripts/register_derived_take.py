#!/usr/bin/env python3
"""加工版テイク(つなぎ・揺れ止め・白フェード・指輪の描き足しなど)に来歴を付け、🗂テイク履歴に出す(10/17)。

テイク履歴は gen_params_json.place でカットへ紐付く。生成テイクに手を加えた版をふつうの動画として
アップロードすると place も元のテイクも記録されず、タイムラインに置いてあるのに履歴に出なかった。
この版には次を書く(prompt / seed は書かない: 再生成・夜間バッチの土台にしないため):
  derived: {op, note, from_jobs, from_assets, registered}
  model / width / height / steps / turbo_lora: 元のテイク(from の先頭)から。段階(T1〜T3)の表示用
  place:   {start_frame: 置いているクリップの頭, duration_frames: クリップの長さ,
            in_frame: クリップの頭が素材の何コマ目か(asset_in_frame), track_id, auto: false}

  python3 scripts/register_derived_take.py <asset_id> --clip <clip_id> --from-jobs 7221 7601 --op splice --note "…"
  python3 scripts/register_derived_take.py --batch outputs/pocky2026/v13/derived_takes_20261017.json [--project 33]
  共通: --db <path>(既定は本番の DB)・--dry・--force(gen_params_json が空でなくても書く)

--clip を省くと、その素材を置いているクリップを探す(映像トラックに 1 本だけのときだけ)。
"""
import argparse
import datetime
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "backend/data/kychapogas.db"
TIER_KEYS = ("model", "width", "height", "steps", "turbo_lora", "preview_steps", "fps")


def source_assets(con, from_jobs, from_assets, project_id):
    out = []
    for aid in from_assets or []:
        r = con.execute("SELECT project_id FROM asset WHERE id=?", (aid,)).fetchone()
        if r is None or r["project_id"] != project_id:
            raise SystemExit(f"元の素材 #{aid} が無いか、別のプロジェクトのものです")
        out.append(int(aid))
    for j in from_jobs or []:
        row = con.execute("SELECT status, result_asset_ids FROM job WHERE id=?", (j,)).fetchone()
        if row is None or row["status"] != "completed":
            raise SystemExit(f"job {j} が無いか、終わっていません")
        ids = json.loads(row["result_asset_ids"] or "[]")
        if not ids:
            raise SystemExit(f"job {j} に成果の素材がありません")
        r = con.execute("SELECT project_id FROM asset WHERE id=?", (int(ids[0]),)).fetchone()
        if r is None or r["project_id"] != project_id:
            raise SystemExit(f"job {j} の成果 #{ids[0]} が無いか、別のプロジェクトのものです")
        out.append(int(ids[0]))
    return out


def find_clip(con, asset_id, project_id):
    rows = con.execute(
        "SELECT c.* FROM clip c JOIN track t ON t.id = c.track_id "
        "WHERE c.asset_id=? AND t.track_type='video'" + (" AND t.project_id=?" if project_id else ""),
        (asset_id, project_id) if project_id else (asset_id,)).fetchall()
    if len(rows) != 1:
        raise SystemExit(f"#{asset_id} を置いている映像クリップが {len(rows)} 本です。--clip で指定してください")
    return rows[0]


def build(con, asset_id, clip_id, from_jobs, from_assets, op, note, project_id, force):
    a = con.execute("SELECT * FROM asset WHERE id=?", (asset_id,)).fetchone()
    if a is None:
        raise SystemExit(f"#{asset_id} が無い")
    prev = None
    if (a["gen_params_json"] or "").strip():
        if not force:
            raise SystemExit(f"#{asset_id} にはすでに gen_params_json があります(上書きは --force)")
        try:
            prev = json.loads(a["gen_params_json"])
        except Exception:
            prev = a["gen_params_json"]
        # 生成テイク・雨の層・拡大版の記録は --force でも消さない(番号の取り違え対策: asset 7601 と job 7601 など)
        if isinstance(prev, dict) and not prev.get("derived") and any(k in prev for k in ("prompt", "rain_fx", "upscale_of")):
            raise SystemExit(f"#{asset_id} は生成・雨・拡大の記録を持つ素材です。加工版の来歴では上書きしません")
    c = (con.execute("SELECT * FROM clip WHERE id=?", (clip_id,)).fetchone() if clip_id
         else find_clip(con, asset_id, project_id))
    if c is None or c["asset_id"] != asset_id:
        raise SystemExit(f"clip {clip_id} は #{asset_id} を置いていません")
    t = con.execute("SELECT project_id, track_type FROM track WHERE id=?", (c["track_id"],)).fetchone()
    if t is None or t["track_type"] != "video" or t["project_id"] != a["project_id"]:
        raise SystemExit(f"clip {c['id']} は #{asset_id} と同じプロジェクトの映像トラックにありません")
    srcs = source_assets(con, from_jobs, from_assets, a["project_id"])
    if not srcs:
        raise SystemExit("元のテイク(--from-jobs / --from-assets)を 1 つ以上")
    sp = {}
    row = con.execute("SELECT gen_params_json FROM asset WHERE id=?", (srcs[0],)).fetchone()
    if row and row["gen_params_json"]:
        sp = json.loads(row["gen_params_json"])
    p = {k: sp[k] for k in TIER_KEYS if k in sp}
    if a["duration_sec"] is not None:
        p["duration_sec"] = a["duration_sec"]          # この版の長さ(元のテイクの長さではない)
    p["derived"] = {"op": op, "note": note, "from_jobs": list(from_jobs or []), "from_assets": srcs,
                    "file": Path(a["file_path"]).name,
                    "registered": datetime.date.today().isoformat()}
    if prev is not None:
        p["derived"]["prev"] = prev                   # --force で置き換えた前の記録
    p["place"] = {"track_id": c["track_id"], "start_frame": int(c["start_frame"]),
                  "duration_frames": int(c["duration_frames"]), "in_frame": int(c["asset_in_frame"] or 0),
                  "auto": False}
    return a, c, p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("asset", nargs="?", type=int)
    ap.add_argument("--clip", type=int)
    ap.add_argument("--from-jobs", type=int, nargs="*", default=[])
    ap.add_argument("--from-assets", type=int, nargs="*", default=[])
    ap.add_argument("--op", default="edit")
    ap.add_argument("--note", default="")
    ap.add_argument("--batch")
    ap.add_argument("--project", type=int)
    ap.add_argument("--db", default=str(DB))
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    if a.batch:
        items = json.load(open(a.batch))["items"]
    elif a.asset:
        items = [{"asset": a.asset, "clip": a.clip, "from_jobs": a.from_jobs, "from_assets": a.from_assets,
                  "op": a.op, "note": a.note}]
    else:
        ap.error("asset か --batch")

    con = sqlite3.connect(a.db, timeout=30)
    con.row_factory = sqlite3.Row
    seen = [it["asset"] for it in items]
    if len(seen) != len(set(seen)):
        raise SystemExit("同じ素材が 2 回あります: " + ", ".join(str(x) for x in sorted({x for x in seen if seen.count(x) > 1})))
    plans = []
    for it in items:   # 全部そろうか先に確かめる(途中で止まって半端に書かない)
        asset, clip, p = build(con, it["asset"], it.get("clip"), it.get("from_jobs"), it.get("from_assets"),
                               it.get("op", "edit"), it.get("note", ""), a.project, a.force)
        plans.append((asset, clip, p))
        pl = p["place"]
        print(f"#{asset['id']:5d} {asset['name'][:40]:40s} clip {clip['id']} f{pl['start_frame']}+{pl['duration_frames']}"
              f" in {pl['in_frame']} ← {p['derived']['from_assets']} {p.get('model', '?')} {p.get('width')}×{p.get('height')}"
              f" {p.get('steps')}st [{p['derived']['op']}]")
    if a.dry:
        print("(dry: 書いていません)")
        return
    with con:   # 1 トランザクション。確かめたあとに誰かが書いていたら、全部取りやめる
        for asset, _clip, p in plans:
            cur = con.execute("UPDATE asset SET gen_params_json=? WHERE id=? AND COALESCE(gen_params_json,'')=?",
                              (json.dumps(p, ensure_ascii=False), asset["id"], asset["gen_params_json"] or ""))
            if cur.rowcount != 1:
                raise SystemExit(f"#{asset['id']} の記録が確かめたあとに変わりました。何も書いていません")
    print(f"{len(plans)} 本に来歴を書きました({a.db})")


if __name__ == "__main__":
    sys.exit(main())
