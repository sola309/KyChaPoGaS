#!/usr/bin/env python3
"""生成単位の結果をタイムラインのカット位置へ配置する。

  python3 scripts/place_units.py <jobs.json> [--track 62] [--dry]

jobs.json は {"U04": 3815, ...}。単位が担当するカット(見出しの C番号)から
ピン由来の実尺を引き、**1倍速・頭から使用・末尾トリム**で置く(運用規約)。
既存クリップが同じ範囲にあれば置き換える。
"""
import argparse, json, re, sys, urllib.request
import importlib.util
from pathlib import Path

API = "http://localhost:8002/api"
PROJECT = 31
ROOT = Path(__file__).resolve().parent.parent


def api(method, path, body=None):
    r = urllib.request.Request(API + path, method=method,
        data=(json.dumps(body).encode() if body else None),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r) as f:
        raw = f.read()
    return json.loads(raw) if raw else None


def cut_ranges():
    """ピン(track 54)を2つずつ組にして C番号 → (start, end) を返す。"""
    pins = [c for c in api("GET", "/clips/?track_id=54") if c.get("asset_id")]
    pins.sort(key=lambda c: c["start_frame"])
    return {i // 2 + 1: (pins[i]["start_frame"], pins[i + 1]["start_frame"])
            for i in range(0, len(pins) - 1, 2)}


def load_units():
    spec = importlib.util.spec_from_file_location("su", ROOT / "scripts/submit_unit.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m.parse_units()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("jobs")
    ap.add_argument("--track", type=int, default=62)
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()

    jobs, units, cuts = json.load(open(a.jobs)), load_units(), cut_ranges()
    existing = api("GET", f"/clips/?track_id={a.track}")

    plan, skipped = [], []
    for uid, jid in sorted(jobs.items()):
        if uid not in units:
            skipped.append((uid, "未知の単位")); continue
        head = units[uid]["head"]
        ns = [int(x) for x in re.findall(r"C(\d+)", head.split("(")[0])]
        if not ns:
            skipped.append((uid, "カット番号が読めない")); continue
        # ジョブ結果(既にアセットIDが渡されている場合はそのまま使う)
        if isinstance(jid, int) and jid > 3400:
            j = api("GET", f"/jobs/{jid}")
            if j["status"] != "completed":
                skipped.append((uid, f"job {jid} は {j['status']}")); continue
            aid = (j.get("result_asset_ids") or [None])[0]
        else:
            aid = jid
        if not aid:
            skipped.append((uid, "成果アセットが無い")); continue
        start = cuts[ns[0]][0]
        end = cuts[ns[-1]][1]
        plan.append((uid, aid, start, end - start + 1, ns))

    for uid, aid, start, dur, ns in plan:
        cs = "+".join(f"C{n}" for n in ns)
        if a.dry:
            print(f"{uid:5s} {cs:12s} asset #{aid} → {start}f  {dur}f")
            continue
        # 同じ開始位置の既存クリップは置き換え、それ以外は新規
        hit = next((c for c in existing if c["start_frame"] == start), None)
        body = {"asset_id": aid, "start_frame": start, "duration_frames": dur,
                "in_frame": 0, "speed": 1.0}
        if hit:
            api("PATCH", f"/clips/{hit['id']}", body)
            print(f"{uid:5s} {cs:12s} #{aid} → clip {hit['id']} 更新 ({start}f {dur}f)")
        else:
            api("POST", "/clips/", dict(body, track_id=a.track))
            print(f"{uid:5s} {cs:12s} #{aid} → 新規 ({start}f {dur}f)")

    if skipped:
        print("\n配置しなかったもの:")
        for uid, why in skipped:
            print(f"  {uid}: {why}")
    print(f"\n配置 {len(plan)}件 / 見送り {len(skipped)}件")


if __name__ == "__main__":
    sys.exit(main())
