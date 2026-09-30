#!/usr/bin/env python3
"""v5 の二系統流し: 単位ごとに VDN(track A) → 本番(track B) の順で投入し、完了を待って次へ。

  KYCHA_PROMPT_DIR=docs/anipafe2026-prompts-v5 python3 scripts/v5_stream_dual.py --vdn-track 67 --prod-track 68

- 関門(prompt_gate)に落ちた単位はスキップして記録
- failed は --retries 回まで再投入(ComfyUI 落ち対策)
- 台帳: outputs/anipafe2026-v5/stream_ledger.json  {uid: {vdn: {...}, prod: {...}}}
- ⚠ 実行中は backend/ を編集しない(uvicorn --reload でジョブが死ぬ)
"""
import argparse, importlib.util, json, os, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "http://localhost:8002/api"
PDIR = ROOT / os.environ.get("KYCHA_PROMPT_DIR", "docs/anipafe2026-prompts-v5")
LEDGER = ROOT / "outputs/anipafe2026-v5/stream_ledger.json"


def job(jid):
    return json.load(urllib.request.urlopen(f"{API}/jobs/{jid}", timeout=10))


def gate_ok(uid):
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


def submit(uid, track, flag):
    cmd = [sys.executable, str(ROOT / "scripts/submit_unit.py"), "--v4", "--auto", "--auto-audio",
           "--track", str(track)]
    if flag:
        cmd.append(flag)
    cmd.append(uid)
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT,
                       env=dict(os.environ, KYCHA_PROMPT_DIR=str(PDIR.relative_to(ROOT))))
    m = [l for l in r.stdout.splitlines() if l.startswith("{")]
    if not m:
        return None, (r.stdout[-300:] + r.stderr[-300:])
    return json.loads(m[-1])[uid], ""


def run_cfg(uid, cfg, track, flag, led, retries, save):
    tries = 0
    while tries <= retries:
        jid, err = submit(uid, track, flag)
        if not jid:
            print(f"✗ {uid}/{cfg}: 投入失敗 {err}", flush=True)
            led[uid][cfg] = {"status": "submit_error", "error": err}; save()
            return
        print(f"→ {uid}/{cfg} job {jid}" + (f" (再投入{tries})" if tries else ""), flush=True)
        led[uid][cfg] = {"status": "running", "job": jid}; save()
        while True:
            time.sleep(30)
            try:
                d = job(jid)
            except Exception:
                continue
            if d["status"] in ("completed", "failed", "cancelled"):
                break
        if d["status"] == "completed":
            aid = (d.get("result_asset_ids") or [None])[0]
            led[uid][cfg] = {"status": "completed", "job": jid, "asset": aid}; save()
            print(f"✓ {uid}/{cfg} → asset {aid}", flush=True)
            return
        tries += 1
        led[uid][cfg] = {"status": d["status"], "job": jid, "error": str(d.get("error_msg"))[:200]}; save()
        print(f"↻ {uid}/{cfg} {d['status']}: {str(d.get('error_msg'))[:80]}", flush=True)
        time.sleep(60)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vdn-track", type=int, required=True)
    ap.add_argument("--prod-track", type=int, required=True)
    ap.add_argument("--retries", type=int, default=2)
    ap.add_argument("--units", nargs="*")
    ap.add_argument("--skip-vdn", action="store_true")
    ap.add_argument("--skip-prod", action="store_true")
    ap.add_argument("--wait-min", type=int, default=0, help="txt が無いとき最大N分待つ(執筆と並走用)")
    a = ap.parse_args()
    meta = json.load(open(PDIR / "units.json"))
    order = a.units or list(meta)
    led = json.loads(LEDGER.read_text()) if LEDGER.exists() else {}
    LEDGER.parent.mkdir(parents=True, exist_ok=True)

    def save():
        LEDGER.write_text(json.dumps(led, ensure_ascii=False, indent=1))

    for uid in order:
        led.setdefault(uid, {})
        waited = 0
        while not (PDIR / f"{uid}.txt").exists() and waited < a.wait_min * 60:
            time.sleep(30); waited += 30
        if not (PDIR / f"{uid}.txt").exists():
            print(f"✗ {uid}: txt なし → スキップ", flush=True)
            led[uid]["status"] = "no_txt"; save()
            continue
        probs = gate_ok(uid)
        if probs:
            print(f"✗ {uid}: 関門 {probs}", flush=True)
            led[uid]["status"] = "gate"; led[uid]["problems"] = probs; save()
            continue
        for cfg, track, flag, skip in (("vdn", a.vdn_track, "--vdn", a.skip_vdn),
                                       ("prod", a.prod_track, None, a.skip_prod)):
            if skip or led[uid].get(cfg, {}).get("status") == "completed":
                continue
            run_cfg(uid, cfg, track, flag, led, a.retries, save)
    done = sum(1 for v in led.values() for c in ("vdn", "prod") if v.get(c, {}).get("status") == "completed")
    print(f"\n二系統流し完了: {done}/{2*len(order)} 完走", flush=True)


if __name__ == "__main__":
    main()
