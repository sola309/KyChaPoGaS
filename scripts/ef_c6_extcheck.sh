#!/bin/bash
# usage: ef_c6_extcheck.sh <job> <prev_asset> <tag> <need_frames>  — 継続延長の連続性チェック + Codex 読み
cd /home/kigarashi309/workspace/projects/KyChaPoGaS/repo; J=$1; PREV=$2; T=$3; NEED=$4; E=outputs/kijun-ef/C6/eval
A=$(curl -s http://localhost:8002/api/jobs/$J | python3 -c "import sys,json;print((json.load(sys.stdin).get('result_asset_ids') or [0])[0])")
P=$(curl -s http://localhost:8002/api/assets/$A | python3 -c "import sys,json;print(json.load(sys.stdin)['file_path'])")
PP=$(curl -s http://localhost:8002/api/assets/$PREV | python3 -c "import sys,json;print(json.load(sys.stdin)['file_path'])")
backend/.venv/bin/python - <<PY
import subprocess, numpy as np
def frames(p,w=96,h=54):
    d=subprocess.run(["ffmpeg","-v","error","-i",p,"-vf",f"scale={w}:{h}","-f","rawvideo","-pix_fmt","gray","-"],capture_output=True).stdout
    return np.frombuffer(d,np.uint8).reshape(-1,h,w).astype(np.float32)
x=frames("$P"); g=frames("$PP")
def ncc(a,b):
    a=a-a.mean(); b=b-b.mean(); return float((a*b).sum()/np.sqrt((a*a).sum()*(b*b).sum()+1e-6))
d=np.abs(np.diff(x,axis=0)).mean(axis=(1,2))
print(f"seam ncc={ncc(g[-1],x[22]):.2f} maxdiff(22..{22+$NEED})={d[21:21+$NEED].max():.1f} mean={d[21:21+$NEED].mean():.1f} drift end ncc={ncc(g[-1],x[21+$NEED]):.2f}")
PY
ffmpeg -v error -y -i "$P" -vf "select='eq(n,21)+eq(n,26)+eq(n,32)+eq(n,38)+eq(n,44)+eq(n,50)+eq(n,56)+eq(n,70)',scale=480:272,drawtext=text='%{n}':x=8:y=8:fontsize=24:fontcolor=yellow:box=1:boxcolor=black@0.5,tile=4x2" -fps_mode passthrough -frames:v 1 $E/${T}_job${J}_strip.jpg
cat > $E/${T}_job${J}_brief.txt <<B
添付は 1 本の生成動画の 8 フレーム(番号は黄色数字)。先頭 22 フレームは前クリップの末尾を固定したもので、以降はその「続き」を生成させたものです。
各コマに何が映っているかを一言で書き、「前クリップの続きとして自然に繋がっている最後のフレーム番号」と「別の内容(新しい人物・別のシーン・急な変化)に変わった最初のフレーム番号(なければ なし)」を答えてください。画像は生成しない。日本語。
B
timeout 300 ~/.npm-global/bin/codex exec -m gpt-5.6-sol -c model_reasoning_effort=medium --skip-git-repo-check --sandbox read-only -i $E/${T}_job${J}_strip.jpg - < $E/${T}_job${J}_brief.txt 2>/dev/null | tail -11
