#!/usr/bin/env python3
"""帰巡ef C34: 参照(元カット)と生成物を**全フレーム**で比較し、カメラワークの一致度を数値化する。
- 低周波一致: 各フレームを 48x27 グレイ+ぼかしにして参照と同フレームの相関(人物の違いを無視し、雲海・階段・光の配置=カメラ位置を見る)
- 動きの一致: 位相相関で隣接フレーム間の平行移動(dx,dy)を両者で推定し、軌跡の相関
- 見え方の一致: ORB特徴で参照→生成のホモグラフィのスケール/回転(粗いズーム・回転の差)
出力: outputs/kijun-ef/C34/camdiff_<job>.png(曲線) と JSON。 usage: ef_camera_diff.py <job_id>... [--ref PATH]"""
import json, sqlite3, subprocess, sys
from pathlib import Path
import numpy as np, cv2
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "backend/data/kychapogas.db"
OUT = ROOT / "outputs/kijun-ef/C34"
REF = ROOT / "backend/data/assets/32/ref_3784_80312ms_8791ms.mp4"   # #3928 (209f)
W, H = 96, 54

def frames(path, n=None):
    raw = subprocess.run(["ffmpeg","-v","error","-i",str(path),"-vf",f"scale={W}:{H}","-pix_fmt","gray","-f","rawvideo","-"],capture_output=True).stdout
    a = np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(np.float32)
    return a[:n] if n else a

def lowfreq(a):  # 強いぼかしで人物/髪の差を落とし、背景配置(=カメラ)を残す
    return np.stack([cv2.GaussianBlur(f, (0, 0), 3.0) for f in a])

def ncc(x, y):
    x = x - x.mean(); y = y - y.mean()
    d = np.sqrt((x*x).sum() * (y*y).sum())
    return float((x*y).sum() / d) if d > 0 else 0.0

def shifts(a):  # 隣接フレームの平行移動(位相相関)
    out = []
    for i in range(1, len(a)):
        (dx, dy), _ = cv2.phaseCorrelate(a[i-1], a[i])
        out.append((dx, dy))
    return np.array(out) if out else np.zeros((0, 2))

def analyze(gen_path, ref_path=REF, label=""):
    r = frames(ref_path); g = frames(gen_path)
    n = min(len(r), len(g)); r, g = r[:n], g[:n]
    rl, gl = lowfreq(r), lowfreq(g)
    per = np.array([ncc(rl[i], gl[i]) for i in range(n)])
    rs, gs = shifts(rl), shifts(gl)
    # 軌跡: 累積移動の相関(x,y別)と、速度ベクトルの平均コサイン類似
    rc, gc = np.cumsum(rs, axis=0), np.cumsum(gs, axis=0)
    traj = [ncc(rc[:, k], gc[:, k]) if len(rc) > 2 else 0.0 for k in (0, 1)]
    dots = [(a @ b) / (np.linalg.norm(a) * np.linalg.norm(b)) for a, b in zip(rs, gs) if np.linalg.norm(a) > 0.05 and np.linalg.norm(b) > 0.05]
    vel_cos = float(np.mean(dots)) if dots else 0.0
    res = {"label": label, "frames": n, "lowfreq_ncc_mean": float(per.mean()), "lowfreq_ncc_min": float(per.min()),
           "lowfreq_ncc_last_third": float(per[2*n//3:].mean()), "traj_corr_x": traj[0], "traj_corr_y": traj[1],
           "velocity_cosine": vel_cos, "ref_path_len": float(np.abs(rs).sum()), "gen_path_len": float(np.abs(gs).sum())}
    return res, per, rc, gc

def plot(job, res, per, rc, gc):
    fig, ax = plt.subplots(2, 1, figsize=(10, 6))
    ax[0].plot(per); ax[0].set_ylim(-0.2, 1); ax[0].set_title(f"job {job} {res['label']}: low-freq NCC per frame (mean {res['lowfreq_ncc_mean']:.2f}, last1/3 {res['lowfreq_ncc_last_third']:.2f})"); ax[0].set_xlabel("frame")
    ax[1].plot(rc[:, 0], label="ref dx"); ax[1].plot(gc[:, 0], "--", label="gen dx"); ax[1].plot(rc[:, 1], label="ref dy"); ax[1].plot(gc[:, 1], "--", label="gen dy")
    ax[1].set_title(f"cumulative camera shift (corr x {res['traj_corr_x']:.2f}, y {res['traj_corr_y']:.2f}, velocity cos {res['velocity_cosine']:.2f})"); ax[1].legend(fontsize=8)
    fig.tight_layout(); fig.savefig(OUT / f"camdiff_{job}.png", dpi=90); plt.close(fig)

if __name__ == "__main__":
    ref_override = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--ref=")), None)
    if ref_override:
        REF = ref_override
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    db = sqlite3.connect(DB)
    rows = []
    for j in args:
        j = int(j)
        p, note = db.execute("select a.file_path, json_extract(j.params,'$.note') from job j join asset a on a.id=json_extract(j.result_asset_ids,'$[0]') where j.id=?", (j,)).fetchone()
        res, per, rc, gc = analyze(p, ref_path=REF, label=(note or "")[:40])
        res["job"] = j; rows.append(res); plot(j, res, per, rc, gc)
        print(f"job {j}: ncc {res['lowfreq_ncc_mean']:.3f} (last1/3 {res['lowfreq_ncc_last_third']:.3f}, min {res['lowfreq_ncc_min']:.3f}) traj x {res['traj_corr_x']:.2f} y {res['traj_corr_y']:.2f} vcos {res['velocity_cosine']:.2f} path ref {res['ref_path_len']:.0f} gen {res['gen_path_len']:.0f}  {res['label']}")
    json.dump(rows, open(OUT / "camdiff.json", "w"), ensure_ascii=False, indent=1)
