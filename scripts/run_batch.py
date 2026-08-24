#!/usr/bin/env python3
"""生成ジョブを投入し、失敗を自動で再投入しながら完走させる。

夜間バッチ用。ComfyUIが落ちるとジョブが "実行タスクが失われました" で
failed になる（2026-08-24に実害）。人が見ていない時間帯に穴が空くのを防ぐ。

  python3 scripts/run_batch.py --v3 --t1 --all [--retries 3] [--inflight 1]

- 同時実行は既定1本（バックエンドが順に捌くため投入自体は一括でもよいが、
  ComfyUIのメモリ逼迫を避けたいので既定は絞る）
- failed を検出したら同じ単位を再投入。--retries 回まで
- 進捗と再投入を逐次ログに出す
"""
import argparse, importlib.util, json, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "http://localhost:8002/api"


def job(jid):
    return json.load(urllib.request.urlopen(f"{API}/jobs/{jid}", timeout=10))


def submit(uid, v3, t1):
    cmd = [sys.executable, str(ROOT / "scripts/submit_unit.py")]
    cmd += ["--v3"] if v3 else ["--v2"]
    if t1:
        cmd.append("--t1")
    cmd.append(uid)
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    m = [l for l in r.stdout.splitlines() if l.startswith("{")]
    if not m:
        print(f"  ✗ {uid} 投入失敗: {r.stdout[-200:]} {r.stderr[-200:]}")
        return None
    return json.loads(m[-1])[uid]


def units_of(v3):
    spec = importlib.util.spec_from_file_location("su", ROOT / "scripts/submit_unit.py")
    m = importlib.util.module_from_spec(spec)
    sys.argv = ["x"]
    spec.loader.exec_module(m)
    m.PDIR = m.PDIR_V3 if v3 else m.PDIR_V2
    return sorted(m.parse_units())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--v3", action="store_true")
    ap.add_argument("--t1", action="store_true")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--units", nargs="*")
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--inflight", type=int, default=1)
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    targets = units_of(a.v3) if a.all else (a.units or [])
    pending = list(targets)
    tries = {u: 0 for u in targets}
    live, done, dead = {}, {}, []

    print(f"開始: {len(targets)}単位 / 同時{a.inflight} / 再投入上限{a.retries}", flush=True)
    while pending or live:
        while pending and len(live) < a.inflight:
            u = pending.pop(0)
            jid = submit(u, a.v3, a.t1)
            if jid:
                live[u] = jid
                print(f"→ {u} job {jid}", flush=True)
            else:
                dead.append(u)
        time.sleep(20)
        for u, jid in list(live.items()):
            try:
                d = job(jid)
            except Exception:
                continue
            if d["status"] == "completed":
                aid = (d.get("result_asset_ids") or [None])[0]
                done[u] = aid
                del live[u]
                print(f"✓ {u} → asset {aid}  ({len(done)}/{len(targets)})", flush=True)
            elif d["status"] == "failed":
                del live[u]
                tries[u] += 1
                if tries[u] <= a.retries:
                    pending.append(u)
                    print(f"↻ {u} 失敗({tries[u]}回目) 再投入: "
                          f"{str(d.get('error_msg'))[:60]}", flush=True)
                    time.sleep(30)          # ComfyUIの復帰を待つ
                else:
                    dead.append(u)
                    print(f"✗ {u} 再投入上限に到達", flush=True)

    print(f"\n完走 {len(done)}/{len(targets)}  未完 {dead}", flush=True)
    if a.out:
        Path(a.out).write_text(json.dumps(done, ensure_ascii=False))
        print(f"台帳: {a.out}")


if __name__ == "__main__":
    main()
