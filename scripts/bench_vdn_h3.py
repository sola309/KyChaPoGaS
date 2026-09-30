#!/usr/bin/env python3
"""VDN-H3 ベンチ: 同じシーン・同じシードで構成違いの H3 ジョブを直列投入し、所要時間と
ComfyUI ログの s/it を集計する。

使い方:
  backend/.venv/bin/python scripts/bench_vdn_h3.py --base-job 3970 --out outputs/vdn-bench
  (base-job のパラメータ(プロンプト/参照/seed/解像度/尺)をそのまま流用し、構成だけ差し替える)

結果: <out>/results.json と各バリアントの mp4 コピー。
ジョブは place.auto=false のまま投入するのでタイムラインは変えない(テイクとして蓄積)。
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

import urllib.request

ROOT = Path(__file__).resolve().parent.parent
API = "http://127.0.0.1:8002/api"
COMFY_LOG = ROOT / ".run" / "comfyui.log"
DB = ROOT / "backend" / "data" / "kychapogas.db"

# 比較する構成。ベースジョブの params に上書きされる。
VARIANTS: dict[str, dict] = {
    # 現行本番(ベースジョブそのまま: 25step / res_multistep / EasyCache無し)
    "A_base25":   {"vdn": None, "steps": 25, "easycache": False, "turbo_lora": None},
    # VDN-H3 8step: 配布元の既定(stream / grouped)
    "B_vdn8":     {"vdn": {"branch_weights": "stream", "attention_backend": "grouped",
                           "fast_kernels": False}, "steps": 8, "easycache": False, "turbo_lora": None},
    # VDN-H3 8step: GB10向け(分岐重み常駐 + compile融合カーネル)
    "C_vdn8_fast": {"vdn": {"branch_weights": "cache_gpu", "attention_backend": "grouped",
                            "fast_kernels": True}, "steps": 8, "easycache": False, "turbo_lora": None},
    # 現行の高速路(Turbo LoRA 4step + EasyCache)を本番解像度で
    "D_turbo4":   {"vdn": None, "steps": 4, "easycache": True, "turbo_lora": 0.75},
    # lightx2v Ref2V Turbo 8step v1.0 768p (2026-09-03公開)。配布元レシピ: 8 NFE / shift 6,3 / euler
    "F_turbo8_lx": {"vdn": None, "steps": 8, "easycache": False, "turbo_lora": 1.0,
                    "turbo_lora_name": "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
                    "shift_video": 6.0, "shift_audio": 3.0, "sampler": "euler"},
    # 同LoRAをアプリ流儀で: sa_solver + EasyCache
    "G_turbo8_app": {"vdn": None, "steps": 8, "easycache": True, "turbo_lora": 1.0,
                     "turbo_lora_name": "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
                     "shift_video": 6.0, "shift_audio": 3.0, "sampler": "sa_solver"},
    # NVIDIA Sol-Attn(スパース注意, GB10はTMAパス)。Turbo 8step lightx2vレシピ + Sol既定(tau 1.3→0.8, fused modulation)
    "H_turbo8_sol": {"vdn": None, "steps": 8, "easycache": False, "turbo_lora": 1.0,
                     "turbo_lora_name": "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
                     "shift_video": 6.0, "shift_audio": 3.0, "sampler": "euler", "sol": {}},
    # 同 + int8_qk(配布元の最速既定候補、相対L2誤差0.008)
    "J_turbo8_sol_i8": {"vdn": None, "steps": 8, "easycache": False, "turbo_lora": 1.0,
                        "turbo_lora_name": "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
                        "shift_video": 6.0, "shift_audio": 3.0, "sampler": "euler", "sol": {"int8_qk": True}},
    # 本番25step + Sol既定
    "I_base25_sol": {"vdn": None, "steps": 25, "easycache": False, "turbo_lora": None, "sol": {}},
    # VDN-H3 8step: FlexAttention(compile)バックエンド。窓内softmaxを1カーネルに融合する試み
    "E_vdn8_flex": {"vdn": {"branch_weights": "cache_gpu", "attention_backend": "flex",
                            "fast_kernels": True}, "steps": 8, "easycache": False, "turbo_lora": None},
}


def api(method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def base_params(job_id: int) -> dict:
    row = sqlite3.connect(DB).execute("SELECT params FROM job WHERE id=?", (job_id,)).fetchone()
    if not row:
        sys.exit(f"job {job_id} not found")
    return json.loads(row[0])


def log_offset() -> int:
    return COMFY_LOG.stat().st_size if COMFY_LOG.exists() else 0


def parse_log(since: int) -> dict:
    """投入後に増えたログから s/it・サンプリング時間・VDNの適用ログ・実行時間を拾う。"""
    if not COMFY_LOG.exists():
        return {}
    with COMFY_LOG.open("rb") as f:
        f.seek(since)
        text = f.read().decode("utf-8", "replace").replace("\r", "\n")
    its = re.findall(r"(\d+)/(\d+) \[(\d+:\d+)<\d+:\d+, +([\d.]+)s/it\]", text)
    final = None
    for cur, total, elapsed, sit in its:
        if cur == total:
            final = {"steps": int(total), "sampling_elapsed": elapsed, "s_per_it": float(sit)}
    vdn_lines = [l.strip() for l in text.splitlines() if "[vdn]" in l][:12]
    execd = re.findall(r"Prompt executed in ([\d.]+) seconds", text)
    warn = [l.strip() for l in text.splitlines() if "warning" in l.lower() and "vdn" in l.lower()][:5]
    return {"sampling": final, "vdn_log": vdn_lines, "prompt_executed_sec": float(execd[-1]) if execd else None,
            "vdn_warnings": warn}


def run_variant(name: str, params: dict, out: Path, project_id: int) -> dict:
    p = dict(params)
    p.update({k: v for k, v in VARIANTS[name].items()})
    p = {k: v for k, v in p.items() if v is not None}
    p["note"] = f"[VDNベンチ {name}] " + str(params.get("note", ""))[:80]
    if "place" in p:
        p["place"] = dict(p["place"], auto=False)   # タイムラインは触らずテイクとして蓄積
    since = log_offset()
    t0 = time.time()
    job = api("POST", "/jobs/", {"project_id": project_id, "job_type": "generate_video_i2v", "params": p})
    jid = job["id"]
    print(f"[{name}] job {jid} submitted", flush=True)
    while True:
        time.sleep(5)
        j = api("GET", f"/jobs/{jid}")
        if j["status"] in ("completed", "failed", "cancelled"):
            break
    wall = time.time() - t0
    st = datetime.fromisoformat(j["started_at"]) if j.get("started_at") else None
    ct = datetime.fromisoformat(j["completed_at"]) if j.get("completed_at") else None
    res = {"variant": name, "job_id": jid, "status": j["status"], "error": j.get("error_msg"),
           "wall_sec": round(wall, 1),
           "job_sec": round((ct - st).total_seconds(), 1) if st and ct else None,
           "vram_peak_mb": j.get("vram_peak_mb"), "result_asset_ids": j.get("result_asset_ids"),
           "config": VARIANTS[name], **parse_log(since)}
    if j["status"] == "completed" and j.get("result_asset_ids"):
        aid = j["result_asset_ids"][0]
        a = api("GET", f"/assets/{aid}")
        src = Path(a["file_path"])
        dst = out / f"{name}_job{jid}{src.suffix}"
        shutil.copy2(src, dst)
        res["video"] = str(dst)
    print(f"[{name}] {j['status']} job_sec={res['job_sec']} sampling={res.get('sampling')}", flush=True)
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-job", type=int, required=True)
    ap.add_argument("--out", default="outputs/vdn-bench")
    ap.add_argument("--variants", default=",".join(VARIANTS))
    ap.add_argument("--override", default="{}",
                    help='ベースparamsへ上書きするJSON。値 null のキーは削除(例: {"quality": null, "seed": 1})')
    args = ap.parse_args()
    out = ROOT / args.out
    out.mkdir(parents=True, exist_ok=True)
    params = base_params(args.base_job)
    for k, v in json.loads(args.override).items():
        if v is None:
            params.pop(k, None)
        else:
            params[k] = v
    project_id = int(params["project_id"])
    print(f"base job {args.base_job}: seed={params.get('seed')} {params.get('width')}x{params.get('height')} "
          f"model={params.get('model')} refs={len(params.get('keyframes') or [])}", flush=True)
    results_path = out / "results.json"
    results = json.loads(results_path.read_text()).get("runs", {}) if results_path.exists() else {}
    for name in args.variants.split(","):
        results[name] = run_variant(name, params, out, project_id)
        results_path.write_text(json.dumps({"base_job": args.base_job, "base_params": {
            k: v for k, v in params.items() if k != "prompt"}, "runs": results},
            ensure_ascii=False, indent=2))
    print("done:", results_path, flush=True)


if __name__ == "__main__":
    main()
