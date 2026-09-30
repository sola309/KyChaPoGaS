#!/usr/bin/env python3
"""案C 継続延長: 前クリップ(asset)の末尾 22f を AddGuide(frame_idx 0)に固定し、124f 生成(先頭 22f は捨てる)。
usage: ef_c6_extend.py <tier t1|t3> <prev_asset> <sheet_asset> <prompt_file> <place_start> <place_frames> [n=2] [note]"""
import sys, json, urllib.request
API="http://localhost:8002/api"
tier, prev, sheet, pf, start, frames = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], int(sys.argv[5]), int(sys.argv[6])
n = int(sys.argv[7]) if len(sys.argv)>7 else 2; note = sys.argv[8] if len(sys.argv)>8 else ""
# 末尾アンカー(逆方向継続): 環境変数 TAIL=1 で次クリップ先頭22fを frame_idx 102 に固定
import os
TAIL = os.environ.get("TAIL") == "1"
base = {"project_id":32,"model":"minimax-h3-ref","keyframes":[{"time_sec":0,"asset_id":sheet}],
        "guide_videos":([{"asset_id":prev,"batch_index":0,"length":22,"frame_idx":102}] if TAIL else [{"asset_id":prev,"batch_index":-22,"length":22,"frame_idx":0}]),
        "duration_sec":124/24,"fps":24,"seed":-1,"negative_prompt":"","scheduler":"beta","use_ref_video_audio":False,
        "width":1344,"height":768,"ref_image_size":"max","prompt":open(pf).read(),
        "place":{"track_id":70,"start_frame":start,"duration_frames":frames,"auto":False}}
if tier=="t1": base.update(steps=4,turbo_lora=0.75,easycache=True)
else: base.update(steps=20,easycache=False)
base["note"]=f"ef C6 extend {tier.upper()} {'TAIL-anchor next#' if TAIL else 'prev#'}{prev} 22f->124f pic#{sheet} {note}"
ids=[]
for i in range(n):
    r=urllib.request.Request(API+"/jobs/",data=json.dumps({"project_id":32,"job_type":"generate_video_i2v","params":base}).encode(),headers={"Content-Type":"application/json"})
    ids.append(json.load(urllib.request.urlopen(r)).get("id"))
print("jobs",ids)
