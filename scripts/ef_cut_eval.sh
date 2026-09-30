#!/bin/bash
# usage: ef_cut_eval.sh <job_id> <ref.mp4> <tag> <cut_dir e.g. outputs/kijun-ef/C13> <brief_body.txt>  -> <cut_dir>/eval/<tag>_job<id>_{cmp.jpg,eval.txt}; appends to results.md
set -e
cd /home/kigarashi309/workspace/projects/KyChaPoGaS/repo
J=$1; REF=$2; T=$3; E=$4/eval; BODY=$5; mkdir -p $E
A=$(curl -s http://localhost:8002/api/jobs/$J | python3 -c "import sys,json;print((json.load(sys.stdin).get('result_asset_ids') or [0])[0])")
P=$(curl -s http://localhost:8002/api/assets/$A | python3 -c "import sys,json;print(json.load(sys.stdin)['file_path'])")
N=$(ffprobe -v error -count_frames -select_streams v -show_entries stream=nb_read_frames -of csv=p=0 "$P")
STEP=$(( (N+11)/12 ))
ffmpeg -v error -y -i "$P" -i $REF -filter_complex "[0:v]select='not(mod(n,$STEP))',scale=320:180,drawtext=text='GEN %{n}':x=4:y=4:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=12x1[g];[1:v]select='not(mod(n,$STEP))',scale=320:180,drawtext=text='REF %{n}':x=4:y=4:fontsize=18:fontcolor=cyan:box=1:boxcolor=black@0.6,tile=12x1[r];[g][r]vstack" -fps_mode passthrough -frames:v 1 $E/${T}_job${J}_cmp.jpg
AL=$(backend/.venv/bin/python scripts/ef_time_align.py "$P" $REF | tail -1)
M=$(backend/.venv/bin/python - <<PY
import subprocess, numpy as np
def frames(p,w=96,h=54):
    d=subprocess.run(["ffmpeg","-v","error","-i",p,"-vf",f"scale={w}:{h}","-f","rawvideo","-pix_fmt","gray","-"],capture_output=True).stdout
    return np.frombuffer(d,np.uint8).reshape(-1,h,w).astype(np.float32)
g=frames("$P"); r=frames("$REF"); n=min(len(g),len(r))
gs=g[:n,::4,::4]; rs=r[:n,::4,::4]; gs=gs-gs.mean(axis=(1,2),keepdims=True); rs=rs-rs.mean(axis=(1,2),keepdims=True)
ncc=(gs*rs).sum(axis=(1,2))/np.sqrt((gs**2).sum(axis=(1,2))*(rs**2).sum(axis=(1,2))+1e-6)
dg=np.abs(np.diff(g,axis=0)).mean(axis=(1,2)); dr=np.abs(np.diff(r,axis=0)).mean(axis=(1,2))
print(f"ncc={ncc.mean():.3f} thirds={[round(float(ncc[a:b].mean()),3) for a,b in ((0,n//3),(n//3,2*n//3),(2*n//3,n))]} flicker>20 gen/ref={int((dg>20).sum())}/{int((dr>20).sum())}")
PY
)
{ echo "添付は 2 段構成: 上段(GEN n)= AI 生成動画の 12 フレーム、下段(REF n)= 参照動画(元アニメ)の同じフレーム番号。同じ列 = 同じ時刻。"; cat "$BODY"; echo "最初に必ず: 各列の人物が『生成の目的に書かれた指定キャラクター』か『下段(参照)の元の人物のまま』かを判定する。髪色・服・体つきが下段と同じなら元の人物のまま(未置換)であり、その場合は置換を 0 点、総合を 3 点以下にする。参照によく追従していることは未置換を正当化しない。"; echo "各列について簡潔に: (1) 置換の成否(指定キャラクターか、元の人物の要素が残っていないか、人数の増減) (2) 位置・大きさ・向き・動きのタイミングの一致 (3) 背景・光・撮影処理(フェード等)の一致 (4) 生成側だけの破綻(融合、手足の崩れ、ちらつき)。最後に総評 3 行と、10 点満点の採点(置換/構図追従/破綻の少なさ の 3 項目と総合)。画像は生成しない。日本語。"; } > $E/${T}_job${J}_brief.txt
timeout 600 ~/.npm-global/bin/codex exec -m gpt-5.6-sol -c model_reasoning_effort=high --skip-git-repo-check --sandbox workspace-write -i $E/${T}_job${J}_cmp.jpg - < $E/${T}_job${J}_brief.txt > $E/${T}_job${J}_eval.txt 2>/dev/null || true
echo "## $T job $J asset $A ($N f) — $(date +%m/%d\ %H:%M)" >> $E/results.md
echo "$AL" >> $E/results.md; echo "$M" >> $E/results.md
tail -6 $E/${T}_job${J}_eval.txt >> $E/results.md; echo >> $E/results.md
echo "$T job $J asset $A frames $N"; echo "$AL"; echo "$M"; tail -6 $E/${T}_job${J}_eval.txt
