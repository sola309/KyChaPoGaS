#!/usr/bin/env python3
"""v4 の完了単位からコンタクトシート(各6フレーム)を作る。  python3 scripts/v4_sheet.py U06 U10 [--out name]"""
import json, subprocess, sqlite3, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
a, b = sys.argv[1], sys.argv[2]
name = sys.argv[4] if len(sys.argv) > 4 else f"sheet_{a}-{b}"
led = json.load(open(ROOT / 'outputs/anipafe2026-v4/stream_ledger.json'))
db = sqlite3.connect(ROOT / 'backend/data/kychapogas.db')
rows = []
for uid, v in sorted(led.items()):
    if not (a <= uid <= b) or v.get('status') != 'completed':
        continue
    path, dur = db.execute('SELECT file_path, duration_sec FROM asset WHERE id=?', (v['asset'],)).fetchone()
    n = 6
    sel = "+".join(f"eq(n\\,{int(dur*24*(i+0.5)/n)})" for i in range(n))
    out = ROOT / f"outputs/anipafe2026-v4/strip_{uid}.png"
    vf = (f"select='{sel}',scale=300:-2,tile={n}x1:padding=3:color=black,"
          f"drawtext=text='{uid}':x=6:y=6:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6")
    subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', path, '-vf', vf,
                    '-frames:v', '1', '-vsync', '0', str(out)])
    rows.append(str(out))
inputs = sum([['-i', r] for r in rows], [])
png = ROOT / f"outputs/anipafe2026-v4/{name}.png"
subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', *inputs, '-filter_complex',
                ''.join(f'[{i}:v]' for i in range(len(rows))) + f'vstack=inputs={len(rows)}', str(png)])
jpg = ROOT / f"outputs/anipafe2026-v4/{name}.jpg"
subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', str(png), '-vf', 'scale=1500:-2', '-q:v', '4', str(jpg)])
print(jpg, len(rows))
