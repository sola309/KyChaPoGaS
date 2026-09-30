#!/usr/bin/env python3
"""Split a Codex grid sheet into panels, CROPPING each panel to 16:9 (never stretching). usage: ef_split_sheet.py <sheet.png> <cols> <rows> <prefix> <name1,name2,...> [outdir]"""
import sys, numpy as np
from PIL import Image
path, cols, rows, prefix, names = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], sys.argv[5].split(',')
outdir = sys.argv[6] if len(sys.argv) > 6 else '.'
im = Image.open(path).convert('RGB'); a = np.asarray(im.convert('L'), dtype=np.float32)
rs = np.where(a.mean(axis=1) > 12)[0]; cs = np.where(a.mean(axis=0) > 12)[0]
top, bot, left, right = int(rs.min()), int(rs.max() + 1), int(cs.min()), int(cs.max() + 1)
sub = a[top:bot, left:right]; w, h = right - left, bot - top; cm = sub.mean(axis=0); rm = sub.mean(axis=1)
def gut(prof, frac):
    c = int(len(prof) * frac); return int(np.argmin(prof[c - 30:c + 30]) + c - 30)
xs = [0] + [gut(cm, i / cols) for i in range(1, cols)] + [w]; ys = [0] + [gut(rm, i / rows) for i in range(1, rows)] + [h]
g = 4; i = 0
for r in range(rows):
    for c in range(cols):
        bb = (left + xs[c] + (g if c else 0), top + ys[r] + (g if r else 0), left + xs[c + 1] - (g if c < cols - 1 else 0), top + ys[r + 1] - (g if r < rows - 1 else 0))
        p = im.crop(bb); pw, ph = p.size; asp = pw / ph
        if asp > 16 / 9 + 0.01:   # too wide -> crop sides
            nw = int(ph * 16 / 9); x0 = (pw - nw) // 2; p = p.crop((x0, 0, x0 + nw, ph))
        elif asp < 16 / 9 - 0.01:  # too tall -> crop top/bottom
            nh = int(pw * 9 / 16); y0 = (ph - nh) // 2; p = p.crop((0, y0, pw, y0 + nh))
        p.resize((1920, 1080), Image.LANCZOS).save(f'{outdir}/{prefix}_{names[i]}.png')
        print(names[i], 'panel', pw, ph, 'aspect', round(asp, 3), '-> cropped' if abs(asp - 16 / 9) > 0.01 else ''); i += 1
