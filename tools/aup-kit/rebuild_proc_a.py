#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「さくら」再現 2 巡目・担当 PROC_A: 手続きで描ける静止画 48 個を PIL + numpy で新しく描く。

- 元の素材(materials/・完成版の絵)は一切開かない。使う数値は look/geom.json の 大きさ・bbox と、目で見て決めた形・色だけ。
- 出力: /tmp/claude-1000/sakura-rebuild/PROC_A/out/<番号>.png(元と同じ画素の大きさ・同じ bbox)。
- 使い方:  rebuild_proc_a.py            (全部)
           rebuild_proc_a.py --only 21  (1 個だけ。カンマ区切りで複数)
           rebuild_proc_a.py --register (out/ の絵を project 37 に登録して置き換え表に書く。--only と併用可)
- 乱数は全部 種を固定(決定論)。
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

WORK = '/tmp/claude-1000/sakura-rebuild'
OUT = os.path.join(WORK, 'PROC_A', 'out')
GEOM = json.load(open(os.path.join(WORK, 'look', 'geom.json'), encoding='utf-8'))
ASSIGN = {x['i']: x for x in json.load(open(os.path.join(WORK, 'assign.json'), encoding='utf-8'))['PROC_A']}


# ───────────── 共通の部品 ─────────────
def G(i):
    g = GEOM[ASSIGN[i]['key']]
    return g['w'], g['h'], g['bbox']


def rgba(w, h, c=(0, 0, 0, 0)):
    return Image.new('RGBA', (w, h), c)


def down(im, ss):
    return im.resize((im.width // ss, im.height // ss), Image.LANCZOS)


def fit(im, bbox, W, H):
    """描いた絵の不透明部分を切り出し、元の bbox の位置・大きさに合わせて W×H に置く。"""
    bb = im.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    c = im.crop(bb).resize((bbox[2] - bbox[0], bbox[3] - bbox[1]), Image.LANCZOS)
    o = rgba(W, H)
    o.paste(c, (bbox[0], bbox[1]))
    return o


def spline(pts, n=14, closed=False):
    """Catmull-Rom でなめらかにつなぐ。"""
    P = [np.array(p, float) for p in pts]
    if closed:
        P = [P[-1]] + P + [P[0], P[1]]
    else:
        P = [P[0]] + P + [P[-1]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(n):
            t = k / n
            out.append(tuple(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)))
    if not closed:
        out.append(tuple(P[-2]))
    return out


def rot(pts, deg, c=(0, 0)):
    a = math.radians(deg)
    ca, sa = math.cos(a), math.sin(a)
    return [(c[0] + x * ca - y * sa, c[1] + x * sa + y * ca) for x, y in pts]


def noise(w, h, scale, seed):
    """なめらかな値ノイズ 0..1。"""
    rng = np.random.default_rng(seed)
    a = rng.random((max(2, int(h / scale) + 3), max(2, int(w / scale) + 3))).astype(np.float32)
    im = Image.fromarray(a, 'F').resize((w, h), Image.BICUBIC)
    return np.clip(np.asarray(im), 0, 1)


def fbm(w, h, scale, seed, octaves=4):
    out = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        out += amp * noise(w, h, max(1.0, scale / 2 ** o), seed + 101 * o)
        tot += amp
        amp *= 0.5
    return out / tot


def arr_img(a):
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def poly(d, pts, fill):
    d.polygon([(float(x), float(y)) for x, y in pts], fill=fill)


def mask_to_rgba(mask, color):
    im = Image.new('RGBA', mask.size, tuple(color[:3]) + (0,))
    im.putalpha(mask)
    return im


# ───────────── 桜の花びら・花 ─────────────
def petal_pts(L, Wd, notch=0.16, tipw=0.42, base=0.0, wide=0.66):
    """根元 (0,0) から +y へ伸びる花びら(先が 2 つに割れる)。L = 長さ、Wd = 半分の幅。"""
    left = spline([(0, base * L), (-0.30 * Wd, (base + 0.16) * L), (-0.80 * Wd, 0.44 * L), (-Wd, wide * L), (-0.86 * Wd, 0.85 * L), (-tipw * Wd, L)], 16)
    right = [(-x, y) for x, y in left][::-1]
    return left + [(0, (1 - notch) * L)] + right


def flower(S, c, L, Wd, cols, rot0=0.0, base=0.0, notch=0.16, top=None, tipw=0.42):
    """5 弁の花。cols = 花びらごとの色(0 = 上)。top = 上の花びらだけ別の (L, Wd, base)。"""
    im = rgba(S[0], S[1])
    d = ImageDraw.Draw(im)
    for k in range(5):
        l, w, b = (L, Wd, base) if (top is None or k) else top
        p = petal_pts(l, w, notch, base=b, tipw=tipw)
        p = [(x, -y) for x, y in p]
        poly(d, [(c[0] + x, c[1] + y) for x, y in rot(p, rot0 + 72 * k)], cols[k])
    return im


PINK = (207, 165, 167, 255)
PURPLE = (153, 143, 182, 255)


def sakura_title3(i):
    """#21 #27: 桃色の 4 弁 + 上だけ紫の細い 1 弁(すき間のある桜)。"""
    W, H, bb = G(i)
    ss = 4
    im = flower((W * ss, H * ss), (500 * ss, 500 * ss), 235 * ss, 60 * ss, [PURPLE] + [PINK] * 4, base=0.05, tipw=0.62, top=(232 * ss, 50 * ss, 0.0))
    return fit(im, bb, W, H)


def sakura_title(i):
    """#20: 桃色 5 弁の桜(弁は太く、中心でつながる)。"""
    W, H, bb = G(i)
    ss = 3
    im = flower((W * ss, H * ss), (960 * ss, 550 * ss), 445 * ss, 150 * ss, [PINK] * 5, rot0=-4, base=0.0, notch=0.2, tipw=0.6)
    return fit(im, bb, W, H)


def sakura_big(i):
    """#31: 大きい桜(上の弁は紫)+ 中心の緑の輪と しべの線。"""
    W, H, bb = G(i)
    ss = 2
    S = (W * ss, H * ss)
    c = (1500 * ss, 1560 * ss)
    im = flower(S, c, 1150 * ss, 330 * ss, [(157, 147, 188, 255)] + [(214, 173, 175, 255)] * 4, base=0.03, notch=0.17, tipw=0.62, top=(1150 * ss, 250 * ss, 0.0))
    d = ImageDraw.Draw(im)
    g = (40, 235, 40, 255)
    r = 120 * ss
    lw = 9 * ss
    d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], outline=g, width=lw)
    rng = np.random.default_rng(31)
    for k in range(5):
        for j in (-1, 0, 1):
            a = math.radians(72 * k + j * 19 + rng.uniform(-3, 3))
            l = (560 + rng.uniform(-60, 90)) * ss * (0.92 if j else 1.08)
            d.line([c[0] + math.sin(a) * r * 1.05, c[1] - math.cos(a) * r * 1.05, c[0] + math.sin(a) * l, c[1] - math.cos(a) * l], fill=g, width=lw)
    return fit(im, bb, W, H)


def petal_single(i):
    """#41: 花びら 1 枚(薄い桃色。割れた先が上、とがった根元が下、少し傾く)。"""
    W, H, bb = G(i)
    ss = 4
    im = rgba(W * ss, H * ss)
    d = ImageDraw.Draw(im)
    p = petal_pts(560 * ss, 135 * ss, notch=0.14, tipw=0.55, wide=0.62)
    p = [(x * (1.0 if x < 0 else 0.92) + 0.05 * y * 0.3, -y) for x, y in p]
    poly(d, [(500 * ss + x, 800 * ss + y) for x, y in rot(p, 3)], (255, 188, 229, 255))
    return fit(im, bb, W, H)


def sakura_mask(i):
    """#28: 白い 5 つ山の雲形(桜のマスク)。円 5 つ + 中心。山の 1 つは真下。"""
    W, H, bb = G(i)
    ss = 2
    im = rgba(W * ss, H * ss)
    d = ImageDraw.Draw(im)
    c, R, r = 1500 * ss, 730 * ss, 770 * ss
    for k in range(5):
        a = math.radians(180 + 72 * k)
        x, y = c + R * math.sin(a), c - R * math.cos(a)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 255))
    d.ellipse([c - R, c - R, c + R, c + R], fill=(255, 255, 255, 255))
    return fit(im, bb, W, H)


def arrows10(i):
    """#29: 中心から 36° おきに 10 本の矢(黄土色の軸 + えんじの矢じり + 灰色の縁)。"""
    W, H, bb = G(i)
    ss = 2
    S = W * ss
    im = rgba(S, S)
    L = 662 * ss
    for k in range(10):
        lay = rgba(S, S)
        d = ImageDraw.Draw(lay)
        c = S // 2
        sw = 19 * ss
        d.rectangle([c - sw, c - L * 0.78, c + sw, c], fill=(66, 55, 27, 255))
        d.rectangle([c - sw * 0.45, c - L * 0.78, c - sw * 0.2, c], fill=(92, 78, 36, 255))
        d.rectangle([c + sw * 0.2, c - L * 0.78, c + sw * 0.45, c], fill=(84, 60, 30, 255))
        hl, hw = 0.34 * L, 0.125 * L
        y0 = c - L
        head = [(c, y0), (c + hw, y0 + hl), (c, y0 + hl * 0.78), (c - hw, y0 + hl)]
        poly(d, head, (88, 84, 84, 215))
        inner = [(c, y0 + hl * 0.2), (c + hw * 0.62, y0 + hl * 0.88), (c, y0 + hl * 0.72), (c - hw * 0.62, y0 + hl * 0.88)]
        poly(d, inner, (63, 22, 20, 255))
        poly(d, [(c, y0 + hl * 0.2), (c + hw * 0.12, y0 + hl * 0.74), (c, y0 + hl * 0.72)], (120, 30, 28, 255))
        im.alpha_composite(lay.rotate(-36 * k, Image.BICUBIC))
    return fit(im, bb, W, H)


