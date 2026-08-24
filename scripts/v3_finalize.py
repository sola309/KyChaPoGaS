#!/usr/bin/env python3
"""v3のT1完走後に、配置 → 全尺レンダまでを一気に行う（夜間の無人実行用）。

  python3 scripts/v3_finalize.py <t1_jobs_v3.json> [--track 64]

1. 各単位をカット位置へ配置（1倍速・頭から・末尾トリム）
2. v1/v2 トラックを隠して v3 だけを表示
3. render_final を投入し、完了まで待つ（レビュー版も自動生成される）
4. 表示状態を元に戻す（3世代を並べて見られるように v3 を表示のまま残す）
"""
import argparse, json, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "http://localhost:8002/api"


def api(method, path, body=None):
    r = urllib.request.Request(API + path, method=method,
        data=(json.dumps(body).encode() if body else None),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=30) as f:
        raw = f.read()
    return json.loads(raw) if raw else None


def set_hidden(tid, hidden):
    urllib.request.urlopen(urllib.request.Request(
        f"{API}/tracks/{tid}?hidden={'true' if hidden else 'false'}", method="PATCH"), timeout=15)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("jobs")
    ap.add_argument("--track", type=int, default=64)
    a = ap.parse_args()

    print("① 配置", flush=True)
    r = subprocess.run([sys.executable, str(ROOT / "scripts/place_units.py"), a.jobs,
                        "--track", str(a.track), "--v2"],
                       capture_output=True, text=True, cwd=ROOT)
    print(r.stdout[-800:], flush=True)

    # 監査: 重なり・隙間
    cl = sorted(api("GET", f"/clips/?track_id={a.track}"), key=lambda c: c["start_frame"])
    prev, ov, gap = None, [], []
    for c in cl:
        s, e = c["start_frame"], c["start_frame"] + c["duration_frames"] - 1
        if prev and s <= prev[1]:
            ov.append((prev[2], c["id"]))
        if prev and s > prev[1] + 1:
            gap.append((prev[1] + 1, s - 1))
        prev = (s, e, c["id"])
    last = cl[-1] if cl else None
    print(f"  {len(cl)}クリップ / 0-{last['start_frame']+last['duration_frames']-1 if last else 0}f "
          f"重なり{ov or 'なし'} 隙間{gap or 'なし'}", flush=True)

    print("② v3だけ表示してレンダ", flush=True)
    tracks = api("GET", "/tracks/?project_id=31")
    seq = [t for t in tracks if t["track_type"] == "video" and t["name"].startswith("Sequences")]
    for t in seq:
        set_hidden(t["id"], t["id"] != a.track)
    time.sleep(2)

    j = api("POST", "/jobs/", {"project_id": 31, "job_type": "render_final",
                               "params": {"project_id": 31, "note": "v3 T1 全尺レンダ"}})
    jid = j["id"]
    print(f"  render job {jid}", flush=True)
    while True:
        d = api("GET", f"/jobs/{jid}")
        if d["status"] not in ("running", "pending"):
            break
        time.sleep(30)
    print(f"  → {d['status']}  {str(d.get('error_msg') or '')[:120]}", flush=True)

    out = ROOT / f"backend/data/exports/31/{jid}.mp4"
    rev = ROOT / f"backend/data/exports/31/{jid}_review.mp4"
    if out.exists():
        print(f"  本番 {out.stat().st_size/1e9:.2f}GB", flush=True)
    for _ in range(20):                      # レビュー版の生成を少し待つ
        if rev.exists():
            print(f"  レビュー {rev.stat().st_size/1e6:.0f}MB", flush=True)
            break
        time.sleep(15)
    print("③ 完了。3世代のトラックはv3のみ表示のまま残す", flush=True)


if __name__ == "__main__":
    main()
