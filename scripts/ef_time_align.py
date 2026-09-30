"""生成動画と参照動画の時間対応(各生成フレームに最も似た参照フレーム)を推定し、傾き(再生速度比)を出す。
usage: ef_time_align.py <gen.mp4> <ref.mp4>"""
import sys, subprocess, numpy as np
def frames(path, w=48, h=27):
    out = subprocess.run(["ffmpeg","-v","error","-i",path,"-vf",f"scale={w}:{h},format=gray","-fps_mode","passthrough","-f","rawvideo","-"],capture_output=True).stdout
    a = np.frombuffer(out, np.uint8).reshape(-1, h, w).astype(np.float32)
    a -= a.mean(axis=(1,2), keepdims=True); a /= (a.std(axis=(1,2), keepdims=True) + 1e-6)
    return a
g, r = frames(sys.argv[1]), frames(sys.argv[2])
n = min(len(g), len(r)); g, r = g[:n], r[:n]
sim = np.einsum('ihw,jhw->ij', g, r) / (g.shape[1]*g.shape[2])   # gen i × ref j
# 単調な対応をDPで求める(スロープ制約なし・単調非減少)
N = n; dp = np.full((N, N), -1e9); bt = np.zeros((N, N), int)
dp[0] = sim[0]
for i in range(1, N):
    best = np.maximum.accumulate(dp[i-1]); arg = np.zeros(N, int); m = -1e9; mi = 0
    for j in range(N):
        if dp[i-1][j] > m: m = dp[i-1][j]; mi = j
        arg[j] = mi
    dp[i] = best + sim[i]; bt[i] = arg
j = int(np.argmax(dp[N-1])); path = [j]
for i in range(N-1, 0, -1):
    j = bt[i][j]; path.append(j)
path = np.array(path[::-1])
xs = np.arange(N); slope = np.polyfit(xs, path, 1)[0]
q = [int(path[int(N*f)]) for f in (0.25, 0.5, 0.75)]
print(f"n={N} slope={slope:.2f} (1.0=同速, <1=生成が遅い)  gen 25/50/75% → ref {q[0]}/{q[1]}/{q[2]}  mean_sim_on_path={sim[xs,path].mean():.2f}")