# ───────────── 単純な図形 ─────────────
def rhombus(i):
    """#15 #16: 白いひし形(bbox の各辺の中点が頂点)。"""
    W, H, bb = G(i)
    ss = 4
    im = rgba(W * ss, H * ss, (254, 254, 254, 0))
    x0, y0, x1, y1 = [v * ss for v in bb]
    poly(ImageDraw.Draw(im), [((x0 + x1) / 2, y0), (x1, (y0 + y1) / 2), ((x0 + x1) / 2, y1), (x0, (y0 + y1) / 2)], (254, 254, 254, 255))
    return down(im, ss)


def hexagon(i):
    """#4(白)#5(黒): とがりが上下の六角形。"""
    W, H, bb = G(i)
    col = (255, 255, 255) if i == 4 else (0, 0, 0)
    ss = 8
    im = rgba(W * ss, H * ss, col + (0,))
    w, h = bb[2] * ss, bb[3] * ss
    poly(ImageDraw.Draw(im), [(w / 2, 0), (w, h / 4), (w, h * 3 / 4), (w / 2, h), (0, h * 3 / 4), (0, h / 4)], col + (255,))
    return down(im, ss)


def skirt_cut(i):
    """#17 / #18(左右反転): 上辺が平らで、片側のすそが外へ反って広がる白い形。"""
    W, H, bb = G(i)
    ss = 4
    im = rgba(W * ss, H * ss, (255, 255, 255, 0))
    pts = []
    for k in range(101):
        t = k / 100
        pts.append(((1000 - 234 * t ** 2.4) * ss, (613 + 467 * t) * ss))
    pts += [(1920 * ss, 1080 * ss), (1920 * ss, 613 * ss)]
    poly(ImageDraw.Draw(im), pts, (255, 255, 255, 255))
    im = down(im, ss)
    if i == 18:
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    return im


def arc_band(i):
    """#19: 桃色の弓なりの帯(上が細く下へ太る。外側に玉 1 つと波形のふち、内側に小さなかえし)。"""
    W, H, bb = G(i)
    ss = 3
    im = rgba(W * ss, H * ss, (206, 167, 168, 0))
    d = ImageDraw.Draw(im)
    col = (206, 167, 168, 255)
    left = spline([(775, -5), (850, 150), (935, 290)], 10) + [(918, 303), (940, 325)] + spline([(940, 325), (958, 420), (972, 510), (988, 625), (984, 715), (958, 815), (915, 915), (870, 975), (820, 1040), (767, 1085)], 12)
    right = spline([(835, -5), (890, 130), (938, 262), (975, 360), (1012, 440), (1050, 540), (1064, 640), (1060, 720), (1050, 790), (1036, 880), (1015, 970), (985, 1085)], 12)
    poly(d, [(x * ss, y * ss) for x, y in left + right[::-1]], col)
    for x, y, r in [(965, 310, 38), (992, 372, 22), (1016, 408, 22), (1032, 442, 21), (1046, 480, 20), (1056, 522, 20), (1065, 570, 21), (1071, 622, 22), (1070, 680, 22),
                    (1066, 735, 22), (1058, 790, 22), (1048, 842, 22), (1040, 880, 18)]:
        d.ellipse([(x - r) * ss, (y - r) * ss, (x + r) * ss, (y + r) * ss], fill=col)
    return fit(down(im, ss), bb, W, H)


def quarter_circles(i):
    """#24: 四すみに半径 1500 の四分円(左上・右下 = 青緑、右上・左下 = 黄)。"""
    W, H, bb = G(i)
    ss = 2
    S = W * ss
    im = rgba(S, S)
    d = ImageDraw.Draw(im)
    r = S // 2
    teal, yel = (107, 172, 191, 255), (238, 202, 103, 255)
    for cx, cy, c in [(0, 0, teal), (S, 0, yel), (0, S, yel), (S, S, teal)]:
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
    return down(im, ss)


