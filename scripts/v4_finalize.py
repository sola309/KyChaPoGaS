#!/usr/bin/env python3
"""v4 流し完走後: track 66 の並びを監査(重なり・隙間)→ v4 だけ表示 → 全尺レンダ(レビュー版つき)。

  python3 scripts/v4_finalize.py [--track 66] [--no-render]
"""
import argparse, json, time, urllib.request

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
    ap.add_argument("--track", type=int, default=66)
    ap.add_argument("--no-render", action="store_true")
    a = ap.parse_args()
    cl = sorted(api("GET", f"/clips/?track_id={a.track}"), key=lambda c: c["start_frame"])
    prev, ov, gap = None, [], []
    for c in cl:
        s, e = c["start_frame"], c["start_frame"] + c["duration_frames"] - 1
        if prev and s <= prev[1]:
            ov.append((prev[2], c["id"], s - prev[1] - 1))
        if prev and s > prev[1] + 1:
            gap.append((prev[1] + 1, s - 1))
        prev = (s, e, c["id"])
    last = cl[-1] if cl else None
    print(f"track {a.track}: {len(cl)}クリップ / 0-{last['start_frame']+last['duration_frames']-1 if last else 0}f "
          f"重なり{ov or 'なし'} 隙間{gap or 'なし'}", flush=True)
    tracks = api("GET", "/tracks/?project_id=31")
    for t in tracks:
        if t["track_type"] == "video" and t["name"].startswith("Sequences"):
            set_hidden(t["id"], t["id"] != a.track)
    print("Sequences: v4 のみ表示", flush=True)
    if a.no_render:
        return
    j = api("POST", "/jobs/", {"project_id": 31, "job_type": "render_final",
                               "params": {"project_id": 31, "note": "v4 T1 全尺レンダ(ストーリーv2)"}})
    jid = j["id"]
    print(f"render job {jid}", flush=True)
    while True:
        d = api("GET", f"/jobs/{jid}")
        if d["status"] not in ("running", "pending"):
            break
        time.sleep(30)
    print(f"→ {d['status']} {str(d.get('error_msg') or '')[:120]}", flush=True)


if __name__ == "__main__":
    main()
