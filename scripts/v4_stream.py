#!/usr/bin/env python3
"""v4 の流し実行: 執筆済み(U##.txt がある)単位から物語順に、関門を通してT1投入→完了待ち→次へ。
Codex の執筆(並列)と GPU 生成(直列)を同時に進めるためのオーケストレータ。

  python3 scripts/v4_stream.py --track 66 [--t1|--t2] [--retries 2] [--wait-min 90]

- 単位は units.json の順(U01→U30)。txt が無ければ最大 --wait-min 分待つ
- 関門(prompt_gate)に落ちた単位はスキップして記録(後で手直し→個別投入)
- failed は --retries 回まで再投入
- 台帳: outputs/anipafe2026-v4/stream_ledger.json (uid → {job, status, asset})
"""
import argparse, importlib.util, json, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "http://localhost:8002/api"
V4 = ROOT / "docs/anipafe2026-prompts-v4"
LEDGER = ROOT / "outputs/anipafe2026-v4/stream_ledger.json"


def job(jid):
    return json.load(urllib.request.urlopen(f"{API}/jobs/{jid}", timeout=10))


def gate_ok(uid):
    """展開+関門(投入せずに検査)。submit_unit --dry の展開結果を prompt_gate に通す。"""
    sys.path.insert(0, str(ROOT / "backend"))
    spec = importlib.util.spec_from_file_location("su", ROOT / "scripts/submit_unit.py")
    m = importlib.util.module_from_spec(spec)
    sys.argv = ["x"]
    spec.loader.exec_module(m)
    from app.services.prompt_gate import validate_video_prompt
    units = m.parse_units_v4()
    if uid not in units:
        return ["txt missing"]
    u = units[uid]
    try:
        expanded = m.expand(u["code"], uid, m.build_dict())
    except SystemExit as e:
        return [f"展開失敗: {e}"]
    return validate_video_prompt(31, {
        "model": "minimax-h3" if u["mode"] == "I2VA" else "minimax-h3-ref",
        "prompt": expanded, "duration_sec": u["frames"] / 24.0, "fps": 24,
        "keyframes": [{"asset_id": x} for x in u["refs"][:9]]})


def submit(uid, track, quality):
    cmd = [sys.executable, str(ROOT / "scripts/submit_unit.py"), "--v4", "--auto", "--auto-audio",
           "--track", str(track), uid]
    if quality:
        cmd.insert(3, f"--{quality}")
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    m = [l for l in r.stdout.splitlines() if l.startswith("{")]
    if not m:
        return None, (r.stdout[-300:] + r.stderr[-300:])
    return json.loads(m[-1])[uid], ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--track", type=int, required=True)
    ap.add_argument("--t1", action="store_true")
    ap.add_argument("--t2", action="store_true")
    ap.add_argument("--retries", type=int, default=2)
    ap.add_argument("--wait-min", type=int, default=90)
    ap.add_argument("--units", nargs="*")
    a = ap.parse_args()
    quality = "t1" if a.t1 else ("t2" if a.t2 else "")
    meta = json.load(open(V4 / "units.json"))
    order = a.units or list(meta)
    led = json.loads(LEDGER.read_text()) if LEDGER.exists() else {}
    LEDGER.parent.mkdir(parents=True, exist_ok=True)

    def save():
        LEDGER.write_text(json.dumps(led, ensure_ascii=False, indent=1))

    for uid in order:
        if led.get(uid, {}).get("status") == "completed":
            print(f"= {uid} 済み", flush=True)
            continue
        # 執筆待ち
        waited = 0
        while not (V4 / f"{uid}.txt").exists():
            if waited >= a.wait_min * 60:
                print(f"✗ {uid}: txt が来ない → スキップ", flush=True)
                led[uid] = {"status": "no_txt"}; save()
                break
            time.sleep(30); waited += 30
        if not (V4 / f"{uid}.txt").exists():
            continue
        probs = gate_ok(uid)
        if probs:
            print(f"✗ {uid}: 関門 {probs}", flush=True)
            led[uid] = {"status": "gate", "problems": probs}; save()
            continue
        tries = 0
        while tries <= a.retries:
            jid, err = submit(uid, a.track, quality)
            if not jid:
                print(f"✗ {uid}: 投入失敗 {err}", flush=True)
                led[uid] = {"status": "submit_error", "error": err}; save()
                break
            print(f"→ {uid} job {jid}" + (f" (再投入{tries})" if tries else ""), flush=True)
            led[uid] = {"status": "running", "job": jid}; save()
            while True:
                time.sleep(20)
                try:
                    d = job(jid)
                except Exception:
                    continue
                if d["status"] in ("completed", "failed", "cancelled"):
                    break
            if d["status"] == "completed":
                aid = (d.get("result_asset_ids") or [None])[0]
                led[uid] = {"status": "completed", "job": jid, "asset": aid}; save()
                print(f"✓ {uid} → asset {aid}", flush=True)
                break
            tries += 1
            led[uid] = {"status": d["status"], "job": jid, "error": str(d.get("error_msg"))[:200]}; save()
            print(f"↻ {uid} {d['status']}: {str(d.get('error_msg'))[:80]}", flush=True)
            time.sleep(30)
    done = sum(1 for v in led.values() if v.get("status") == "completed")
    print(f"\n流し完了: {done}/{len(order)} 完走。未完: {[k for k in order if led.get(k,{}).get('status')!='completed']}", flush=True)


if __name__ == "__main__":
    main()
