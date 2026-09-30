#!/usr/bin/env python3
"""帰巡ef C34 v2 マトリクスの一括レポート: 完了ジョブごとに比較シート+VLM採点 → outputs/kijun-ef/C34/report_v2.md"""
import json, sqlite3, subprocess, sys, base64, urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
D = ROOT / "outputs/kijun-ef/C34"
sys.path.insert(0, str(ROOT / "scripts"))
from ef_cmp_sheet import sheet
J = json.load(open(D / "jobs_v2.json"))
db = sqlite3.connect(ROOT / "backend/data/kychapogas.db")
def vlm(path):
    img = base64.b64encode(open(path, "rb").read()).decode()
    p = ("Top row = original anime shot (8 frames over 8.6s): the camera orbits ~360 degrees around a spiral staircase while a girl walks down the stairs. Bottom row = AI regeneration that should keep the same orbiting camera, staircase, cloud-sea background, wind and light effects, but replace the girl with 'Ultimate Madoka' (long pale pink hair, white gown, wings of light). "
         "Answer in Japanese with a 1-5 score and one line of evidence each: 1) 背景(雲海と階段が維持され、宇宙/星空が混入していないか) 2) カメラの回り込み(上段と同じ向き・同じ範囲で回っているか) 3) 少女が階段を降りているか(位置・向き・歩行) 4) 人物置換(桃髪・白ドレス・翼) 5) 破綻(顔・手・複製・立ち絵ポーズの混入). 最後に総評1文。")
    body = {"model": "gemma4-26b:latest", "prompt": p, "images": [img], "stream": False, "think": False,
            "options": {"temperature": 0.1, "num_predict": 600}}
    r = urllib.request.Request("http://127.0.0.1:11434/api/generate", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=900))["response"].replace("<|channel>thought\n<channel|>", "").strip()
lines = ["# C34 v2 レポート", ""]
for key, jid in J["jobs"].items():
    st = db.execute("select status from job where id=?", (jid,)).fetchone()[0]
    lines.append(f"## {key} (job {jid}) — {st}")
    if st != "completed":
        lines.append(""); continue
    out = D / f"cmp_{jid}.jpg"
    if not out.exists(): sheet(jid)
    if out.exists():
        try: lines.append(vlm(out))
        except Exception as e: lines.append(f"(VLM失敗: {e})")
    lines.append("")
open(D / "report_v2.md", "w").write("\n".join(lines))
print("\n".join(lines))
