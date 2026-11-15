#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""feel-kit / 速さの曲線を拍の線と重ねた図(PNG。字は PIL)と、連続コマのシート。

  python plot.py curves --audio audio.json --out fig.png --range 2950 3050 --series 完成版=final.npz v4=v4.npz v5=v5.npz [--title …]
  python plot.py strip  --out strip.jpg --range 2990 3020 [--step 1] --videos 完成版=final.mp4 v5=v5.mp4
図の見方: 横 = コマ(60fps)。縦の太い線 = 小節の頭、細い線 = 拍、点線 = 半拍。下の段の縦棒 = オンセット(ドラム = 橙 / 全体 = 灰)。
曲線 = 動きの量(速さ px/コマ × √面積)。
"""
import argparse
import glob
import subprocess

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from feel_lib import Beats, load_motion

COL = [(235, 235, 235), (255, 120, 90), (90, 200, 255), (160, 230, 120), (240, 200, 80)]


def font(sz):
    for p in glob.glob('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc') + glob.glob('/usr/share/fonts/truetype/noto/NotoSansCJK*.ttc') + glob.glob('/usr/share/fonts/**/*CJK*', recursive=True):
        try:
            return ImageFont.truetype(p, sz)
        except Exception:      # noqa: BLE001
            pass
    return ImageFont.load_default()


def curves(a):
    f0, f1 = a.range
    B = Beats(a.audio) if a.audio else None
    ser = []
    for s in a.series:
        name, path = s.split('=', 1)
        m = load_motion(path)
        e = m['mag'] * np.sqrt(m['area'])
        ser.append((name, e[f0:f1], m['cut'][f0:f1]))
    Wd, Hd, L, R, T, Bm = 1800, 620, 70, 20, 60, 110
    im = Image.new('RGB', (Wd, Hd), (22, 24, 30))
    d = ImageDraw.Draw(im)
    fb, fs = font(22), font(15)
    n = f1 - f0
    X = lambda f: L + (f - f0) / max(1, n - 1) * (Wd - L - R)
    ymax = max(1.0, max(float(np.percentile(e, 99.5)) for _, e, _ in ser) * 1.1)
    Y = lambda v: Hd - Bm - min(1.0, v / ymax) * (Hd - T - Bm)
    if B is not None:
        for b in B.half:
            if f0 <= b < f1:
                d.line((X(b), T, X(b), Hd - Bm), fill=(46, 50, 60))
        for i, b in enumerate(B.beats):
            if f0 <= b < f1:
                d.line((X(b), T, X(b), Hd - Bm + 6), fill=(90, 96, 112), width=1)
        for b in B.down:
            if f0 <= b < f1:
                d.line((X(b), T - 8, X(b), Hd - Bm + 12), fill=(190, 190, 120), width=3)
        for band, col, y0 in (('all', (150, 150, 150), Hd - Bm + 20), ('drums', (255, 160, 60), Hd - Bm + 46)):
            o = B.on.get(band)
            if o is None:
                continue
            for f, s_ in o:
                if f0 <= f < f1:
                    d.line((X(f), y0 + 22 - 22 * s_, X(f), y0 + 22), fill=col, width=2)
            d.text((4, y0 + 2), {'all': '音の立ち', 'drums': 'ドラム'}[band], font=fs, fill=col)
    for g in range(5):
        v = ymax * g / 4
        d.line((L, Y(v), Wd - R, Y(v)), fill=(40, 43, 52))
        d.text((6, Y(v) - 9), f'{v:.0f}', font=fs, fill=(150, 150, 150))
    st = max(1, n // 20 // 5 * 5 or 5)
    for f in range(f0 - f0 % st + st, f1, st):
        d.text((X(f) - 14, Hd - 26), str(f), font=fs, fill=(170, 170, 170))
    for i, (name, e, cut) in enumerate(ser):
        col = COL[i % len(COL)]
        pts = [(X(f0 + j), Y(float(v))) for j, v in enumerate(e)]
        d.line(pts, fill=col, width=3 if i == 0 else 2)
        for j in np.nonzero(cut > 0.5)[0]:
            d.polygon([(X(f0 + j) - 6, T - 12 + i * 4), (X(f0 + j) + 6, T - 12 + i * 4), (X(f0 + j), T + i * 4)], fill=col)
        d.rectangle((L + 10 + i * 190, 8, L + 34 + i * 190, 26), fill=col)
        d.text((L + 40 + i * 190, 4), name, font=fb, fill=col)
    d.text((L + 10 + len(ser) * 190, 6), (a.title or '') + '  縦 = 動きの量(px/コマ) 太線 = 小節 細線 = 拍 ▼ = 切り替わり', font=fs, fill=(210, 210, 210))
    im.save(a.out)
    print(a.out)


def strip(a):
    f0, f1 = a.range
    fr = list(range(f0, f1, a.step))
    cols = a.cols
    tw, th = a.tw, int(a.tw * 9 / 16)
    rows_per = (len(fr) + cols - 1) // cols
    vids = [s.split('=', 1) for s in a.videos]
    im = Image.new('RGB', (cols * tw, rows_per * len(vids) * (th + 20) + 4), (20, 20, 20))
    d = ImageDraw.Draw(im)
    fs = font(15)
    for vi, (name, path) in enumerate(vids):
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{f0 / a.fps:.6f}', '-i', path, '-frames:v', str(f1 - f0), '-vf', f'scale={tw}:{th}', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
                             capture_output=True, check=True).stdout
        for k, f in enumerate(fr):
            j = f - f0
            b = raw[j * tw * th * 3:(j + 1) * tw * th * 3]
            if len(b) < tw * th * 3:
                continue
            t = Image.frombytes('RGB', (tw, th), b)
            r, c = divmod(k, cols)
            x, y = c * tw, (r * len(vids) + vi) * (th + 20)
            im.paste(t, (x, y + 20))
            d.text((x + 4, y + 1), f'{name} {f}', font=fs, fill=(255, 230, 0) if vi == 0 else (120, 220, 255))
    im.save(a.out, quality=88)
    print(a.out)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    c = sp.add_parser('curves')
    c.add_argument('--audio')
    c.add_argument('--out', required=True)
    c.add_argument('--range', type=int, nargs=2, required=True)
    c.add_argument('--series', nargs='+', required=True)
    c.add_argument('--title')
    s = sp.add_parser('strip')
    s.add_argument('--out', required=True)
    s.add_argument('--range', type=int, nargs=2, required=True)
    s.add_argument('--step', type=int, default=1)
    s.add_argument('--cols', type=int, default=10)
    s.add_argument('--tw', type=int, default=256)
    s.add_argument('--fps', type=float, default=60)
    s.add_argument('--videos', nargs='+', required=True)
    a = ap.parse_args()
    (curves if a.cmd == 'curves' else strip)(a)
