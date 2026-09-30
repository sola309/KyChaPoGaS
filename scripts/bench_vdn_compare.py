#!/usr/bin/env python3
"""VDN ベンチの品質比較: 各バリアント動画から同一時刻のフレームを抜いて横並びの比較シートを作り、
ベースライン(A)に対する SSIM/PSNR(同シード比較の「どれだけ離れたか」の目安)を出す。

  backend/.venv/bin/python scripts/bench_vdn_compare.py --out outputs/vdn-bench [--ref-asset 3311]
"""
from __future__ import annotations
import argparse, json, re, subprocess, sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FF = "ffmpeg"
TIMES = [0.25, 1.25, 2.25, 3.25, 4.25, 5.0]   # 秒(124f/24fps=5.17s)


def run(cmd: list[str]) -> str:
    return subprocess.run(cmd, capture_output=True, text=True).stderr


def ssim_psnr(a: Path, b: Path) -> dict:
    err = run([FF, "-hide_banner", "-i", str(a), "-i", str(b), "-lavfi",
               "[0:v][1:v]ssim=stats_file=-;[0:v][1:v]psnr", "-f", "null", "-"])
    ssim = re.findall(r"SSIM.*All:([\d.]+)", err)
    psnr = re.findall(r"PSNR.*average:([\d.]+)", err)
    return {"ssim": float(ssim[-1]) if ssim else None, "psnr": float(psnr[-1]) if psnr else None}


def strip(video: Path, out: Path, label: str) -> Path:
    """TIMES の各時刻のフレームを 320px幅で横に並べ、左端にラベルを入れた1行画像。"""
    sel = "+".join(f"eq(n\\,{int(t*24)})" for t in TIMES)
    vf = (f"select='{sel}',scale=320:-2,tile={len(TIMES)}x1:padding=4:color=black,"
          f"drawtext=text='{label}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6")
    run([FF, "-y", "-hide_banner", "-i", str(video), "-vf", vf, "-frames:v", "1", "-vsync", "0", str(out)])
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="outputs/vdn-bench")
    ap.add_argument("--ref-asset", type=int, default=None, help="同シードの過去の本番出力(決定性の確認用)")
    ap.add_argument("--times", default=None, help="抽出時刻(秒)をカンマ区切りで上書き。例: 0.5,2.4,3.6,4.9,6.0,6.9")
    args = ap.parse_args()
    if args.times:
        TIMES[:] = [float(t) for t in args.times.split(",")]
    out = ROOT / args.out
    res = json.loads((out / "results.json").read_text())
    runs = {k: v for k, v in res["runs"].items() if v.get("video")}
    base = runs.get("A_base25")
    rows, metrics = [], {}
    for name, r in sorted(runs.items()):
        v = Path(r["video"])
        secs = r.get("job_sec")
        sit = (r.get("sampling") or {}).get("s_per_it")
        label = f"{name}  {secs}s" + (f"  {sit}s/it" if sit else "")
        rows.append(strip(v, out / f"strip_{name}.png", label))
        if base and name != "A_base25":
            metrics[name] = ssim_psnr(Path(base["video"]), v)
    if args.ref_asset and base:
        row = sqlite3.connect(ROOT / "backend/data/kychapogas.db").execute(
            "SELECT file_path FROM asset WHERE id=?", (args.ref_asset,)).fetchone()
        if row:
            metrics["A_vs_previous_run"] = ssim_psnr(Path(base["video"]), Path(row[0]))
            rows.append(strip(Path(row[0]), out / "strip_prev.png", f"prev run (job {res['base_job']})"))
    # 縦に連結
    inputs = []
    for p in rows:
        inputs += ["-i", str(p)]
    run([FF, "-y", "-hide_banner", *inputs, "-filter_complex",
         "".join(f"[{i}:v]" for i in range(len(rows))) + f"vstack=inputs={len(rows)}", str(out / "compare_sheet.png")])
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics, indent=2)); print("sheet:", out / "compare_sheet.png")


if __name__ == "__main__":
    main()