def stripes(i):
    """#26: 横じま 5 本(サーモン・生成り・サーモン・生成り・サーモン、各 216px)。"""
    W, H, bb = G(i)
    im = Image.new('RGB', (W, H), (255, 160, 148))
    d = ImageDraw.Draw(im)
    for k in (1, 3):
        d.rectangle([0, k * H // 5, W, (k + 1) * H // 5 - 1], fill=(244, 238, 230))
    return im


def rays(i):
    """#49: 画面の右上の外の 1 点から広がる放射の帯(桃色と淡い黄。すき間は透明)。"""
    W, H, bb = G(i)
    ss = 3
    im = rgba(W * ss, H * ss)
    d = ImageDraw.Draw(im)
    O = (1593, -90)
    pink, cream = (240, 169, 191, 255), (242, 233, 186, 255)

    def far(p):
        return (O[0] + (p[0] - O[0]) * 4, O[1] + (p[1] - O[1]) * 4)

    wedges = [((-3000, -90), (0, 380), pink), ((0, 756), (0, 960), cream), ((0, 960), (674, 1080), pink), ((1021, 1080), (1164, 1080), cream),
              ((1164, 1080), (1544, 1080), pink), ((1785, 1080), (1935, 1080), cream), ((1920, 390), (1920, 150), pink), ((1920, 150), (1920, 40), cream)]
    for a, b, c in wedges:
        poly(d, [(x * ss, y * ss) for x, y in (O, far(a), far(b))], c)
    return down(im, ss)


def burst(i):
    """#50(白)#51(黄)#52(橙): 長さの不ぞろいなとげの爆発形。"""
    W, H, bb = G(i)
    col, n, seed = {50: ((255, 255, 255), 16, 5001), 51: ((255, 205, 59), 15, 5103), 52: ((229, 132, 59), 17, 5207)}[i]
    rng = np.random.default_rng(seed)
    ss = 2
    S = W * ss
    im = rgba(S, S, col + (0,))
    pts = []
    for k in range(n):
        a0 = 2 * math.pi * (k + rng.uniform(-0.22, 0.22)) / n
        a1 = 2 * math.pi * (k + 0.5 + rng.uniform(-0.12, 0.12)) / n
        ro = S * 0.45 * rng.uniform(0.66, 1.0) * (1.0 + 0.15 * math.cos(2 * (a0 - 0.9)))
        ri = S * 0.45 * rng.uniform(0.42, 0.54)
        pts += [(S / 2 + ro * math.cos(a0), S / 2 + ro * math.sin(a0)), (S / 2 + ri * math.cos(a1), S / 2 + ri * math.sin(a1))]
    poly(ImageDraw.Draw(im), pts, col + (255,))
    return fit(im, bb, W, H)


def corner_checker(i):
    """#61: 左上と右下のすみに、階段状に欠ける 60px の濃い灰色の市松。"""
    W, H, bb = G(i)
    im = rgba(W, H, (58, 58, 58, 0))
    d = ImageDraw.Draw(im)
    c = (58, 58, 58, 255)
    for r in range(8):
        for q in range(8 - r):
            if (q + r) % 2:
                d.rectangle([-8 + 60 * q, -5 + 60 * r, -8 + 60 * q + 59, -5 + 60 * r + 59], fill=c)
    for r in range(9):
        for q in range(9 - r):
            if (q + r) % 2 == 0:
                d.rectangle([W - 60 * (q + 1), H - 60 * (r + 1), W - 60 * q - 1, H - 60 * r - 1], fill=c)
    return im


def railing(i):
    """#62: 画面の下 1/3 に細い濃い線の、ところどころ欠けた格子(手すり・組子ふう)。"""
    W, H, bb = G(i)
    ss = 2
    im = rgba(W * ss, H * ss, (52, 50, 52, 0))
    d = ImageDraw.Draw(im)
    rng = np.random.default_rng(62)
    c = (52, 50, 52, 235)
    ys = [687, 807, 925, 1045, 1165]
    xs = list(range(77 - 118, W + 118, 118))
    lw = 3 * ss
    for r, y in enumerate(ys[:-1]):
        for k, x in enumerate(xs[:-1]):
            if r == 0 or rng.random() > 0.22:
                d.line([x * ss, y * ss, xs[k + 1] * ss, y * ss], fill=c, width=lw)
            if rng.random() > 0.2:
                d.line([x * ss, y * ss, x * ss, ys[r + 1] * ss], fill=c, width=lw)
    return down(im, ss)


def window_frame(i):
    """#46: 濃い色の格子の窓枠(外枠・内枠・中央のひし形・上下の小さい仕切り)+ 四すみの赤い四角。"""
    W, H, bb = G(i)
    ss = 2
    im = rgba(W * ss, H * ss, (65, 53, 58, 0))
    d = ImageDraw.Draw(im)
    dk, red = (65, 53, 58, 255), (225, 55, 57, 255)
    x0, y0, x1, y1 = [v * ss for v in bb]
    w, h = x1 - x0, y1 - y0
    lw = 40 * ss

    def X(f):
        return x0 + w * f

    def Y(f):
        return y0 + h * f

    def line(a, b):
        d.line([a, b], fill=dk, width=lw)
        for p in (a, b):
            d.rectangle([p[0] - lw / 2, p[1] - lw / 2, p[0] + lw / 2, p[1] + lw / 2], fill=dk)

    vx, hy = (0.2, 0.8), (0.143, 0.857)
    for cx in ((0, vx[0]), (vx[1], 1)):
        for cy in ((0, hy[0]), (hy[1], 1)):
            d.rectangle([X(cx[0]), Y(cy[0]), X(cx[1]), Y(cy[1])], fill=red)
    h2 = lw / 2
    for f in (0, 1):
        line((X(0) + h2 if f == 0 else X(1) - h2, Y(0) + h2), (X(0) + h2 if f == 0 else X(1) - h2, Y(1) - h2))
        line((X(0) + h2, Y(0) + h2 if f == 0 else Y(1) - h2), (X(1) - h2, Y(0) + h2 if f == 0 else Y(1) - h2))
    for f in vx:
        line((X(f), Y(0) + h2), (X(f), Y(1) - h2))
    for f in hy:
        line((X(0) + h2, Y(f)), (X(1) - h2, Y(f)))
    for f in (0.4, 0.6):
        line((X(f), Y(0) + h2), (X(f), Y(hy[0])))
        line((X(f), Y(hy[1])), (X(f), Y(1) - h2))
    line((X(0) + h2, Y(0.5)), (X(vx[0]), Y(0.5)))
    line((X(vx[1]), Y(0.5)), (X(1) - h2, Y(0.5)))
    dm = [(X(0.5), Y(hy[0])), (X(vx[1]), Y(0.5)), (X(0.5), Y(hy[1])), (X(vx[0]), Y(0.5))]
    for k in range(4):
        d.line([dm[k], dm[(k + 1) % 4]], fill=dk, width=lw)
    return down(im, ss)


# ───────────── 矢絣・すりガラス ─────────────
def yagasuri(W, H, colw, period, rise, ca, cb, shaft=None, halftone=0.0, seed=0, grain=0.0):
    """矢絣: 幅 colw の列ごとに、上向きの山形で 2 色が交互(となりの列は半周期ずれる)。"""
    ss = 2
    y, x = np.mgrid[0:H * ss, 0:W * ss].astype(np.float32) / ss
    c = np.floor(x / colw)
    xx = x - c * colw
    dd = np.abs(xx - colw / 2)
    yy = y - (colw / 2 - dd) * (rise / (colw / 2)) * -1 + (c % 2) * period / 2
    band = (np.floor(yy / (period / 2)) % 2)
    out = np.where(band[..., None] > 0, np.array(ca, np.float32), np.array(cb, np.float32))
    if halftone:
        out = out + ((xx > colw / 2) * 2 - 1)[..., None] * halftone * (band[..., None] * 2 - 1)
    if shaft:
        m = (dd < shaft[0] / 2)[..., None]
        out = np.where(m, out + np.array(shaft[1], np.float32), out)
        m2 = ((xx < shaft[0] / 2) | (xx > colw - shaft[0] / 2))[..., None]
        out = np.where(m2, out + np.array(shaft[1], np.float32) * 0.6, out)
    if grain:
        out = out + (noise(W * ss, H * ss, 3, seed)[..., None] - 0.5) * grain
    return down(arr_img(out).convert('RGB'), ss)


def yagasuri_black(i):
    """#0: ほぼ黒の矢絣(黒と こげ茶、列 64px)。"""
    W, H, bb = G(i)
    return yagasuri(W, H, 61.5, 212, 20, (25, 16, 16), (10, 8, 6), grain=3, seed=1)


def yagasuri_navy(i):
    """#30: 濃い青灰の細かい矢絣(2 色の差はごく小さい。列 32px + 細い縦線)。"""
    W, H, bb = G(i)
    return yagasuri(W, H, 25, 106, 9, (60, 65, 76), (53, 58, 69), shaft=(2, (-5, -5, -5)), halftone=1.0, grain=2, seed=30)


def yagasuri_white(i):
    """#57: 白い矢絣(列 30px、羽の左右でわずかに濃淡 + 軸の線)。"""
    W, H, bb = G(i)
    return yagasuri(W, H, 25, 107.5, 10, (243, 243, 241), (232, 232, 229), shaft=(2, (-4, -4, -4)), halftone=2.0, grain=2, seed=57)


def yagasuri_dark(i):
    """#58: 黒と灰色の細い矢絣(列 24px + 軸の細い線)。"""
    W, H, bb = G(i)
    return yagasuri(W, H, 25, 107.5, 10, (60, 60, 61), (26, 20, 26), shaft=(1.6, (-12, -12, -12)), grain=3, seed=58)


def frosted(i):
    """#3: すりガラス(明るい灰色の小さい丸がつながった ぶち模様。すき間は透明、面積の約 7 割)。"""
    W, H, bb = G(i)
    ss = 2
    rng = np.random.default_rng(3)
    f = fbm(W // 2, H // 2, 9, 303, 2)
    thr = np.quantile(f, 0.36)
    ok = f > thr
    m = Image.new('L', (W * ss, H * ss), 0)
    d = ImageDraw.Draw(m)
    n = 0
    while n < 22500:
        xs = rng.integers(0, W, 4000)
        ys = rng.integers(0, H, 4000)
        for x, y in zip(xs, ys):
            if ok[min(H // 2 - 1, y // 2), min(W // 2 - 1, x // 2)]:
                r = rng.uniform(5.5, 7.5) * ss
                d.ellipse([x * ss - r, y * ss - r, x * ss + r, y * ss + r], fill=255)
                n += 1
    m = down(m, ss)
    tone = 206 + (fbm(W, H, 40, 33, 2) - 0.5) * 10
    rgb = np.repeat(tone[..., None], 3, 2)
    im = arr_img(rgb).convert('RGB').convert('RGBA')
    im.putalpha(m)
    return im


# ───────────── ハートの渦巻き・ひし形の紋・りんご ─────────────
def heart_mark(S, fg=(0, 0, 0, 255), hole=None):
    """渦巻きの抜けたハート(+ 左下へ流れる玉つきのしっぽ)。S×S の RGBA。hole = 渦の色(None なら透明)。"""
    ss = 2
    n = S * ss
    m = Image.new('L', (n, n), 0)
    d = ImageDraw.Draw(m)
    pts = []
    for k in range(240):
        t = 2 * math.pi * k / 240
        x = 16 * math.sin(t) ** 3
        y = -(13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t))
        pts.append((x * 1.05, y * 0.98))
    pts = rot(pts, 6)
    sc = n * 0.0265
    cx, cy = n * 0.52, n * 0.44
    poly(d, [(cx + x * sc, cy + y * sc) for x, y in pts], 255)
    # しっぽ(下の先から左下へ弓なりに伸びて玉で終わる)
    tail = spline([(0.70, 0.66), (0.60, 0.80), (0.48, 0.895), (0.37, 0.925), (0.30, 0.90)], 20)
    for k, (x, y) in enumerate(tail):
        r = n * (0.012 + 0.03 * math.sin(math.pi * min(1, k / len(tail) * 1.15)) ** 0.8)
        d.ellipse([x * n - r, y * n - r, x * n + r, y * n + r], fill=255)
    r = n * 0.055
    d.ellipse([0.30 * n - r, 0.875 * n - r, 0.30 * n + r, 0.875 * n + r], fill=255)
    # 渦(中心から反時計回りに 1.4 周、外へ太る。最後は右上へ開く)
    h = Image.new('L', (n, n), 0)
    dh = ImageDraw.Draw(h)
    sx, sy = 0.50 * n, 0.50 * n
    N = 260
    for k in range(N):
        u = k / (N - 1)
        a = math.radians(200 - 620 * u)
        rr = n * (0.015 + 0.16 * u ** 1.1)
        x, y = sx + rr * math.cos(a) * 0.95, sy + rr * math.sin(a) * 1.08
        w = n * (0.016 + 0.022 * u)
        if u > 0.9:
            w *= max(0.25, (1 - u) / 0.1)
        dh.ellipse([x - w, y - w, x + w, y + w], fill=255)
    # 渦の下に沿うすき間(本体としっぽを分ける弓形)
    for k, (x, y) in enumerate(spline([(0.76, 0.62), (0.66, 0.74), (0.55, 0.815), (0.44, 0.84)], 30)):
        w = n * (0.007 * (1 - k / 95))
        dh.ellipse([x * n - w, y * n - w, x * n + w, y * n + w], fill=255)
    body = ImageChops.subtract(m, h)
    im = mask_to_rgba(body, fg)
    if hole is not None:
        under = mask_to_rgba(ImageChops.multiply(m, h), hole)
        under.alpha_composite(im)
        im = under
    return down(im, ss)


def heart_black(i):
    """#53: 黒い「渦巻きの抜けたハート」。"""
    W, H, bb = G(i)
    return fit(heart_mark(1600), bb, W, H)


def gem_mark(S, fg, bg_hole=None, ang=0.0):
    """ひし形(辺が内へ反る 4 つとがり)に、長い軸に沿った目の形の抜け。"""
    ss = 3
    n = S * ss
    m = Image.new('L', (n, n), 0)
    d = ImageDraw.Draw(m)
    c = n / 2
    L, Sh = n * 0.47, n * 0.31
    tips = [(0, -L), (Sh, 0), (0, L), (-Sh, 0)]
    pts = []
    for k in range(4):
        a, b = tips[k], tips[(k + 1) % 4]
        mid = ((a[0] + b[0]) * 0.5 * 0.68, (a[1] + b[1]) * 0.5 * 0.68)
        for t in np.linspace(0, 1, 14, endpoint=False):
            pts.append(((1 - t) ** 2 * a[0] + 2 * t * (1 - t) * mid[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * t * (1 - t) * mid[1] + t * t * b[1]))
    poly(d, [(c + x, c + y) for x, y in pts], 255)
    h = Image.new('L', (n, n), 0)
    dh = ImageDraw.Draw(h)
    lens = []
    for t in np.linspace(-1, 1, 40):
        lens.append((n * 0.075 * (1 - t * t) + n * 0.02 * t, t * L * 0.6))
    for t in np.linspace(1, -1, 40):
        lens.append((-n * 0.075 * (1 - t * t) + n * 0.02 * t, t * L * 0.6))
    poly(dh, [(c + x, c + y) for x, y in lens], 255)
    core = []
    for t in np.linspace(-1, 1, 30):
        core.append((n * 0.032 * (1 - t * t) + n * 0.02 * t, t * L * 0.42))
    for t in np.linspace(1, -1, 30):
        core.append((-n * 0.032 * (1 - t * t) + n * 0.02 * t, t * L * 0.42))
    poly(dh, [(c + x, c + y) for x, y in core], 0)
    body = ImageChops.subtract(m, h)
    im = mask_to_rgba(body, fg).rotate(ang, Image.BICUBIC)
    return down(im, ss)


def tile_pattern(W, H, bg, sprite, a, b, origin=(0, 0)):
    """sprite を格子 (a, b) で敷きつめる(2 倍で描いて縮小)。"""
    ss = 2
    im = Image.new('RGBA', (W * ss, H * ss), tuple(bg) + (255,))
    sp = sprite
    det = a[0] * b[1] - a[1] * b[0]
    R = 40
    for p in range(-R, R):
        for q in range(-R, R):
            x = origin[0] + p * a[0] + q * b[0]
            y = origin[1] + p * a[1] + q * b[1]
            if -200 < x < W + 200 and -200 < y < H + 200:
                im.alpha_composite(sp, (int(round(x * ss - sp.width / 2)) + 0, int(round(y * ss - sp.height / 2)))) if (0 <= int(round(x * ss - sp.width / 2)) and 0 <= int(round(y * ss - sp.height / 2))) else _paste_clip(im, sp, int(round(x * ss - sp.width / 2)), int(round(y * ss - sp.height / 2)))
    return down(im, ss).convert('RGB')


def _paste_clip(im, sp, x, y):
    x0, y0 = max(0, -x), max(0, -y)
    if x0 >= sp.width or y0 >= sp.height or x >= im.width or y >= im.height:
        return
    im.alpha_composite(sp.crop((x0, y0, sp.width, sp.height)), (x + x0, y + y0))


P33 = dict(size=96, ang=-30, a=(87, 48), b=(-48, 87))


def gem_pattern(i):
    """#33(青緑の地に白)#35(青緑の地に緑): ひし形の紋を斜めの格子で敷いた柄。"""
    W, H, bb = G(i)
    fg = (255, 255, 255, 255) if i == 33 else (0, 255, 0, 255)
    sp = gem_mark(P33['size'] * 2, fg, ang=P33['ang'])
    return tile_pattern(W, H, (107, 172, 191), sp, P33['a'], P33['b'], origin=(30, 20))


P34 = dict(size=92, ang=16, a=(87, 48), b=(-48, 87))


def heart_pattern(i):
    """#34: 黄色の地に、白い渦巻きハートを斜めの格子で敷いた柄。"""
    W, H, bb = G(i)
    sp = heart_mark(P34['size'] * 2, fg=(255, 255, 255, 255), hole=(239, 203, 103, 255)).rotate(P34['ang'], Image.BICUBIC)
    return tile_pattern(W, H, (239, 203, 103), sp, P34['a'], P34['b'], origin=(40, 30))


def apple_mask(n, seed=0):
    """りんごの輪郭(2 つの山 + 上のくぼみ、下がややすぼむ)。n×n の L。"""
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    x = (x / n - 0.5) * 2.3
    y = (y / n - 0.52) * 2.3
    xs = x * (1 + 0.16 * y)
    f = np.minimum(((xs - 0.2) / 0.66) ** 2 + (y / 0.82) ** 2, ((xs + 0.2) / 0.66) ** 2 + (y / 0.82) ** 2)
    dip = ((x) / 0.2) ** 2 + ((y + 0.9) / 0.22) ** 2
    m = ((f < 1) & (dip > 1)).astype(np.float32) * 255
    im = Image.fromarray(m.astype(np.uint8)).filter(ImageFilter.GaussianBlur(n * 0.012))
    return im.point(lambda v: 255 if v > 127 else 0).filter(ImageFilter.GaussianBlur(max(0.6, n * 0.002)))


def apple_whole(n, light, dark, seed=36, tilt=-8, thr=0.62):
    """版画ふうのりんご 1 個(点描の陰 + 軸)。透明地の RGBA n×n。"""
    m = apple_mask(n)
    mm = np.asarray(m, np.float32) / 255
    y, x = np.mgrid[0:n, 0:n].astype(np.float32) / n
    shade = 0.55 + 0.9 * (x - 0.5) + 0.5 * (y - 0.5)        # 右下が暗い
    edge = np.asarray(m.filter(ImageFilter.GaussianBlur(n * 0.05)), np.float32) / 255
    shade += (1 - edge) * 1.2                                # ふちは暗い
    shade -= 0.5 * np.exp(-(((x - 0.36) / 0.16) ** 2 + ((y - 0.5) / 0.22) ** 2))   # 左のつや
    tex = 0.55 * fbm(n, n, n / 14, seed, 3) + 0.45 * noise(n, n, max(1.5, n / 110), seed + 7)
    crease = np.abs(fbm(n, n, n / 5, seed + 3, 2) - 0.5) < 0.035   # しわの線
    dk = ((tex + (shade - 0.5) * 0.55) > thr) | (crease & (x > 0.42))
    col = np.where(dk[..., None], np.array(dark, np.float32), np.array(light, np.float32))
    im = arr_img(col).convert('RGB').convert('RGBA')
    im.putalpha(m)
    # ふちの線と軸
    ol = ImageChops.subtract(m, m.filter(ImageFilter.MinFilter(max(3, int(n * 0.012) | 1))))
    im.alpha_composite(mask_to_rgba(ol, dark))
    d = ImageDraw.Draw(im)
    st = spline([(0.5, 0.16), (0.49, 0.09), (0.47, 0.02)], 8)
    d.line([(px * n, py * n) for px, py in st], fill=tuple(dark) + (255,), width=max(2, int(n * 0.018)))
    return im.rotate(tilt, Image.BICUBIC)


def apple_half(n, face, peel, seed=37, tilt=-18):
    """半分に切ったりんご(白い切り口 + 下の皮の厚み + 芯と種)。透明地の RGBA n×n。"""
    ss = 2
    N = n * ss
    im = rgba(N, N)
    d = ImageDraw.Draw(im)
    c = N / 2

    def ell(cx, cy, rx, ry, fill):
        d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=fill)

    ell(c, c + N * 0.035, N * 0.44, N * 0.33, tuple(peel) + (255,))      # 皮(下にずれた楕円)
    ell(c, c - N * 0.02, N * 0.44, N * 0.30, tuple(face) + (255,))        # 切り口
    # 上のくぼみ(軸の所)
    ell(c - N * 0.03, c - N * 0.335, N * 0.03, N * 0.035, (0, 0, 0, 0))
    d.line([c - N * 0.03, c - N * 0.30, c - N * 0.018, c - N * 0.14], fill=tuple(peel) + (255,), width=max(2, int(N * 0.008)))
    # 芯と種
    for sx in (-1, 1):
        seedp = [(sx * 0.015, -0.07), (sx * 0.085, -0.02), (sx * 0.07, 0.07), (sx * 0.02, 0.1)]
        poly(d, [(c + x * N, c + y * N) for x, y in spline(seedp, 8, closed=True)], tuple(peel) + (255,))
    rng = np.random.default_rng(seed)
    for k in range(26):
        x, y = c + rng.normal(0, N * 0.035), c + rng.normal(0.01 * N, N * 0.05)
        r = rng.uniform(0.003, 0.009) * N
        ell(x, y, r, r, tuple(peel) + (255,))
    im = down(im, ss)
    # 皮の点描
    a = np.asarray(im).copy()
    isp = (np.abs(a[..., :3].astype(int) - np.array(peel)).sum(-1) < 12) & (a[..., 3] > 200)
    sp = noise(n, n, max(1.5, n / 90), seed + 5) > 0.72
    a[isp & sp, :3] = np.array(face) * 0.82
    return Image.fromarray(a).rotate(tilt, Image.BICUBIC)


LIGHT_T, GRAY_T = (234, 231, 230), (146, 144, 144)
INK = (104, 102, 102)


def apple_tile(kind, n):
    """ひし形のタイル n×n(RGBA)。kind 0 = 明るい地に丸ごとのりんご、1 = 灰色の地に半分のりんご。"""
    ss = 2
    N = n * ss
    im = rgba(N, N, (LIGHT_T if kind == 0 else GRAY_T) + (0,))
    poly(ImageDraw.Draw(im), [(N / 2, 0), (N, N / 2), (N / 2, N), (0, N / 2)], (LIGHT_T if kind == 0 else GRAY_T) + (255,))
    im = down(im, ss)
    s = int(n * 0.58)
    ap = apple_whole(s, (240, 238, 237), INK, tilt=-10) if kind == 0 else apple_half(s, (250, 250, 250), (112, 110, 110))
    im.alpha_composite(ap, ((n - s) // 2, (n - s) // 2 + (int(n * 0.02) if kind == 0 else 0)))
    return im


def apple_tiles(i):
    """#36(丸ごとのりんご・明るいひし形)#37(半分のりんご・灰色のひし形)。"""
    W, H, bb = G(i)
    return down(apple_tile(0 if i == 36 else 1, W * 3), 3)


def apple_floor(i):
    """#38: りんごのタイル 2 種を市松に敷いた床を、斜め上から見下ろした透視図(透視変換は自前)。"""
    W, H, bb = G(i)
    T = 900
    t0 = np.asarray(apple_tile(0, T).convert('RGB'), np.float32)
    t1 = np.asarray(apple_tile(1, T).convert('RGB'), np.float32)
    # ひし形の外は地の色で埋める(となりのタイルとの継ぎ目の色ずれを防ぐ)
    ss = 3
    yh, k, yaw, cx, FOC = -240.0, 0.42, math.radians(10), 960.0, 1500.0
    sy, sx = np.mgrid[0:H * ss, 0:W * ss].astype(np.float32)
    sx = (sx + 0.5) / ss
    sy = (sy + 0.5) / ss
    z = 1.0 / (sy - yh)                 # 奥行き(高さ 1 のカメラ)
    u0 = (sx - cx) * z
    v0 = FOC * z
    u = u0 * math.cos(yaw) - v0 * math.sin(yaw)
    v = u0 * math.sin(yaw) + v0 * math.cos(yaw)
    p = (u + v) / (math.sqrt(2) * k) + 0.37
    q = (u - v) / (math.sqrt(2) * k) + 0.11
    ip, iq = np.floor(p), np.floor(q)
    fp, fq = p - ip, q - iq
    kind = ((ip + iq) % 2).astype(bool)
    ix = np.clip((0.5 + (fp - 0.5) * 0.5 + (fq - 0.5) * 0.5) * T, 0, T - 1).astype(np.int32)
    iy = np.clip((0.5 - (fp - 0.5) * 0.5 + (fq - 0.5) * 0.5) * T, 0, T - 1).astype(np.int32)
    out = np.where(kind[..., None], t1[iy, ix], t0[iy, ix])
    return down(arr_img(out).convert('RGB'), ss)


P32 = dict(size=106, a=(86, 48), b=(-52, 94))


def apple_pattern(i):
    """#32: 生成りの地に、ごく淡いサーモン色の版画ふうのりんごを斜めの格子で敷いた柄。"""
    W, H, bb = G(i)
    sp = apple_whole(P32['size'] * 2, (248, 234, 224), (252, 215, 200), seed=32, tilt=-15, thr=0.53)
    return tile_pattern(W, H, (245, 236, 228), sp, P32['a'], P32['b'], origin=(20, 40))


# ───────────── ソウルジェムの枠 ─────────────
def gem_masks(ss=2):
    """ソウルジェム(卵形の宝石を抱く金の台)の 金・緑・赤 のマスク(3000×3000 の ss 倍)。"""
    n = 3000 * ss
    gold = Image.new('L', (n, n), 0)
    green = Image.new('L', (n, n), 0)
    red = Image.new('L', (n, n), 0)
    dg, dn, dr = ImageDraw.Draw(gold), ImageDraw.Draw(green), ImageDraw.Draw(red)

    def P(pts):
        return [(x * ss, y * ss) for x, y in pts]

    def mir(pts):
        return pts + [(3000 - x, y) for x, y in pts[::-1]]

    def ell(d, cx, cy, rx, ry, f=255):
        d.ellipse([(cx - rx) * ss, (cy - ry) * ss, (cx + rx) * ss, (cy + ry) * ss], fill=f)

    # 上の飾り(とがり・赤い石の座・首)
    dg.polygon(P([(1500, 81), (1462, 165), (1538, 165)]), fill=255)
    ell(dg, 1500, 228, 64, 108)
    dg.polygon(P([(1500, 150), (1420, 215), (1500, 250), (1580, 215)]), fill=255)
    dg.polygon(P(mir(spline([(1468, 318), (1458, 400), (1420, 452), (1330, 486), (1300, 520), (1330, 560)], 8))), fill=255)
    # 枠の帯と玉
    ell(dg, 1500, 1320, 712, 800)
    for a in (17, 31, 46, 61, 76, 91, 104):
        for s in (-1, 1):
            r = math.radians(a)
            ell(dg, 1500 + s * 722 * math.sin(r), 1320 - 808 * math.cos(r), 50, 50)
    # 宝石(緑)
    ell(dn, 1500, 1320, 622, 715)
    # 受け皿(上の縁は中央へ下がる V、外側は丸く、下へ 3 段の段がついてすぼむ)
    cup_l = spline([(1500, 2040), (1330, 1950), (1100, 1790), (890, 1630)], 10) + [(800, 1560), (772, 1420), (738, 1300), (700, 1292)] + \
        spline([(668, 1480), (652, 1600), (655, 1760), (690, 1900)], 8) + [(690, 1900), (735, 1915), (722, 1975), (772, 1992), (765, 2050), (818, 2070)] + \
        spline([(818, 2070), (930, 2230), (1080, 2350), (1180, 2420)], 8)
    dg.polygon(P(mir(cup_l)), fill=255)
    # 枠と腕のすき間(緑が見える細い三角)
    for s in (-1, 1):
        tri = [(1500 + s * 742, 1392), (1500 + s * 716, 1560), (1500 + s * 772, 1560)]
        dn.polygon(P(tri), fill=255)
    # 首輪と足
    dg.polygon(P(mir(spline([(1180, 2420), (1150, 2450), (1140, 2520), (1160, 2590), (1250, 2610)], 8))), fill=255)
    dg.polygon(P(mir(spline([(1250, 2600), (1215, 2660), (1090, 2712), (960, 2738)], 8) + [(955, 2746)])), fill=255)
    # 赤い石
    ell(dr, 1500, 228, 37, 80)
    return gold, green, red


def soulgem_flat(i):
    """#47(青い地)#48(こげ茶の地): ソウルジェムの枠のべた塗り(金の台 + 緑の卵 + 赤い石)。"""
    W, H, bb = G(i)
    ss = 2
    gold, green, red = gem_masks(ss)
    bg = (0, 0, 255) if i == 47 else (55, 45, 52)
    im = Image.new('RGB', gold.size, bg)
    im.paste((0, 255, 0), mask=green)
    cut = ImageChops.subtract(gold, Image.new('L', gold.size, 0))
    # 緑は金の内側のだ円だけ(受け皿・帯は金が上)
    ring = gold.copy()
    inner = Image.new('L', gold.size, 0)
    ImageDraw.Draw(inner).ellipse([(1500 - 622) * ss, (1320 - 715) * ss, (1500 + 622) * ss, (1320 + 715) * ss], fill=255)
    cup = cup_only(ss)
    ring = ImageChops.lighter(ImageChops.subtract(gold, inner), ImageChops.multiply(gold, cup))
    im.paste((239, 203, 102), mask=ring)
    tri = ImageChops.subtract(green, inner)
    im.paste((0, 255, 0), mask=tri)
    im.paste((196, 30, 60), mask=red)
    return down(im, ss)


def cup_only(ss):
    """受け皿より下(金が緑の上にかぶさる所)のマスク。"""
    n = 3000 * ss
    m = Image.new('L', (n, n), 0)
    d = ImageDraw.Draw(m)
    pts = spline([(1500, 2040), (1330, 1950), (1100, 1790), (890, 1630)], 10) + [(800, 1560), (640, 1560), (640, 2800)]
    pts = pts + [(3000 - x, y) for x, y in pts[::-1]]
    d.polygon([(x * ss, y * ss) for x, y in pts], fill=255)
    return m


def soulgem_3d(i):
    """#63: ソウルジェムの枠の立体ふう(金の面取り陰影 + 受け皿の浮き彫り + 緑の卵 + 赤い石。地は透明)。"""
    W, H, bb = G(i)
    ss = 1
    gold, green, red = gem_masks(ss)
    n = gold.size[0]
    inner = Image.new('L', gold.size, 0)
    ImageDraw.Draw(inner).ellipse([(1500 - 622) * ss, (1320 - 715) * ss, (1500 + 622) * ss, (1320 + 715) * ss], fill=255)
    cup = cup_only(ss)
    gmask = ImageChops.lighter(ImageChops.subtract(gold, inner), ImageChops.multiply(gold, cup))
    # 浮き彫り(受け皿の円の飾り・首輪のひだ)を高さに足す
    emb = Image.new('L', gold.size, 0)
    de = ImageDraw.Draw(emb)
    for r, w in ((210, 26), (120, 22), (55, 55)):
        de.ellipse([1500 - r, 2210 - r * 0.8, 1500 + r, 2210 + r * 0.8], outline=255, width=w)
    for s in (-1, 1):
        for k, (x, y, r) in enumerate([(330, 1940, 60), (450, 1870, 48), (560, 1790, 38), (640, 1700, 30)]):
            de.ellipse([1500 + s * x - r, y - r, 1500 + s * x + r, y + r], outline=255, width=16)
        de.arc([1500 - 700, 1500, 1500 + 700, 2380], 20 if s > 0 else 110, 70 if s > 0 else 160, fill=255, width=22)
    for x in range(1170, 1840, 74):
        de.rounded_rectangle([x, 2440, x + 50, 2600], 22, fill=255)
    hgt = np.asarray(gmask.filter(ImageFilter.GaussianBlur(34)), np.float32) / 255 * 1.0
    hgt += np.asarray(gmask.filter(ImageFilter.GaussianBlur(9)), np.float32) / 255 * 0.25
    hgt += np.asarray(ImageChops.multiply(emb, gmask).filter(ImageFilter.GaussianBlur(7)), np.float32) / 255 * 0.16
    gy, gx = np.gradient(hgt)
    lx, ly = -0.55, -0.75
    lit = (gx * lx + gy * ly) * 55
    y = np.mgrid[0:n, 0:n][0].astype(np.float32) / n
    base = np.array([247, 214, 88], np.float32)
    col = base[None, None, :] * (0.97 + 0.06 * (0.5 - y[..., None]))
    col = col + np.clip(lit, -1, 1)[..., None] * np.array([28, 42, 70], np.float32) * np.where(lit[..., None] > 0, 1.0, 1.5)
    col = col + np.clip(lit - 0.25, 0, 1)[..., None] * np.array([10, 30, 90], np.float32)
    im = arr_img(col).convert('RGB').convert('RGBA')
    im.putalpha(gmask)
    out = rgba(n, n)
    gr = ImageChops.subtract(green, gmask)
    out.alpha_composite(mask_to_rgba(gr, (0, 255, 0)))
    out.alpha_composite(im)
    out.alpha_composite(mask_to_rgba(red, (214, 28, 44)))
    hl = Image.new('L', (n, n), 0)
    ImageDraw.Draw(hl).ellipse([1482, 170, 1500, 230], fill=150)
    out.alpha_composite(mask_to_rgba(hl.filter(ImageFilter.GaussianBlur(5)), (255, 170, 160)))
    return fit(out, bb, W, H)


def red_ornament(i):
    """#39: えんじ色のひし形の飾り(四すみに小さな房、中に赤く光る灯籠形 + 細かい金茶の模様)。"""
    W, H, bb = G(i)
    ss = 8
    w, h = W * ss, H * ss
    im = rgba(w, h)
    d = ImageDraw.Draw(im)
    cx, cy = w / 2, h / 2
    rx, ry = w * 0.455, h * 0.44
    dia = [(cx, cy - ry), (cx + rx, cy), (cx, cy + ry), (cx - rx, cy)]
    poly(d, dia, (132, 6, 12, 255))
    poly(d, [(cx + (x - cx) * 0.93, cy + (y - cy) * 0.93) for x, y in dia], (58, 3, 4, 255))
    a = np.asarray(im).astype(np.float32)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    inside = (np.abs(xx - cx) / (rx * 0.93) + np.abs(yy - cy) / (ry * 0.93)) < 1
    mott = fbm(w, h, 26, 39, 3)
    spk = noise(w, h, 9, 391)
    tex = np.zeros((h, w, 3), np.float32)
    tex[..., 0] = 22 + 50 * mott + 45 * (spk > 0.66)
    tex[..., 1] = 2 + 30 * (spk > 0.7) * mott
    tex[..., 2] = 3
    glow = np.exp(-(((xx - cx) / (w * 0.16)) ** 2 + ((yy - cy) / (h * 0.30)) ** 2))
    tex[..., 0] += 120 * glow
    tex[..., 1] += 14 * glow
    tex[..., 2] += 16 * glow
    rib = (np.sin((yy - cy) / (h * 0.045) * math.pi) > 0.55) & (np.abs(xx - cx) < w * 0.085 * (1.15 - np.abs(yy - cy) / (h * 0.3))) & (np.abs(yy - cy) < h * 0.27)
    tex[rib] *= 0.55
    a[inside, :3] = tex[inside]
    im = arr_img(a).convert('RGBA')
    d = ImageDraw.Draw(im)
    # 四すみの房(小さなスペード形)
    for (px, py), ang in zip(dia, (0, 90, 180, 270)):
        s = w * 0.03
        sp = [(0, -2.3 * s), (0.75 * s, -1.2 * s), (0.45 * s, -0.3 * s), (0, 0.5 * s), (-0.45 * s, -0.3 * s), (-0.75 * s, -1.2 * s)]
        poly(d, [(px + x, py + y) for x, y in rot(sp, ang)], (70, 6, 6, 255))
    return fit(down(im, ss).filter(ImageFilter.GaussianBlur(0.6)), bb, W, H)


# ───────────── ポッキー・プリッツの棒 ─────────────
CHOC = [(1.0, 0.0, (74, 38, 34)), (0.74, -0.10, (112, 62, 54)), (0.36, -0.22, (148, 92, 78)), (0.10, -0.30, (196, 150, 132))]
BISC = [(1.0, 0.0, (176, 112, 50)), (0.74, -0.10, (232, 174, 96)), (0.36, -0.22, (253, 217, 120)), (0.10, -0.30, (255, 240, 190))]
PRETZ = [(1.0, 0.0, (160, 78, 34)), (0.76, -0.10, (204, 116, 23)), (0.40, -0.22, (234, 151, 29)), (0.12, -0.30, (250, 190, 80))]
ALMOND = [(1.0, 0.0, (126, 75, 60)), (0.74, -0.10, (189, 124, 87)), (0.30, -0.22, (214, 150, 104))]


def seg(d, p0, p1, r, layers):
    """丸い棒の 1 区間(色を太さ違いで重ねて円柱の陰にする)。"""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    L = math.hypot(dx, dy) or 1
    nx, ny = -dy / L, dx / L
    if nx > 0:
        nx, ny = -nx, -ny           # 光は左から
    for wf, off, c in layers:
        ox, oy = nx * off * -r * -1, ny * off * -r * -1
        a = (p0[0] - ox, p0[1] - oy)
        b = (p1[0] - ox, p1[1] - oy)
        rr = r * wf
        d.line([a, b], fill=c + (255,), width=max(1, int(round(rr * 2))))
        for q in (a, b):
            d.ellipse([q[0] - rr, q[1] - rr, q[0] + rr, q[1] + rr], fill=c + (255,))


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def pocky(im, top, bot, r, kind='choc', rng=None, bis_at='top', bis_len=0.22):
    """棒 1 本。kind = choc(持ち手のビスケット + チョコ)/ almond(上がアーモンドのつぶつぶ)/ pretz。"""
    d = ImageDraw.Draw(im)
    if kind == 'pretz':
        seg(d, top, bot, r, PRETZ)
        if rng is not None:
            for k in range(int(math.hypot(bot[0] - top[0], bot[1] - top[1]) / r * 0.9)):
                p = lerp(top, bot, rng.random())
                o = rng.uniform(-0.7, 0.7) * r
                s = rng.uniform(0.06, 0.14) * r
                c = (150, 70, 30, 255) if rng.random() < 0.6 else (252, 214, 130, 255)
                d.ellipse([p[0] + o - s, p[1] - s, p[0] + o + s, p[1] + s], fill=c)
        return
    if kind == 'choc':
        if bis_at == 'top':
            seg(d, top, lerp(top, bot, bis_len + 0.03), r * 0.86, BISC)
            seg(d, lerp(top, bot, bis_len), bot, r, CHOC)
        else:
            seg(d, lerp(top, bot, 1 - bis_len - 0.03), bot, r * 0.86, BISC)
            seg(d, top, lerp(top, bot, 1 - bis_len), r, CHOC)
        return
    if kind == 'deco':
        # 上が細いビスケット(茶色い木の葉形の模様が左右交互)、下が太いチョコ
        tan = [(1.0, 0.0, (164, 108, 62)), (0.76, -0.10, (206, 152, 94)), (0.32, -0.22, (226, 178, 118))]
        seg(d, top, lerp(top, bot, bis_len + 0.03), r * 0.74, tan)
        if rng is not None and rng.random() < 0.8:
            dx, dy = bot[0] - top[0], bot[1] - top[1]
            ang = math.degrees(math.atan2(dy, dx)) - 90
            n = int(bis_len * math.hypot(dx, dy) / (r * 1.9))
            for k in range(n):
                p = lerp(top, bot, 0.012 + (bis_len - 0.03) * (k + 0.5) / n)
                sgn = 1 if k % 2 else -1
                lay = [(sgn * r * 0.05, -r * 0.8), (sgn * r * 0.5, -r * 0.1), (sgn * r * 0.3, r * 0.7), (sgn * r * 0.02, r * 0.2)]
                poly(d, [(p[0] + x, p[1] + y) for x, y in rot(spline(lay, 5, closed=True), ang)], (150, 86, 70, 255))
        seg(d, lerp(top, bot, bis_len), bot, r, [(1.0, 0.0, (84, 44, 38)), (0.74, -0.10, (118, 66, 58)), (0.3, -0.22, (150, 96, 84)), (0.08, -0.3, (190, 140, 124))])


def outline_white(im, px):
    """シールふうの白いふち。"""
    a = im.getchannel('A')
    big = a.filter(ImageFilter.MaxFilter(px * 2 + 1)).filter(ImageFilter.GaussianBlur(px * 0.18)).point(lambda v: min(255, int(v * 1.6)))
    o = mask_to_rgba(big, (255, 255, 255))
    o.alpha_composite(im)
    return o


def pretz_bundle(i):
    """#23(白ふち・小)#64(大): プリッツ 5 本の束(上で広がり下で交わる。1 本はねじり模様)。"""
    W, H, bb = G(i)
    S = (700, 2660)
    im = rgba(S[0] + 200, S[1] + 200)
    rng = np.random.default_rng(64)
    r = 54
    sticks = [((0.50, 0.10), (0.42, 0.98)), ((0.10, 0.06), (0.78, 0.93)), ((0.33, 0.02), (0.66, 0.99)), ((0.92, 0.10), (0.62, 0.88)), ((0.80, 0.00), (0.50, 0.97))]
    for k, (a, b) in enumerate(sticks):
        top = (100 + a[0] * S[0], 100 + a[1] * S[1])
        bot = (100 + b[0] * S[0], 100 + b[1] * S[1])
        pocky(im, top, bot, r, 'pretz', rng)
        if k == 0:
            d = ImageDraw.Draw(im)
            for j in range(22):
                p = lerp(top, bot, 0.06 + j * 0.028)
                d.ellipse([p[0] - r * 0.3 + (j % 2) * r * 0.25, p[1] - r * 0.55, p[0] + r * 0.2 + (j % 2) * r * 0.25, p[1] + r * 0.55], fill=(196, 88, 46, 255))
    if i == 23:
        im = outline_white(im, 24)
    return fit(im, bb, W, H)


def pocky_bundle(i):
    """#25(白ふち・小)#65(大): チョコのポッキー 7 本の束(持ち手のビスケットが右上、左下へ扇形にすぼむ)。"""
    W, H, bb = G(i)
    S = (1160, 2660)
    im = rgba(S[0] + 200, S[1] + 200)
    r = 42
    sticks = [((0.60, 0.04), (0.52, 0.93)), ((0.70, 0.00), (0.36, 0.95)), ((0.54, 0.12), (0.26, 0.97)), ((0.80, 0.03), (0.44, 0.90)),
              ((0.86, 0.10), (0.16, 0.99)), ((0.66, 0.16), (0.60, 0.91)), ((0.96, 0.14), (0.05, 0.96))]
    for a, b in sticks:
        pocky(im, (100 + a[0] * S[0], 100 + a[1] * S[1]), (100 + b[0] * S[0], 100 + b[1] * S[1]), r, 'choc', bis_at='top', bis_len=0.2)
    if i == 25:
        im = outline_white(im, 20)
    return fit(im, bb, W, H)


def almond_fan(i):
    """#68: 上のビスケットに木の葉模様のあるポッキー 14 本を X 字の扇に重ねた束。"""
    W, H, bb = G(i)
    S = (1434, 3124)
    im = rgba(S[0] + 200, S[1] + 200)
    rng = np.random.default_rng(68)
    order = list(range(14))
    rng.shuffle(order)
    for k in order:
        t = k / 13
        top = (100 + S[0] * (0.04 + 0.92 * t ** 0.9 + rng.uniform(-0.02, 0.02)), 100 + S[1] * (0.02 + 0.16 * abs(t - 0.55) + rng.uniform(0, 0.06)))
        bt = 1 - t + rng.uniform(-0.12, 0.12)
        bot = (100 + S[0] * (0.5 + (bt - 0.5) * 0.9), 100 + S[1] * (0.99 - 0.07 * abs(bt - 0.5) * 2 - rng.uniform(0, 0.03)))
        pocky(im, top, bot, 44, 'deco', rng, bis_len=0.21 + rng.uniform(0, 0.07))
    return fit(im, bb, W, H)


def almond_pair(i):
    """#69: 上のビスケットに木の葉模様のあるポッキー 2 本(ほぼ縦、少しだけ交わる)。"""
    W, H, bb = G(i)
    S = (582, 3068)
    im = rgba(S[0] + 200, S[1] + 200)
    rng = np.random.default_rng(71)
    for a, b in [((0.38, 0.00), (0.88, 1.0)), ((0.10, 0.04), (0.58, 0.97))]:
        pocky(im, (100 + a[0] * S[0], 100 + a[1] * S[1]), (100 + b[0] * S[0], 100 + b[1] * S[1]), 46, 'deco', rng, bis_len=0.22)
    return fit(im, bb, W, H)


def glow_outline(im, px, col):
    a = im.getchannel('A')
    big = a.filter(ImageFilter.MaxFilter(px * 2 + 1)).filter(ImageFilter.GaussianBlur(px * 0.35))
    o = mask_to_rgba(big.point(lambda v: int(v * 0.9)), col)
    o.alpha_composite(im)
    return o


def pocky_icon(i):
    """#54: 小さいポッキー 1 本(上がチョコ、下 1/4 がビスケット、境目に赤いぎざぎざ、赤橙のふち)。"""
    W, H, bb = G(i)
    ss = 10
    im = rgba(W * ss, H * ss)
    d = ImageDraw.Draw(im)
    cx, r = W * ss / 2, 7.2 * ss
    y0, y1 = 10 * ss, 174 * ss
    ym = y0 + (y1 - y0) * 0.74
    d.rounded_rectangle([cx - r, ym - 4 * ss, cx + r, y1], r * 0.8, fill=(232, 190, 86, 255))
    d.rounded_rectangle([cx - r, y0, cx + r, ym], r, fill=(131, 85, 69, 255))
    d.rectangle([cx - r, ym - r, cx + r, ym], fill=(131, 85, 69, 255))
    zz = [(cx - r, ym - 1.5 * ss)]
    for k in range(5):
        xa = cx - r + 2 * r * (k + 0.5) / 5
        zz += [(xa, ym + 5 * ss), (cx - r + 2 * r * (k + 1) / 5, ym - 1.5 * ss)]
    poly(d, zz + [(cx + r, ym - 3 * ss), (cx - r, ym - 3 * ss)], (226, 60, 36, 255))
    rng = np.random.default_rng(54)
    for k in range(40):
        x, y = cx + rng.uniform(-r, r) * 0.8, rng.uniform(y0 + r, ym - 2 * ss)
        s = rng.uniform(0.5, 1.2) * ss
        d.ellipse([x - s, y - s, x + s, y + s], fill=(120, 76, 62, 255) if rng.random() < 0.5 else (146, 94, 76, 255))
    im = glow_outline(im, int(1.8 * ss), (236, 92, 70))
    return fit(im, bb, W, H)


def pretz_icon(i):
    """#55: 小さい黄色の棒 1 本に赤い粒(サラダ/トマトのプリッツふう、橙のふち)。"""
    W, H, bb = G(i)
    ss = 10
    im = rgba(W * ss, H * ss)
    d = ImageDraw.Draw(im)
    cx, r = W * ss / 2, 7.4 * ss
    y0, y1 = 10 * ss, 176 * ss
    body = [(cx - r, y0 + 2 * ss), (cx + r * 0.9, y0), (cx + r, y1 - 6 * ss), (cx - r * 0.2, y1), (cx - r, y1 - 3 * ss)]
    poly(d, body, (231, 208, 94, 255))
    m = im.getchannel('A')
    dots = rgba(W * ss, H * ss)
    dd = ImageDraw.Draw(dots)
    for k in range(10):
        y = y0 + (y1 - y0) * (0.07 + k * 0.094)
        x = cx + (r * 0.45 if k % 2 == 0 else -r * 0.4)
        dd.ellipse([x - 3.0 * ss, y - 4.6 * ss, x + 3.0 * ss, y + 4.6 * ss], fill=(234, 86, 52, 255))
    dots.putalpha(ImageChops.multiply(dots.getchannel('A'), m))
    im.alpha_composite(dots)
    im = glow_outline(im, int(1.8 * ss), (238, 150, 96))
    return fit(im, bb, W, H)


# ───────────── 一覧(番号 → 関数・作り方・状態) ─────────────
ITEMS = {
    68: (almond_fan, 'PIL: 色を太さ違いで重ねた円柱の棒 14 本を X 字の扇に。上 1/3 は細いビスケット + 茶色い木の葉形の模様、下は太いチョコ', 'できた'),
    69: (almond_pair, 'PIL: 同じ棒の描き方で 2 本を少し交わらせて縦に', 'できた'),
    19: (arc_band, 'PIL: Catmull-Rom の左右のふちで弓なりの帯の多角形 + 外側に円の玉・波形', 'できた'),
    21: (sakura_title3, 'PIL: スプラインの花びら(先割れ)を 72° ずつ回して 5 弁、上の 1 弁だけ紫で細く', 'できた'),
    17: (skirt_cut, 'PIL: x = 1000 − 234·t^3.2 のすそ広がりの曲線 + 平らな上辺の白い多角形', 'できた'),
    18: (skirt_cut, 'PIL: #17 と同じ形を左右反転', 'できた'),
    3: (frosted, 'numpy+PIL: fBm ノイズのしきい値で選んだ場所に半径 6.5〜9.5px の円を 3 万個(灰色、被覆 約 7 割、地は透明)', 'できた'),
    61: (corner_checker, 'PIL: 60px の市松を左上(8 段)・右下(9 段)の階段状の三角にだけ', 'できた'),
    63: (soulgem_3d, 'PIL+numpy: 多角形・だ円で組んだ枠のマスクをぼかして高さにし、勾配で金の陰影。受け皿の浮き彫り・緑の卵・赤い石', '仮'),
    5: (hexagon, 'PIL: 六角形(黒)', 'できた'),
    4: (hexagon, 'PIL: 六角形(白)', 'できた'),
    20: (sakura_title, 'PIL: スプラインの花びらを 72° ずつ回して桃色 5 弁(太い弁)', 'できた'),
    39: (red_ornament, 'PIL+numpy: えんじのひし形 + fBm のまだら模様 + 中央の赤い光と横すじ(灯籠形)+ 四すみの房', '仮'),
    15: (rhombus, 'PIL: bbox の辺の中点を結ぶ白いひし形', 'できた'),
    34: (heart_pattern, 'PIL: 渦巻きハート(ハート曲線 − 渦の帯 + しっぽ)を白で描き、斜めの格子で黄色の地に敷く', 'できた'),
    58: (yagasuri_dark, 'numpy: 矢絣(列 24px・周期 130px の山形の 2 色、となりの列は半周期ずらす)黒と灰', 'できた'),
    27: (sakura_title3, 'PIL: #21 と同じ(桃色 4 弁 + 紫 1 弁の桜)', 'できた'),
    28: (sakura_mask, 'PIL: 円 5 つ + 中心の円の白い 5 つ山の雲形', 'できた'),
    57: (yagasuri_white, 'numpy: 矢絣(列 30px・周期 150px)白の 2 階調 + 軸の線', 'できた'),
    23: (pretz_bundle, 'PIL: 橙の円柱の棒 5 本の束 + 白いふち(アルファの膨張)', 'できた'),
    25: (pocky_bundle, 'PIL: チョコ + ビスケットの持ち手の棒 7 本の扇 + 白いふち', 'できた'),
    50: (burst, 'PIL: 乱数(種固定)で長さの不ぞろいな 17 とげの星形・白', 'できた'),
    51: (burst, 'PIL: 同じ作りの 16 とげ・黄', 'できた'),
    52: (burst, 'PIL: 同じ作りの 18 とげ・橙', 'できた'),
    38: (apple_floor, 'numpy: りんごのタイル 2 種(#36 #37 と同じ関数)の市松を、地平線 y=−357・ヨー 14° の逆透視写像で床に敷く(3 倍で描いて縮小)', 'できた'),
    48: (soulgem_flat, 'PIL: 多角形・だ円で組んだソウルジェムの枠のべた塗り(金 + 緑 + 赤)こげ茶の地', 'できた'),
    53: (heart_black, 'PIL: ハート曲線から渦の帯を抜き、左下に玉つきのしっぽ(黒)', 'できた'),
    54: (pocky_icon, 'PIL: 角丸の棒(チョコ + ビスケット + 赤いぎざぎざ)+ 赤橙のふち', 'できた'),
    55: (pretz_icon, 'PIL: 黄色の棒 + 赤い粒 10 個 + 橙のふち', 'できた'),
    30: (yagasuri_navy, 'numpy: 矢絣(列 32px・周期 104px)濃い青灰の 2 階調', 'できた'),
    29: (arrows10, 'PIL: 軸 + 矢じり(灰色の縁・えんじの芯)の矢を 36° ずつ回して 10 本', 'できた'),
    31: (sakura_big, 'PIL: 太い花びらの桜(上の弁は紫)+ 緑の輪と 15 本のしべの線', 'できた'),
    24: (quarter_circles, 'PIL: 四すみに半径 1500 の円(青緑・黄)', 'できた'),
    36: (apple_tiles, 'PIL+numpy: 明るいひし形の地 + りんごの輪郭(だ円 2 つ)に fBm の点描の陰と軸', 'できた'),
    65: (pocky_bundle, 'PIL: チョコ + ビスケットの持ち手の棒 7 本の扇(ふちなし)', 'できた'),
    41: (petal_single, 'PIL: スプラインの花びら 1 枚(薄い桃色、先割れが上)', 'できた'),
    37: (apple_tiles, 'PIL+numpy: 灰色のひし形の地 + 半分に切ったりんご(白い切り口のだ円・皮・芯と種)', 'できた'),
    62: (railing, 'PIL: 118px 目の細い線の格子を、乱数(種固定)でところどころ欠いた手すり模様', 'できた'),
    0: (yagasuri_black, 'numpy: 矢絣(列 64px・周期 208px)黒と こげ茶', 'できた'),
    35: (gem_pattern, 'PIL: ひし形の紋(#33 と同じ)を緑で、青緑の地に斜めの格子で', 'できた'),
    33: (gem_pattern, 'PIL: 辺が内へ反るひし形 − 目の形の抜け の紋を白で、青緑の地に斜めの格子で', 'できた'),
    32: (apple_pattern, 'PIL+numpy: 点描のりんご(#36 と同じ関数)を淡いサーモンで、生成りの地に斜めの格子で', 'できた'),
    26: (stripes, 'PIL: 横じま 5 本(サーモン / 生成り)', 'できた'),
    64: (pretz_bundle, 'PIL: 橙の円柱の棒 5 本の束(ふちなし)', 'できた'),
    46: (window_frame, 'PIL: 濃い線の格子(外枠・内枠・ひし形・仕切り)+ 四すみの赤い四角', 'できた'),
    49: (rays, 'PIL: 画面外の 1 点 (1593, −90) からの三角形 8 枚で放射の帯(桃色・淡黄)', 'できた'),
    47: (soulgem_flat, 'PIL: #48 と同じ形・青い地', 'できた'),
    16: (rhombus, 'PIL: bbox の辺の中点を結ぶ白いひし形', 'できた'),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    ap.add_argument('--register', action='store_true')
    a = ap.parse_args()
    ids = [int(x) for x in a.only.split(',') if x] or list(ITEMS)
    os.makedirs(OUT, exist_ok=True)
    if a.register:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import rebuild_lib as RL
        for i in ids:
            fn, how, status = ITEMS[i]
            key = ASSIGN[i]['key']
            p = os.path.join(OUT, f'{i}.png')
            im = Image.open(p)
            g = GEOM[key]
            assert im.size == (g['w'], g['h']), (i, im.size)
            r = RL.upload(p, f'procA_{i:02d}_{os.path.basename(key)}')
            RL.put('PROC_A', key, r['id'], g['w'], g['h'], 'proc', f'rebuild_proc_a.py:{fn.__name__}({how})', status, NOTES.get(i, ''))
            print('registered', i, r['id'], status, flush=True)
        return
    for i in ids:
        fn = ITEMS[i][0]
        im = fn(i)
        W, H, bb = G(i)
        assert im.size == (W, H), (i, im.size, (W, H))
        if not GEOM[ASSIGN[i]['key']]['alpha']:
            im = im.convert('RGB')
        im.save(os.path.join(OUT, f'{i}.png'))
        print('made', i, fn.__name__, im.mode, im.size, flush=True)


_LAT = '格子の向きと間隔(約 99px・29°)は元の柄の自己相関を点検用スクリプト(PROC_A/measure.py)で数値にして使った。絵そのものは読んでいない'
_YAG = '列の幅と周期は元の柄の自己相関を点検用スクリプト(PROC_A/measure.py)で数値にして使った'
NOTES = {32: _LAT, 33: _LAT, 34: _LAT, 35: _LAT, 0: _YAG, 30: _YAG, 57: _YAG, 58: _YAG,
         63: '元は 3D レンダー。受け皿の形・浮き彫りの模様・金の照りは目で見た近似で、細部は元と違う',
         39: '元は 229×179 の小さくぼけた絵。中の灯籠形・金茶の模様は目で見た近似',
         53: 'ハートと渦としっぽの配置は近いが、渦の太さ・巻き方は元と少し違う',
         38: 'カメラの高さ・向きは目合わせ(タイルの見かけの大きさは近いが一致ではない)',
         62: '線の欠け方は乱数(元の欠け方の写しではない)',
         19: '形は目で読んだ座標のスプライン(玉・波形の数と位置は近似)',
         47: '緑・青はキー用の原色と見てそのままの色にした', 48: '緑はキー用の原色と見てそのままの色にした'}

if __name__ == '__main__':
    main()
