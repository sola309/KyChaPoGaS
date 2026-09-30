#!/usr/bin/env python3
"""C6 sub-shot job submit. usage: ef_c6_submit.py <tier t1|t1hi|t2|t3> <ref_asset> <frames> <place_start> <prompt_file> <sheet_asset> [face_asset|0] [n=3] [note]"""
import sys, json, urllib.request
API="http://localhost:8002/api"
tier, ref, frames, start, pf, sheet = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5], int(sys.argv[6])
face = int(sys.argv[7]) if len(sys.argv)>7 else 0
n = int(sys.argv[8]) if len(sys.argv)>8 else 3
note = sys.argv[9] if len(sys.argv)>9 else ""
kf=[{"time_sec":0,"asset_id":sheet}]
if face: kf.append({"time_sec":0,"asset_id":face})
base = {"project_id":32,"model":"minimax-h3-ref","keyframes":kf,"ref_video_asset_ids":[ref],"duration_sec":frames/24,"fps":24,"seed":-1,"negative_prompt":"",
        "scheduler":"beta","use_ref_video_audio":False,"width":1344,"height":768,"ref_image_size":"max","prompt":open(pf).read(),
        "place":{"track_id":70,"start_frame":start,"duration_frames":frames,"auto":False}}
import os
if os.environ.get("PLACE_FRAMES"): base["place"]["duration_frames"]=int(os.environ["PLACE_FRAMES"])  # スロー参照→タイムラインは元尺(速度で戻す)
if tier=="t1": base.update(width=960,height=544,steps=4,turbo_lora=0.75,easycache=True)
elif tier=="t1hi": base.update(steps=4,turbo_lora=0.75,easycache=True)
elif tier=="t1ne": base.update(steps=4,turbo_lora=0.75,easycache=False)  # 長尺(362f)用: easycache 無しでメモリ節約
elif tier=="t1ne_lo": base.update(width=1152,height=640,steps=4,turbo_lora=0.75,easycache=False)  # 長尺: 解像度も落とす
elif tier=="t2": base.update(steps=8,turbo_lora=1.0,turbo_lora_name="minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",shift_video=6.0,shift_audio=3.0,sampler="euler",easycache=False)
else: base.update(steps=20,easycache=False)
base["note"]=f"ef C6 {tier.upper()} sheet#{sheet} face#{face} ref#{ref} {frames}f {note}"
ids=[]
for i in range(n):
    r=urllib.request.Request(API+"/jobs/",data=json.dumps({"project_id":32,"job_type":"generate_video_i2v","params":base}).encode(),headers={"Content-Type":"application/json"})
    ids.append(json.load(urllib.request.urlopen(r)).get("id"))
print("jobs",ids)
