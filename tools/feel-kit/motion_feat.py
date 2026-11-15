#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""feel-kit / 映像の動きを 1 コマ単位で測る(オプティカルフロー)。

  python motion_feat.py <動画> --out motion.npz [--w 480] [--start 0 --frames N]

出力 npz(長さ = コマ数。i 番目 = コマ i-1 → i の動き。px は元の動画の幅に換算した値):
  mag     動いている画素の速さの平均(px/コマ)        p95    速さの 95 パーセンタイル
  area    動いている画素の割合(0..1)                  dx, dy 動いている画素の平均の向き(px/コマ)
  gtx,gty,gscale,grot  画面全体を 1 つの相似変換とみなしたときの 平行移動(px)・拡大率(倍/コマ)・回転(度/コマ)= カメラ・全体の動き
  resid   相似変換で説明できない残りの速さ(px/コマ)= 物ごとの動き
  luma    明るさの平均(0..255)   diff  前のコマとの差の平均(0..255)
  cut     切り替わり(1 = このコマから新しいカット)     dup   前のコマと同じ絵(1。動きの途中にあればコマ落ち)
"""
import argparse
import subprocess

import cv2
import numpy as np


def probe(path):
    o = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_frames', '-of', 'csv=p=0', path],
                       capture_output=True, text=True).stdout.strip().split(',')
    w, h = int(o[0]), int(o[1])
    a, b = o[2].split('/')
    return w, h, float(a) / float(b)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--out', required=True)
    ap.add_argument('--w', type=int, default=480)
    ap.add_argument('--start', type=int, default=0)
    ap.add_argument('--frames', type=int, default=0)
    ap.add_argument('--crop', default=None, help='x:y:w:h(元の動画の px)。横並びの片側だけ測るとき')
    a = ap.parse_args()
    W0, H0, fps = probe(a.src)
    vf = []
    if a.crop:
        x, y, w, h = [int(v) for v in a.crop.split(':')]
        vf.append(f'crop={w}:{h}:{x}:{y}')
        W0, H0 = w, h
    w = a.w
    h = int(round(H0 * w / W0 / 2)) * 2
    vf.append(f'scale={w}:{h}:flags=area')
    cmd = ['ffmpeg', '-v', 'error']
    if a.start:
        cmd += ['-ss', f'{a.start / fps:.6f}']
    cmd += ['-i', a.src, '-vf', ','.join(vf), '-pix_fmt', 'gray', '-f', 'rawvideo']
    if a.frames:
        cmd += ['-frames:v', str(a.frames)]
    cmd += ['-']
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=w * h * 8)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    k = W0 / w
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    xs -= w / 2
    ys -= h / 2
    rows = []
    prev = None
    hist_prev = None
    while True:
        buf = p.stdout.read(w * h)
        if len(buf) < w * h:
            break
        g = np.frombuffer(buf, np.uint8).reshape(h, w)
        r = dict(mag=0, p95=0, area=0, dx=0, dy=0, gtx=0, gty=0, gscale=1, grot=0, resid=0, luma=float(g.mean()), diff=0, cut=0, dup=0)
        hist = cv2.calcHist([g], [0], None, [32], [0, 256]).ravel() / (w * h)
        if prev is not None:
            d = cv2.absdiff(g, prev)
            r['diff'] = float(d.mean())
            r['dup'] = int(d.max() <= 1)
            hd = float(np.abs(hist - hist_prev).sum())
            fl = dis.calc(prev, g, None)
            m = np.hypot(fl[..., 0], fl[..., 1])
            mv = (m > 0.35) & (d > 3) | (m > 1.0)
            # 切り替わり: 明暗の分布が大きく変わり、絵の差も大きい
            r['cut'] = int(hd > 0.55 and r['diff'] > 18)
            if mv.sum() > 40 and not r['cut']:
                r['area'] = float(mv.mean())
                r['mag'] = float(m[mv].mean() * k)
                r['p95'] = float(np.percentile(m[mv], 95) * k)
                r['dx'] = float(fl[..., 0][mv].mean() * k)
                r['dy'] = float(fl[..., 1][mv].mean() * k)
                # 相似変換の当てはめ: u = a*x - b*y + tx, v = b*x + a*y + ty(a = s*cos - 1, b = s*sin)
                X, Y, U, V = xs[mv], ys[mv], fl[..., 0][mv], fl[..., 1][mv]
                if len(X) > 200:
                    st = max(1, len(X) // 4000)
                    X, Y, U, V = X[::st], Y[::st], U[::st], V[::st]
                    A = np.zeros((2 * len(X), 4), np.float32)
                    A[0::2, 0], A[0::2, 1], A[0::2, 2] = X, -Y, 1
                    A[1::2, 0], A[1::2, 1], A[1::2, 3] = Y, X, 1
                    B = np.empty(2 * len(X), np.float32)
                    B[0::2], B[1::2] = U, V
                    sol, *_ = np.linalg.lstsq(A, B, rcond=None)
                    res = np.abs(A @ sol - B)
                    keep = res < max(0.5, np.percentile(res, 70))       # 外れを 1 回落として当て直す
                    if keep.sum() > 50:
                        sol, *_ = np.linalg.lstsq(A[keep], B[keep], rcond=None)
                    aa, bb, tx, ty = [float(v) for v in sol]
                    r['gscale'] = float(np.hypot(1 + aa, bb))
                    r['grot'] = float(np.degrees(np.arctan2(bb, 1 + aa)))
                    r['gtx'], r['gty'] = tx * k, ty * k
                    pr = A @ sol
                    r['resid'] = float(np.hypot(pr[0::2] - U, pr[1::2] - V).mean() * k)
        rows.append(r)
        prev, hist_prev = g, hist
    p.wait()
    out = {key: np.array([r[key] for r in rows], np.float32) for key in rows[0]}
    np.savez_compressed(a.out, fps=fps, width=W0, height=H0, start=a.start, **out)
    print(a.out, 'frames', len(rows), 'cuts', int(out['cut'].sum()), 'dup', int(out['dup'].sum()), 'mag mean', round(float(out['mag'].mean()), 2))


if __name__ == '__main__':
    main()
