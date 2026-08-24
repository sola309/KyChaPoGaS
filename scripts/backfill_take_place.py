#!/usr/bin/env python3
"""生成済みアセットの gen_params_json に place を補う（🗂テイク履歴の紐付け修復）。

テイク履歴は `gen_params_json.place.start_frame` でカットへ紐付く。
submit_unit.py が place を送っていなかった期間に作られたアセットは、
生成されていてもテイク履歴に出てこない。ジョブ台帳(単位→job)から
カット位置を逆引きして補う。

  python3 scripts/backfill_take_place.py <jobs.json> [--v2] [--track 63] [--dry]
"""
import argparse, importlib.util, json, re, sqlite3, sys, urllib.request
from pathlib import Path

API = "http://localhost:8002/api"
ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "backend/data/kychapogas.db"


def cut_ranges():
    pins = [c for c in json.load(urllib.request.urlopen(API + "/clips/?track_id=54"))
            if c.get("asset_id")]
    pins.sort(key=lambda c: c["start_frame"])
    return {i // 2 + 1: (pins[i]["start_frame"], pins[i + 1]["start_frame"])
            for i in range(0, len(pins) - 1, 2)}


def load_units(v2):
    spec = importlib.util.spec_from_file_location("su", ROOT / "scripts/submit_unit.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    if v2:
        m.PDIR = m.PDIR_V2
    return m.parse_units()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("jobs")
    ap.add_argument("--v2", action="store_true")
    ap.add_argument("--track", type=int, default=63)
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()

    jobs, units, cuts = json.load(open(a.jobs)), load_units(a.v2), cut_ranges()
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    fixed, skipped = 0, []

    for uid, jid in sorted(jobs.items()):
        if uid not in units:
            skipped.append((uid, "未知の単位")); continue
        ns = [int(x) for x in re.findall(r"C(\d+)", units[uid]["head"].split("(")[0])]
        if not ns:
            skipped.append((uid, "カット番号なし")); continue
        st, en = cuts[ns[0]][0], cuts[ns[-1]][1]

        aid = jid
        if isinstance(jid, int) and jid > 3400:
            j = json.load(urllib.request.urlopen(f"{API}/jobs/{jid}"))
            if j["status"] != "completed":
                skipped.append((uid, j["status"])); continue
            aid = (j.get("result_asset_ids") or [None])[0]
        if not aid:
            skipped.append((uid, "成果なし")); continue

        row = con.execute("SELECT gen_params_json FROM asset WHERE id=?", (aid,)).fetchone()
        if row is None:
            skipped.append((uid, f"#{aid} が無い")); continue
        try:
            p = json.loads(row["gen_params_json"]) if row["gen_params_json"] else {}
        except Exception:
            p = {}
        if isinstance(p.get("place"), dict) and isinstance(p["place"].get("start_frame"), int):
            skipped.append((uid, "place あり")); continue

        p["place"] = {"track_id": a.track, "start_frame": st,
                      "duration_frames": en - st + 1, "auto": False}
        print(f"{uid:5s} #{aid} → C{ns[0]}{'-C'+str(ns[-1]) if len(ns)>1 else ''} "
              f"{st}f ({en-st+1}f)")
        if not a.dry:
            con.execute("UPDATE asset SET gen_params_json=? WHERE id=?",
                        (json.dumps(p, ensure_ascii=False), aid))
        fixed += 1

    if not a.dry:
        con.commit()
    con.close()
    print(f"\n補完 {fixed}件 / 見送り {len(skipped)}件")
    for uid, why in skipped[:10]:
        print(f"  {uid}: {why}")


if __name__ == "__main__":
    sys.exit(main())
