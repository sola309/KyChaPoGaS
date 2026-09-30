#!/bin/bash
# usage: ef_c15_eval.sh <job_id> <ref.mp4> <tag>  -> outputs/kijun-ef/C15/eval/<tag>_job<id>_{cmp.jpg,eval.txt}; appends to results.md
set -e
cd /home/kigarashi309/workspace/projects/KyChaPoGaS/repo
J=$1; REF=$2; T=$3; E=outputs/kijun-ef/C15/eval; mkdir -p $E
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
cat > $E/${T}_job${J}_brief.txt <<B
添付は 2 段構成: 上段(GEN n)= AI 生成動画の 12 フレーム、下段(REF n)= 参照動画(元アニメ)の同じフレーム番号。同じ列 = 同じ時刻。
生成の目的は、参照の 5 人を制服の少女 5 人に置き換えること: 左の 4 人は左から まどか(桃色ツインテール)/さやか(青ショート)/杏子(赤ロングポニーテール)/マミ(金髪縦ロール)、右の 1 人は ほむら(黒ロングストレート、鞄)。全員クリーム色ブレザーに灰チェックのスカート、背丈はほぼ同じ。手前の黒い装飾鉄柵と逆光の廊下は参照と同じであること。
各列について簡潔に: (1) 5 人が正しいキャラクターに置換されているか(髪色・髪型で識別、人数の増減、元の人物の残り) (2) 位置・大きさ・向き・歩行/走りのタイミングの一致(左 4 人が順に画面外へ出る、右の 1 人が途中から左へ走る) (3) 鉄柵・背景・逆光・ブルームの一致 (4) 生成側だけの破綻(人物の融合、手足の崩れ、柵の消失、ちらつき)。
最後に総評 3 行と、10 点満点の採点(置換/構図追従/破綻の少なさ の 3 項目と総合)。画像は生成しない。日本語。
B
timeout 600 ~/.npm-global/bin/codex exec -m gpt-5.6-sol -c model_reasoning_effort=high --skip-git-repo-check --sandbox workspace-write -i $E/${T}_job${J}_cmp.jpg - < $E/${T}_job${J}_brief.txt > $E/${T}_job${J}_eval.txt 2>/dev/null || true
echo "## $T job $J asset $A ($N f) — $(date +%m/%d\ %H:%M)" >> $E/results.md
echo "$AL" >> $E/results.md; echo "$M" >> $E/results.md
tail -6 $E/${T}_job${J}_eval.txt >> $E/results.md; echo >> $E/results.md
echo "$T job $J asset $A frames $N"; echo "$AL"; echo "$M"; tail -6 $E/${T}_job${J}_eval.txt
