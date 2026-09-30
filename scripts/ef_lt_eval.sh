#!/bin/bash
# usage: ef_lt_eval.sh <project_name> <tag>   -> outputs/kijun-ef/C6/lt_<tag>_707.mp4, _cmp.jpg, metrics
set -e
cd /home/kigarashi309/workspace/projects/KyChaPoGaS/repo
D=tools/comfyui/output/h3_longtake/$1; T=$2; O=outputs/kijun-ef/C6; REF=$O/ref_C6_full_276_982.mp4
ls $D/clip_0[0-9][0-9].mp4 | xargs -n1 realpath | sed "s/^/file '/;s/$/'/" > /tmp/claude-1000/lt_$T.txt
ffmpeg -v error -y -f concat -safe 0 -i /tmp/claude-1000/lt_$T.txt -c copy $O/lt_${T}_707.mp4
N=$(ffprobe -v error -count_frames -select_streams v -show_entries stream=nb_read_frames -of csv=p=0 $O/lt_${T}_707.mp4); echo "frames=$N"
ffmpeg -v error -y -i $O/lt_${T}_707.mp4 -c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p $O/lt_${T}_707_small.mp4
SEL="select='not(mod(n,59))'"
ffmpeg -v error -y -i $O/lt_${T}_707.mp4 -i $REF -filter_complex "[0:v]$SEL,scale=320:180,drawtext=text='GEN %{n}':x=4:y=4:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=12x1[g];[1:v]$SEL,scale=320:180,drawtext=text='REF %{n}':x=4:y=4:fontsize=18:fontcolor=cyan:box=1:boxcolor=black@0.6,tile=12x1[r];[g][r]vstack" -fps_mode passthrough -frames:v 1 $O/lt_${T}_cmp.jpg
backend/.venv/bin/python scripts/ef_time_align.py $O/lt_${T}_707.mp4 $REF | tail -1
backend/.venv/bin/python - <<PY
import subprocess, numpy as np
def frames(p,w=96,h=54):
    d=subprocess.run(["ffmpeg","-v","error","-i",p,"-vf",f"scale={w}:{h}","-f","rawvideo","-pix_fmt","gray","-"],capture_output=True).stdout
    return np.frombuffer(d,np.uint8).reshape(-1,h,w).astype(np.float32)
g=frames("$O/lt_${T}_707.mp4"); r=frames("$REF")
import glob,itertools
lens=[int(subprocess.run(["ffprobe","-v","error","-count_frames","-select_streams","v","-show_entries","stream=nb_read_frames","-of","csv=p=0",f],capture_output=True,text=True).stdout.strip()) for f in sorted(glob.glob("$D/clip_0[0-9][0-9].mp4"))]
B=list(itertools.accumulate(lens))[:-1]
print("boundaries",B)
dg=np.abs(np.diff(g,axis=0)).mean(axis=(1,2)); dr=np.abs(np.diff(r,axis=0)).mean(axis=(1,2))
n=min(len(dg),len(dr))
print("seam window (b..b+8) mean diff gen/ref:", [(b, round(float(dg[b-1:b+8].mean()),1), round(float(dr[b-1:b+8].mean()),1)) for b in B])
print("frames diff>20 gen/ref:", int((dg>20).sum()), int((dr>20).sum()))
# composition similarity: NCC of 24x14 low-res per frame
def low(x): 
    import torch
    return x
gs=g[:n].reshape(n,54,96)[:, ::4, ::4]; rs=r[:n].reshape(n,54,96)[:, ::4, ::4]
gs=gs-gs.mean(axis=(1,2),keepdims=True); rs=rs-rs.mean(axis=(1,2),keepdims=True)
ncc=(gs*rs).sum(axis=(1,2))/np.sqrt((gs**2).sum(axis=(1,2))*(rs**2).sum(axis=(1,2))+1e-6)
print("composition NCC mean:", round(float(ncc.mean()),3), " per-clip:", [round(float(ncc[a:b].mean()),3) for a,b in list(zip([0]+B,B+[n]))])
PY
