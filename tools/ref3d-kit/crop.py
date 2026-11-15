import sys, subprocess, numpy as np
from PIL import Image, ImageDraw
# crop.py out.jpg frame x y w h name... : 各出力の同じコマの同じ範囲を横に並べる
out, f, x, y, w, h = sys.argv[1], *map(int, sys.argv[2:7]); names = sys.argv[7:]
ims = []
for n in names:
    p = f'guides/{n[2:]}.mp4' if n.startswith('g:') else f'out/{n}.mp4'
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-vf', f'select=eq(n\\,{f}),crop={w}:{h}:{x}:{y}', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True).stdout
    im = Image.frombuffer('RGB', (w, h), raw); ImageDraw.Draw(im).text((4, 4), n, fill=(255, 255, 0)); ims.append(im)
s = Image.new('RGB', (w * len(ims), h))
for i, im in enumerate(ims): s.paste(im, (w * i, 0))
s.save(out, quality=90)
