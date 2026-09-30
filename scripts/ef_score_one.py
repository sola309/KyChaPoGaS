#!/usr/bin/env python3
"""帰巡ef C34: 1ジョブの比較シート生成+VLM採点(髪/背景/回り込み/降りる/破綻)。usage: ef_score_one.py <job>"""
import sys, json, base64, urllib.request, sqlite3
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from ef_cmp_sheet import sheet
job = int(sys.argv[1])
out = sheet(job)
db = sqlite3.connect(ROOT / "backend/data/kychapogas.db")
aid = db.execute("select id from asset where file_path like ? or file_path like ?", (f"%h3r_{job}.mp4", f"%h3_{job}.mp4")).fetchone()
img = base64.b64encode(open(out, "rb").read()).decode()
_custom = out.parent / "score_prompt.txt"
p = _custom.read_text().strip() if _custom.exists() else ("Top row = original anime shot (camera orbits a spiral staircase, girl walks down step by step). Bottom row = AI regeneration replacing the girl with 'Ultimate Madoka' whose pale pink hair should be ENDLESSLY long, trailing in wide ribbons and leaving the frame edge. "
     "Answer in Japanese, one line per item with a 1-5 score: 1) 髪が無限に長く画面外へ抜けているか 2) 背景(雲海・階段) 3) カメラの回り込み 4) 少女が階段を歩いて降りているか(上段と同じ位置・向き・歩行) 5) 破綻(顔・手・直立ポーズ漏れ). 最後に総評1文。")
body = {"model": "gemma4-26b:latest", "prompt": p, "images": [img], "stream": False, "think": False, "options": {"temperature": 0.1, "num_predict": 450}}
r = json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:11434/api/generate", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}), timeout=900))["response"].replace("<|channel>thought\n<channel|>", "").strip()
print(f"job {job} asset {aid[0] if aid else '?'}\n{r}")
with open(out.parent / "night_scores.md", "a") as f:
    f.write(f"\n## job {job} (asset {aid[0] if aid else '?'})\n{r}\n")
