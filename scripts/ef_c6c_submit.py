#!/usr/bin/env python3
"""C6-C (Devil Homura) job submit. usage: ef_c6c_submit.py <tier t1|t3> <sheet_asset> <face_asset> <prompt_file> [n=3] [note]"""
import sys, json, urllib.request
API="http://localhost:8002/api"
tier, sheet, face, pf = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
n = int(sys.argv[5]) if len(sys.argv)>5 else 3
note = sys.argv[6] if len(sys.argv)>6 else ""
prompt = open(pf).read()
base = {"project_id":32,"model":"minimax-h3-ref",
        "keyframes":[{"time_sec":0,"asset_id":sheet},{"time_sec":0,"asset_id":face}],
        "ref_video_asset_ids":[4265],"duration_sec":158/24,"fps":24,"seed":-1,"negative_prompt":"",
        "scheduler":"beta","use_ref_video_audio":False,"width":1344,"height":768,"ref_image_size":"max",
        "prompt":prompt,"place":{"track_id":70,"start_frame":456,"duration_frames":151,"auto":False}}
if tier=="t1": base.update(steps=4,turbo_lora=0.75,easycache=True)
else: base.update(steps=20,easycache=False)
base["note"]=f"ef C6-C {tier.upper()} 悪魔ほむら sheet#{sheet} face#{face} ref#4265 {note}"
ids=[]
for i in range(n):
    r=urllib.request.Request(API+"/jobs/",data=json.dumps({"project_id":32,"job_type":"generate_video_i2v","params":base}).encode(),headers={"Content-Type":"application/json"})
    ids.append(json.load(urllib.request.urlopen(r)).get("id"))
print("jobs",ids)
