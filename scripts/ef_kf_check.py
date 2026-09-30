#!/usr/bin/env python3
"""FL2VA(第1フレーム固定)テイクの推移チェック: 第1フレーム画像 vs 生成8コマ → VLM 所見。usage: ef_kf_check.py <job> [<kf_image>]"""
import sys, json, base64, urllib.request, sqlite3, subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
D = ROOT / "outputs/kijun-ef/C34"
job = int(sys.argv[1]); kf = sys.argv[2] if len(sys.argv) > 2 else str(D / "kf_3977.jpg")
db = sqlite3.connect(ROOT / "backend/data/kychapogas.db")
row = db.execute("select id,file_path from asset where file_path like ? or file_path like ?", (f"%h3r_{job}.mp4", f"%h3_{job}.mp4")).fetchone()
aid, path = row
strip = D / f"v14_{job}_strip.jpg"; out = D / f"v14_{job}_check.jpg"
subprocess.run(["ffmpeg","-y","-v","error","-i",path,"-vf","select='not(mod(n\\,26))',scale=384:216,tile=8x1","-frames:v","1","-q:v","3",str(strip)],check=True)
subprocess.run(["ffmpeg","-y","-v","error","-i",kf,"-i",str(strip),"-filter_complex","[0]scale=3072:-1[a];[a][1]vstack=2","-q:v","3",str(out)],check=True)
img = base64.b64encode(open(out,"rb").read()).decode()
p = ("Top = the keyframe image given as the FIRST frame. Bottom = 8 frames of the generated 8.7s video (every 26 frames, left to right). Answer in Japanese with a 1-5 score each: 1) 1枚目は上の画像と一致しているか 2) 髪の長さは全編で維持され画面外へ抜けているか 3) カメラは階段の周りを回り込みながら引いているか 4) 少女は階段を歩いて降りているか(位置が下がる・歩行が見える) 5) 顔・体の破綻の無さ. 最後に総評1文。")
body = {"model":"gemma4-26b:latest","prompt":p,"images":[img],"stream":False,"think":False,"options":{"temperature":0.1,"num_predict":450}}
r = json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:11434/api/generate",data=json.dumps(body).encode(),headers={"Content-Type":"application/json"}),timeout=900))["response"].replace("<|channel>thought\n<channel|>","").strip()
print(f"job {job} asset {aid}\n{r}")
with open(D / "night_scores.md","a") as f: f.write(f"\n## job {job} (asset {aid}) [FL2VA keyframe check]\n{r}\n")
