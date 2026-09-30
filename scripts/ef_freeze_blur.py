#!/usr/bin/env python3
"""C51-52 の撮影処理(元アニメ準拠): 2818-2824 で急速にぼけ、2825 から静止、2872-2905 で黒へフェード。
生成テイク(任意フレーム数)をタイムライン尺(len フレーム, speed 1.0)に焼き直す。
usage: ef_freeze_blur.py <in.mp4> <out.mp4> [--start 2704 --len 202 --blur0 2818 --freeze 2825 --fade0 2872 --smax 7]"""
import sys, argparse, subprocess, numpy as np, cv2
ap = argparse.ArgumentParser(); ap.add_argument('inp'); ap.add_argument('out')
for k, d in (('start', 2704), ('len', 202), ('blur0', 2818), ('freeze', 2825), ('fade0', 2872)): ap.add_argument('--' + k, type=int, default=d)
ap.add_argument('--rate', type=float, default=0.0, help='生成フレーム/タイムラインフレーム(0=全体を尺に合わせる、1=等倍)')
ap.add_argument('--smax', type=float, default=7.0); ap.add_argument('--fade_end', type=float, default=0.1)
a = ap.parse_args()
cap = cv2.VideoCapture(a.inp); src = []
while True:
    ok, f = cap.read()
    if not ok: break
    src.append(f)
h, w = src[0].shape[:2]; n = len(src)
b0, fr, f0, L = a.blur0 - a.start, a.freeze - a.start, a.fade0 - a.start, a.len
p = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{w}x{h}', '-r', '24', '-i', '-',
                      '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-pix_fmt', 'yuv420p', a.out], stdin=subprocess.PIPE)
for t in range(L):
    tt = min(t, fr - 1)                                  # 静止: freeze 以降は直前のフレームを保持
    img = src[min(n - 1, round(tt * a.rate) if a.rate > 0 else round(tt * (n - 1) / max(1, L - 1)))].astype(np.float32)
    if t >= b0:                                          # ぼかし: blur0→freeze で 0→smax(ease-in)
        k = min(1.0, (t - b0 + 1) / max(1, fr - b0)); s = a.smax * k * k * (w / 1920)
        if s > 0.3: img = cv2.GaussianBlur(img, (0, 0), s)
    if t >= f0:                                          # 黒へフェード
        img *= 1 - (1 - a.fade_end) * (t - f0 + 1) / max(1, L - f0)
    p.stdin.write(np.clip(img, 0, 255).astype(np.uint8).tobytes())
p.stdin.close(); p.wait(); print(a.out, L, 'frames')
