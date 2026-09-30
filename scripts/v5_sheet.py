#!/usr/bin/env python3
"""v5 比較シート: 単位ごとに T1(v4) / VDN(v5) / 本番(v5) の3行×6フレーム。  python3 scripts/v5_sheet.py U01 U05"""
import json, sqlite3, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
a, b = sys.argv[1], sys.argv[2]
led4 = json.load(open(ROOT/'outputs/anipafe2026-v4/stream_ledger.json'))
led5 = json.load(open(ROOT/'outputs/anipafe2026-v5/stream_ledger.json'))
db = sqlite3.connect(ROOT/'backend/data/kychapogas.db')
rows = []
for uid in sorted(led5):
    if not (a <= uid <= b): continue
    for label, aid in [(f"{uid} T1 v4", led4.get(uid, {}).get('asset')), (f"{uid} VDN v5", led5[uid].get('vdn', {}).get('asset')), (f"{uid} 本番 v5", led5[uid].get('prod', {}).get('asset'))]:
        if not aid: continue
        path, dur = db.execute('SELECT file_path, duration_sec FROM asset WHERE id=?', (aid,)).fetchone()
        n = 6; sel = "+".join(f"eq(n\\,{int(dur*24*(i+0.5)/n)})" for i in range(n))
        out = ROOT/f"outputs/anipafe2026-v5/strip_{aid}.png"
        vf = f"select='{sel}',scale=300:-2,tile={n}x1:padding=3:color=black,drawtext=text='{label}':x=6:y=6:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6"
        subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',path,'-vf',vf,'-frames:v','1','-vsync','0',str(out)]); rows.append(str(out))
inputs = sum([['-i', r] for r in rows], [])
png = ROOT/f"outputs/anipafe2026-v5/cmp_{a}-{b}.png"; jpg = ROOT/f"outputs/anipafe2026-v5/cmp_{a}-{b}.jpg"
subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error',*inputs,'-filter_complex',''.join(f'[{i}:v]' for i in range(len(rows)))+f'vstack=inputs={len(rows)}',str(png)])
subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',str(png),'-vf','scale=1500:-2','-q:v','4',str(jpg)]); print(jpg, len(rows))
