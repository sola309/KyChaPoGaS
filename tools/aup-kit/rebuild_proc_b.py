#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「さくら」再現 2 巡目 担当 PROC_B: 模様・図形・紙・木目・布・枠・菓子などを PIL + numpy で新しく描く。

元の素材は 1 つも開かない。大きさ・位置(bbox)・代表色は look/geom.json、模様の周期は点検用の測定(数値だけ)と目で見た値。
  rebuild_proc_b.py                 全部を描く → R/PROC_B/out/<番号>.png
  rebuild_proc_b.py --only 84,73    その番号だけ
  rebuild_proc_b.py --put [--only …] 描いてある絵を project 37 に登録し、置き換え表に書く
乱数は種を固定(決定論)。
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont
from scipy import ndimage as ndi

Image.MAX_IMAGE_PIXELS = None
HERE = os.path.dirname(os.path.abspath(__file__))
R = '/tmp/claude-1000/sakura-rebuild/'
OUT = R + 'PROC_B/out/'
FONTS = os.path.join(HERE, '..', '..', 'backend', 'data', 'fonts')
F_BLACK = os.path.join(FONTS, 'NotoSansJP-Black.otf')
F_REG = os.path.join(FONTS, 'NotoSansJP-Regular.otf')
F_HAND = os.path.join(FONTS, 'APJapanesefont.ttf')
ASSIGN = {x['i']: x for x in json.load(open(R + 'assign.json', encoding='utf-8'))['PROC_B']}
GEOM = json.load(open(R + 'look/geom.json', encoding='utf-8'))


def G(i):
    return GEOM[ASSIGN[i]['key']]


def hexc(s):
    s = s.lstrip('#')
    return tuple(int(s[k:k + 2], 16) for k in (0, 2, 4))


# ---------------------------------------------------------------- 共通の部品
def vnoise(h, w, scale, seed, sx=1.0, sy=1.0):
    """なめらかな乱れ(0..1)。scale = 粒の大きさ(px)。sx, sy で伸ばす。"""
    rng = np.random.default_rng(seed)
    gh = max(2, int(h / (scale * sy)) + 2)
    gw = max(2, int(w / (scale * sx)) + 2)
    a = rng.random((gh, gw)).astype(np.float32)
    return np.asarray(Image.fromarray(a, 'F').resize((w, h), Image.BICUBIC)).clip(0, 1)


def fbm(h, w, scale, seed, octaves=4, sx=1.0, sy=1.0):
    t = np.zeros((h, w), np.float32)
    amp = 1.0
    tot = 0.0
    for o in range(octaves):
        t += amp * vnoise(h, w, max(1.5, scale / 2 ** o), seed + o * 101, sx, sy)
        tot += amp
        amp *= 0.5
    return t / tot


def to_img(rgb, alpha=None):
    rgb = np.clip(rgb, 0, 255).astype(np.uint8)
    if alpha is None:
        return Image.fromarray(rgb, 'RGB')
    a = np.clip(alpha * 255, 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, a]), 'RGBA')


def fit(img, W, H, bbox, pad=0):
    """絵(RGBA か L)の不透明部分を切り出し、bbox にぴったり合う大きさにして W×H の透明な板に置く。"""
    a = img.getchannel('A') if img.mode == 'RGBA' else img
    bb = a.point(lambda v: 255 if v > 8 else 0).getbbox()
    c = img.crop(bb).resize((bbox[2] - bbox[0], bbox[3] - bbox[1]), Image.LANCZOS)
    out = Image.new(img.mode, (W, H), 0)
    out.paste(c, (bbox[0], bbox[1]))
    return out


def colorize(mask, color):
    """L の型 → 単色の RGBA。"""
    im = Image.new('RGBA', mask.size, tuple(color) + (0,))
    im.putalpha(mask)
    return im


def fringe(mask, core=(252, 40, 4), edge=(253, 150, 10), blur=2.2, gain=1.7):
    """線画の型(L)→ 芯が赤・縁が橙ににじむ RGBA(S03 の赤い図案の見た目)。"""
    m = np.asarray(mask).astype(np.float32) / 255
    g = ndi.gaussian_filter(m, blur)
    a = np.clip(np.maximum(m, g * gain), 0, 1)
    t = np.clip(g * 1.5 - 0.35, 0, 1)[..., None]
    rgb = np.array(edge, np.float32) * (1 - t) + np.array(core, np.float32) * t
    return to_img(rgb, a)


def poly_ellipse(cx, cy, rx, ry, rot=0.0, n=48):
    c, s = math.cos(rot), math.sin(rot)
    return [(cx + rx * math.cos(t) * c - ry * math.sin(t) * s, cy + rx * math.cos(t) * s + ry * math.sin(t) * c)
            for t in (2 * math.pi * k / n for k in range(n))]


def catmull(pts, n=24):
    """点列をなめらかにつなぐ(Catmull-Rom)。pts の各要素は任意の長さの組(座標 + 太さなど)。"""
    P = [np.array(p, float) for p in pts]
    P = [P[0]] + P + [P[-1]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(n):
            t = k / n
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(P[-2])
    return out


def thick_curve(d, pts, fill, S=1):
    """太さの変わる曲線(点 = x, y, 太さ)を円の連なりで描く。"""
    for x, y, w in catmull(pts, 40):
        r = w * S / 2
        d.ellipse((x * S - r, y * S - r, x * S + r, y * S + r), fill=fill)


# ---------------------------------------------------------------- 紙・布・木
def washi(W, H, seed):
    """和紙: ほぼ白 + ごく薄い桃色のむら + 細かいしわの凹凸(光の勾配)+ 繊維。"""
    base = np.ones((H, W, 3), np.float32) * np.array([243, 243, 241], np.float32)
    pink = fbm(H, W, 420, seed, 3)
    pink = np.clip((pink - 0.48) * 3.2, 0, 1)[..., None]
    base = base * (1 - pink * 0.55) + np.array([243, 232, 240], np.float32) * (pink * 0.55)
    # しわ: 細かい高さの地図を斜め上からの光で
    hgt = fbm(H, W, 34, seed + 7, 4) + 0.5 * np.abs(fbm(H, W, 70, seed + 9, 3) - 0.5)
    gy, gx = np.gradient(hgt)
    sh = (gx * 0.8 + gy * 0.6) * 95
    # 繊維: 細く長い線をたくさん
    rng = np.random.default_rng(seed + 3)
    fib = Image.new('L', (W, H), 128)
    d = ImageDraw.Draw(fib)
    for _ in range(int(W * H / 2600)):
        x, y = rng.random() * W, rng.random() * H
        a = rng.random() * math.pi
        L = 20 + rng.random() * 70
        bend = (rng.random() - 0.5) * 0.8
        pts = [(x + math.cos(a + bend * t) * L * t, y + math.sin(a + bend * t) * L * t) for t in np.linspace(0, 1, 6)]
        d.line(pts, fill=int(128 + (rng.random() - 0.45) * 26), width=1)
    fibn = (np.asarray(fib.filter(ImageFilter.GaussianBlur(0.6))).astype(np.float32) - 128) * 0.55
    grain = (np.random.default_rng(seed + 5).random((H, W)).astype(np.float32) - 0.5) * 3
    out = base + (sh + fibn + grain)[..., None]
    return to_img(np.clip(out, 0, 252))


def d84():
    return washi(2048, 1365, 84)


def d303():
    return washi(1920, 1080, 303)


def aniso(h, w, across, along, ang, seed):
    """一方向に長く伸びた乱れ(布の折り目・木目用)を ang 度だけ回して h×w に切り出す。"""
    D = int(math.hypot(h, w)) + 8
    a = fbm(D, D, across, seed, 3, sx=along / across, sy=1.0)
    im = Image.fromarray(a, 'F').rotate(ang, resample=Image.BICUBIC)
    y0, x0 = (D - h) // 2, (D - w) // 2
    return np.asarray(im)[y0:y0 + h, x0:x0 + w]


def d306():
    """白い布のしわ: 斜めに長く伸びた乱れ(向きの違う 3 枚)を高さの地図にして、左上からの光で陰影。"""
    W, H = 1334, 2000
    s = 2
    w, h = W // s, H // s
    hgt = (1.0 * aniso(h, w, 95, 620, 55, 61) + 0.8 * aniso(h, w, 60, 420, 35, 62) + 0.7 * aniso(h, w, 130, 700, 72, 63)
           + 0.4 * aniso(h, w, 45, 260, -25, 64))
    hgt = ndi.gaussian_filter(hgt, 5)
    hgt = hgt + 0.5 * np.abs(hgt - np.median(hgt))        # 山を少しとがらせる
    gy, gx = np.gradient(hgt)
    sh = ndi.gaussian_filter((-gx * 0.8 - gy * 0.6) * 4200, 1.5)
    v = 224 + np.clip(sh, -46, 20) + (fbm(h, w, 400, 77, 2) - 0.5) * 12
    v = np.clip(v, 168, 244)
    im = Image.fromarray(v.astype(np.uint8), 'L').resize((W, H), Image.BICUBIC)
    a = np.asarray(im).astype(np.float32) + (np.random.default_rng(6).random((H, W)).astype(np.float32) - 0.5) * 2.5
    return to_img(np.dstack([a, a, a]))


def d307():
    """木目の板: 横板 8 枚、横に長い細い木目と濃いすじ、板の境の暗い溝、中央が明るく上下と四隅が暗い。"""
    W, H = 1920, 1280
    rng = np.random.default_rng(307)
    edges = [0, 150, 318, 470, 640, 800, 962, 1120, 1280]
    out = np.zeros((H, W, 3), np.float32)
    dark = np.array([78, 36, 20], np.float32)
    mid = np.array([170, 100, 60], np.float32)
    lite = np.array([212, 140, 86], np.float32)
    for k in range(len(edges) - 1):
        y0, y1 = edges[k], edges[k + 1]
        h = y1 - y0
        fine = fbm(h, W, 4, 400 + k, 2, sx=90.0, sy=1.0)          # 細い木目(幅 4 px・長さ数百 px)
        wav = fbm(h, W, 16, 450 + k, 3, sx=30.0, sy=1.0)          # 中くらいのうねり
        g2 = fbm(h, W, 60, 500 + k, 2, sx=8.0, sy=0.8)            # 大きな色むら
        streak = np.clip((fbm(h, W, 4, 600 + k, 2, sx=110.0, sy=1.0) - 0.66) * 7, 0, 1)   # 濃いすじ
        t = np.clip(0.12 + 0.55 * fine + 0.15 * wav + 0.3 * g2 + (rng.random() - 0.5) * 0.3, 0, 1)[..., None]
        col = mid * (1 - t) + lite * t
        col = col * (1 - 0.55 * streak[..., None]) + dark * 0.55 * streak[..., None]
        yy = np.arange(h, dtype=np.float32)
        gap = np.clip(1.3 - np.minimum(yy, h - 1 - yy) / 3.0, 0, 1)[:, None, None]
        col = col * (1 - 0.9 * gap) + np.array([36, 16, 9], np.float32) * 0.8 * gap
        out[y0:y1] = col
    blot = np.clip((fbm(H, W, 90, 333, 3, sx=6.0, sy=0.35) - 0.63) * 6, 0, 1)[..., None]    # 傷んだ暗い所
    out = out * (1 - 0.7 * blot) + dark * 0.7 * blot
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    v = 1 - 0.5 * np.clip(((xx / W - 0.5) ** 2 * 1.2 + (yy / H - 0.45) ** 2 * 3.2), 0, 1)
    out = out * v[..., None] + (np.random.default_rng(1).random((H, W, 1)).astype(np.float32) - 0.5) * 8
    return to_img(out)


def grad_flecks(W, H, seed):
    """上が桃色・中がクリーム・下が黄色の縦の移り変わり + 細かい明るい粒(花びらのような)。"""
    yy = np.linspace(0, 1, H, dtype=np.float32)[:, None]
    c0, c1, c2 = (np.array(hexc(c), np.float32) for c in ('#ffc0c6', '#f9f3db', '#fde89c'))
    t1 = np.clip((yy - 0.22) / 0.26, 0, 1)
    t2 = np.clip((yy - 0.55) / 0.42, 0, 1)
    t1 = t1 * t1 * (3 - 2 * t1)
    t2 = t2 * t2 * (3 - 2 * t2)
    col = (c0 * (1 - t1)[..., None] + c1 * t1[..., None]) * (1 - t2)[..., None] + c2 * t2[..., None]
    col = np.repeat(col, W, axis=1)
    rng = np.random.default_rng(seed)
    fl = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(fl)
    for _ in range(int(W * H / 420)):
        x, y = rng.random() * W, rng.random() * H
        r = 3 + rng.random() * 7
        d.polygon(poly_ellipse(x, y, r, r * (0.5 + rng.random() * 0.4), rng.random() * 3.14, 10), fill=int(40 + rng.random() * 80))
    f = np.asarray(fl.filter(ImageFilter.GaussianBlur(0.8))).astype(np.float32) / 255
    amt = (0.75 * (1 - np.abs(yy - 0.5) * 0.6)) * f
    col = col + (255 - col) * amt[..., None]
    col += ((fbm(H, W, 40, seed + 1, 2) - 0.5) * 8)[..., None]
    return to_img(col)


def d293():
    return grad_flecks(2200, 918, 293)


def d320():
    return grad_flecks(2200, 918, 320)


# ---------------------------------------------------------------- 模様
def asanoha_lines(d, W, H, px, py, ox, oy, width, fill):
    """麻の葉: 頂点 (ox + px*a, oy + py*b)(a+b が偶数)の三角格子 + 各三角の重心から頂点へ。"""
    for a in range(-2, int(W / px) + 3):
        for b in range(-2, int(H / py) + 3):
            if (a + b) % 2:
                continue
            x, y = ox + px * a, oy + py * b
            up, ur, dr = (x, y - 2 * py), (x + px, y - py), (x + px, y + py)
            for q in (up, ur, dr):
                d.line((x, y, q[0], q[1]), fill=fill, width=width)
            for tri in ((up, ur), (ur, dr)):
                cx = (x + tri[0][0] + tri[1][0]) / 3
                cy = (y + tri[0][1] + tri[1][1]) / 3
                for q in ((x, y), tri[0], tri[1]):
                    d.line((cx, cy, q[0], q[1]), fill=fill, width=width)


def d83():
    """麻の葉の白い線(透明の地)。周期 288×162。"""
    W, H, S = 1920, 1080, 3
    m = Image.new('L', (W * S, H * S), 0)
    asanoha_lines(ImageDraw.Draw(m), W * S, H * S, 144 * S, 81 * S, 96 * S, 50 * S, int(2.6 * S), 255)
    return colorize(m.resize((W, H), Image.LANCZOS), (255, 255, 255))


def yagasuri_mask(W, H, colw=24.85, band=53.5, slope=1.05):
    """矢絣: 縦の列ごとに山形の帯が交互。隣の列は帯 1 つぶんずれる。→ 0..1 の型。"""
    S = 3
    yy, xx = np.mgrid[0:H * S, 0:W * S].astype(np.float32) / S
    c = np.floor(xx / colw)
    u = xx / colw - c
    v = yy + slope * np.abs(u - 0.5) * colw + 9
    m = ((np.floor(v / band) + c) % 2).astype(np.float32)
    shaft = (np.abs(u - 0.5) * colw < 0.75).astype(np.float32)  # 羽の軸の細い線
    m = np.where(shaft > 0, 1 - m, m)
    return np.asarray(Image.fromarray((m * 255).astype(np.uint8), 'L').resize((W, H), Image.LANCZOS)).astype(np.float32) / 255


def d376():
    """白い矢絣: ごく薄い 2 階調の灰白。"""
    m = yagasuri_mask(1920, 1080)[..., None]
    a, b = np.array([232, 232, 229], np.float32), np.array([240, 240, 238], np.float32)
    col = a * m + b * (1 - m) + ((fbm(1080, 1920, 300, 376, 2) - 0.5) * 4)[..., None]
    return to_img(col)


def d313():
    """えんじ色の矢絣(透明の地)。"""
    m = yagasuri_mask(1920, 1080)
    # 元は不透明が 58% 前後 → 帯を少し太らせる
    m = np.clip(ndi.gaussian_filter(m, 1.0) * 1.9 - 0.32, 0, 1)
    rgb = np.ones((1080, 1920, 3), np.float32) * np.array(hexc('#932436'), np.float32)
    return to_img(rgb, m)


def lantern_diamond(w, h, finials=False, seed=1):
    """暗い赤のひし形の飾り板 + 中央に赤い提灯形(ソウルジェム風の卵)。RGBA。"""
    S = 4
    Wc, Hc = w * S, h * S
    pad = (0.085 if finials else 0.0)
    cx, cy = Wc / 2, Hc / 2
    rx, ry = Wc * (0.5 - pad), Hc * (0.5 - pad)
    m = Image.new('L', (Wc, Hc), 0)
    d = ImageDraw.Draw(m)
    dia = [(cx - rx, cy), (cx, cy - ry), (cx + rx, cy), (cx, cy + ry)]
    d.polygon(dia, fill=255)
    yy, xx = np.mgrid[0:Hc, 0:Wc].astype(np.float32)
    dd = np.abs(xx - cx) / rx + np.abs(yy - cy) / ry          # 0 中心 … 1 ふち
    base = np.zeros((Hc, Wc, 3), np.float32)
    t = np.clip(dd, 0, 1)[..., None]
    base[:] = np.array([84, 5, 9], np.float32) * (1 - t) + np.array([44, 5, 3], np.float32) * t
    sp = fbm(Hc, Wc, 5 * S, seed, 2)
    base *= (0.62 + 0.75 * sp)[..., None]                      # ざらざらした金茶の粒
    gold = np.clip((vnoise(Hc, Wc, 2.2 * S, seed + 4) - 0.55) * 4, 0, 1)[..., None] * (dd[..., None] > 0.3)
    base = base * (1 - 0.6 * gold) + np.array([96, 50, 14], np.float32) * 0.6 * gold
    ring = np.clip(1 - np.abs(dd - 0.9) / 0.07, 0, 1)[..., None]   # 明るい赤のふち
    base = base * (1 - ring * 0.8) + np.array([150, 8, 18], np.float32) * ring * 0.8
    ring2 = np.clip(1 - np.abs(dd - 0.62) / 0.03, 0, 1)[..., None]
    base = base * (1 - ring2 * 0.6) + np.array([40, 2, 4], np.float32) * ring2 * 0.6
    im = to_img(base, np.asarray(m).astype(np.float32) / 255)
    d = ImageDraw.Draw(im)
    # 提灯: 卵形 + 横のひだ + 上下の金具
    ex, ey = Wc * 0.115, Hc * 0.27
    for k in range(10, 0, -1):
        f = k / 10
        col = (int(215 - 110 * f), int(12 - 8 * f), int(22 - 12 * f), 255)
        d.ellipse((cx - ex * f, cy - ey * (0.25 + 0.75 * f), cx + ex * f, cy + ey * (0.25 + 0.75 * f)), fill=col)
    for k in range(-3, 4):
        y = cy + k * ey * 0.22
        hw = ex * math.sqrt(max(0.05, 1 - (k * 0.22) ** 2)) * 0.95
        d.line((cx - hw, y, cx + hw, y), fill=(70, 2, 6, 255), width=max(1, int(0.9 * S)))
    capw, caph = ex * 0.6, ey * 0.2
    for sgn in (-1, 1):
        y = cy + sgn * ey
        d.rectangle((cx - capw, y - caph / 2, cx + capw, y + caph / 2), fill=(46, 3, 4, 255))
    if finials:
        for px_, py_, horiz in ((cx - rx, cy, True), (cx + rx, cy, True), (cx, cy - ry, False), (cx, cy + ry, False)):
            sg = -1 if (px_ < cx or py_ < cy) else 1
            L, T = Wc * pad * 0.92, Wc * 0.022
            if horiz:
                d.polygon([(px_ - sg * T, py_ - T * 0.6), (px_ + sg * L * 0.5, py_ - T * 1.25), (px_ + sg * L, py_), (px_ + sg * L * 0.5, py_ + T * 1.25), (px_ - sg * T, py_ + T * 0.6)], fill=(70, 12, 18, 255))
            else:
                L = Hc * pad * 0.95
                d.polygon([(px_ - T * 0.6, py_ - sg * T), (px_ - T * 1.25, py_ + sg * L * 0.5), (px_, py_ + sg * L), (px_ + T * 1.25, py_ + sg * L * 0.5), (px_ + T * 0.6, py_ - sg * T)], fill=(70, 12, 18, 255))
    return im.resize((w, h), Image.LANCZOS)


def d106():
    g = G(106)
    return fit(lantern_diamond(229, 179, finials=True, seed=106), 229, 179, g['bbox'])


def paste_safe(bg, tile, x, y):
    """はみ出してもよい alpha_composite。"""
    W, H = bg.size
    w, h = tile.size
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0:
        return
    bg.alpha_composite(tile.crop((x0 - x, y0 - y, x1 - x, y1 - y)), (x0, y0))


def lantern_pattern(seed):
    W, H = 1920, 1080
    px, py = 220.0, 175.5
    bg = Image.new('RGBA', (W, H), (30, 1, 5, 255))
    tile = lantern_diamond(198, 155, seed=seed)
    for b in range(-2, int(H / (py / 2)) + 3):
        for a in range(-2, int(W / px) + 3):
            x = 75 + px * a + (px / 2 if b % 2 else 0)
            y = 45 + (py / 2) * b
            paste_safe(bg, tile, int(round(x - 99)), int(round(y - 77.5)))
    return bg.convert('RGB')


def d370():
    return lantern_pattern(370)


def d296():
    return lantern_pattern(370)


def d314():
    return lantern_pattern(370)


def d318():
    """小豆色の地に、同じ色みの細かい織り柄(円い紋と四角。周期 101×100、ごく弱い濃淡)。"""
    W, H, S = 1920, 1080, 4
    tw, th = 101, 100
    t = Image.new('L', (tw * S, th * S), 0)
    d = ImageDraw.Draw(t)
    c = (tw * S / 2, th * S / 2)

    def circ(r, w, f=255):
        d.ellipse((c[0] - r * S, c[1] - r * S, c[0] + r * S, c[1] + r * S), outline=f, width=int(w * S))
    circ(34, 3.5)
    circ(24, 2)
    circ(12, 2.5)
    for k in range(8):
        a = k * math.pi / 4
        d.polygon(poly_ellipse(c[0] + math.cos(a) * 18 * S, c[1] + math.sin(a) * 18 * S, 5.5 * S, 2.6 * S, a, 16), fill=255)
        d.ellipse((c[0] + math.cos(a + 0.39) * 29 * S - 2 * S, c[1] + math.sin(a + 0.39) * 29 * S - 2 * S,
                   c[0] + math.cos(a + 0.39) * 29 * S + 2 * S, c[1] + math.sin(a + 0.39) * 29 * S + 2 * S), fill=255)
    for (x, y) in ((0, 0), (tw * S, 0), (0, th * S), (tw * S, th * S)):
        d.rectangle((x - 9 * S, y - 9 * S, x + 9 * S, y + 9 * S), outline=255, width=int(2.5 * S))
        d.rectangle((x - 3 * S, y - 3 * S, x + 3 * S, y + 3 * S), fill=255)
    for (x, y) in ((tw * S / 2, 0), (tw * S / 2, th * S), (0, th * S / 2), (tw * S, th * S / 2)):
        d.polygon([(x - 7 * S, y), (x, y - 7 * S), (x + 7 * S, y), (x, y + 7 * S)], outline=255)
        d.line((x - 12 * S, y, x + 12 * S, y), fill=255, width=S)
        d.line((x, y - 12 * S, x, y + 12 * S), fill=255, width=S)
    t = t.resize((tw, th), Image.LANCZOS)
    m = np.tile(np.asarray(t).astype(np.float32) / 255, (H // th + 1, W // tw + 1))[:H, :W]
    rng = np.random.default_rng(318)
    grain = rng.random((H, W)).astype(np.float32)
    weave = ((np.arange(W)[None, :] + np.arange(H)[:, None]) % 2).astype(np.float32)
    base = np.array(hexc('#6d3d3d'), np.float32)
    v = -m * 17 + (grain - 0.5) * 9 + weave * 2.5 + (m * (grain > 0.6)) * 12
    return to_img(base[None, None, :] + v[..., None] * np.array([1, 0.9, 0.9], np.float32))


def d290():
    """暗い紫の地に、赤紫の葉の唐草(上下左右に対称な 200×200 の単位)。"""
    W, H, S, T = 2200, 1600, 4, 200
    q = Image.new('L', (T * S // 2, T * S // 2), 0)   # 単位の左上 1/4。中心 = 右下の角
    d = ImageDraw.Draw(q)
    rng = np.random.default_rng(290)
    c = T * S / 2

    def leaf(x, y, ang, L, wd):
        pts = []
        for k in range(9):
            t = k / 8
            pts.append((x + math.cos(ang) * L * t - math.sin(ang) * wd * math.sin(math.pi * t) ** 0.8, y + math.sin(ang) * L * t + math.cos(ang) * wd * math.sin(math.pi * t) ** 0.8))
        for k in range(8, -1, -1):
            t = k / 8
            pts.append((x + math.cos(ang) * L * t + math.sin(ang) * wd * math.sin(math.pi * t) ** 0.8, y + math.sin(ang) * L * t - math.cos(ang) * wd * math.sin(math.pi * t) ** 0.8))
        d.polygon([(px * S, py * S) for px, py in pts], fill=255)
    # 中心の暗い円(半径 30)のまわりに外へ向く葉の輪を 2 重、角に小さな房
    for ring_r, n, L, wd in ((44, 4, 20, 5.5), (60, 5, 24, 6.5), (82, 4, 20, 5.5)):
        for k in range(n):
            a = math.pi + (k + 0.5) / n * (math.pi / 2) + (rng.random() - 0.5) * 0.12
            x, y = 100 + math.cos(a) * ring_r, 100 + math.sin(a) * ring_r
            if x < 100 and y < 100:
                leaf(x, y, a + (rng.random() - 0.5) * 0.9, L * (0.8 + rng.random() * 0.4), wd)
    for k in range(5):
        a = math.pi * (1.0 + 0.5 * k / 4)
        leaf(8 - math.cos(a) * 4, 8 - math.sin(a) * 4, a + math.pi + (rng.random() - .5) * .3, 16, 4.5)
    d.line((100 * S - 1, 0, 100 * S - 1, 60 * S), fill=255, width=int(1.6 * S))   # 縦の茎
    d.line((0, 3 * S, 100 * S, 3 * S), fill=150, width=int(1.2 * S))                # 単位の境の横線
    tile = Image.new('L', (T * S, T * S), 0)
    tile.paste(q, (0, 0))
    tile.paste(q.transpose(Image.FLIP_LEFT_RIGHT), (T * S // 2, 0))
    tile.paste(q.transpose(Image.FLIP_TOP_BOTTOM), (0, T * S // 2))
    tile.paste(q.transpose(Image.ROTATE_180), (T * S // 2, T * S // 2))
    tile = tile.resize((T, T), Image.LANCZOS)
    m = np.tile(np.asarray(tile).astype(np.float32) / 255, (H // T + 1, W // T + 1))[:H, :W]
    m = np.roll(m, (100, 100), axis=(0, 1))
    bg = np.array([32, 8, 26], np.float32)
    fg = np.array([66, 26, 62], np.float32)
    col = bg * (1 - m[..., None]) + fg * m[..., None] + ((fbm(H, W, 3, 29, 1) - 0.5) * 7)[..., None]
    return to_img(col, np.ones((H, W), np.float32))


def bow_lattice(palette, knit=False):
    """リボンとひし形の並ぶ柄。濃い形(片側が波形の白いふち)が (142.25, 171) おきに並び、リボンは 1 列おきに上・下。
    その間の列に白い二重線のひし形(上下でつながって X になる)。palette = 地・線・濃い形・リボン・ふち。"""
    W, H, S = 1920, 1080, 2
    bgc, linec, blobc, bowc, lacec = palette
    im = Image.new('RGB', (W * S, H * S), bgc)
    d = ImageDraw.Draw(im)

    def P(x, y):
        return (x * S, y * S)
    for k in range(-1, 15):
        for j in range(-1, 8):
            qx, qy = 108.6 + 142.25 * k, 175.5 + 171 * j
            for hw, hh, wd in ((61, 93, 3 + 3 * knit), (49, 75, 5 + 4 * knit)):
                d.line([P(qx - hw, qy), P(qx, qy - hh), P(qx + hw, qy), P(qx, qy + hh), P(qx - hw, qy)], fill=linec, width=wd * S, joint='curve')
    for k in range(-1, 15):
        up = (k % 2 == 0)
        sg = -1 if up else 1                      # リボンのある側
        for j in range(-1, 8):
            x, y = 37.5 + 142.25 * k, 90 + 171 * j
            # 波形の白いふち(リボンと反対側の 2 辺)
            for side in (-1, 1):
                for t in range(5):
                    f = (t + 0.5) / 5
                    ex, ey = x + side * 54 * (1 - f), y - sg * 66 * f
                    d.ellipse(P(ex - 10, ey - 10) + P(ex + 10, ey + 10), fill=lacec)
            d.polygon([P(x - 52, y), P(x, y - 62), P(x + 52, y), P(x, y + 62)], fill=blobc)
            # リボン: 左右の羽(外の角がとがる)+ 結び目 + 内へ向く 2 本の足
            by = y + sg * 36
            for side in (-1, 1):
                d.polygon([P(x, by), P(x + side * 30, by + sg * 30), P(x + side * 50, by + sg * 38), P(x + side * 44, by), P(x + side * 48, by - sg * 26), P(x + side * 22, by - sg * 16)], fill=bowc)
                d.polygon([P(x + side * 3, by), P(x + side * 30, by - sg * 44), P(x + side * 8, by - sg * 30)], fill=bowc)
            d.ellipse(P(x - 9, by - 11) + P(x + 9, by + 11), fill=bowc)
    im = im.resize((W, H), Image.LANCZOS)
    if knit:
        # 編み目のような網点: ぼかしてから 9 px おきの丸い点の濃淡をのせる
        a = np.asarray(im.filter(ImageFilter.GaussianBlur(3.2))).astype(np.float32)
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        dots = 0.5 + 0.5 * np.cos(xx * 2 * math.pi / 9.2) * np.cos(yy * 2 * math.pi / 9.2)
        dots2 = 0.5 + 0.5 * np.cos((xx + 4.6) * 2 * math.pi / 9.2) * np.cos((yy + 4.6) * 2 * math.pi / 9.2)
        dd = np.maximum(dots, dots2)
        a = a * (0.80 + 0.2 * dd)[..., None] + (255 - a) * (0.20 * dd ** 2)[..., None]
        im = to_img(a)
    return im


def d295():
    return bow_lattice((hexc('#7a3c4a'), (255, 255, 255), hexc('#45303f'), (34, 30, 34), (255, 255, 255)))


def d294():
    return bow_lattice((hexc('#c2475b'), (255, 240, 222), hexc('#a33653'), hexc('#2b2a58'), (255, 240, 222)), knit=True)


def flower4(d, x, y, r, fill, S=1):
    """4 枚の細い花びら(十字)。"""
    for k in range(4):
        a = k * math.pi / 2
        cx, cy = x + math.cos(a) * r * 0.56, y + math.sin(a) * r * 0.56
        pts = []
        for j in range(24):
            t = 2 * math.pi * j / 24
            lx = math.cos(t) * r * 0.44
            ly = math.sin(t) * r * 0.21 * (1.0 + 0.35 * math.cos(t))   # 外側が少し太い
            pts.append(((cx + lx * math.cos(a) - ly * math.sin(a)) * S, (cy + lx * math.sin(a) + ly * math.cos(a)) * S))
        d.polygon(pts, fill=fill)


def d255():
    """白地に 4 弁の小花を千鳥に。ほとんどは薄い灰色、ところどころ えんじ と 青。"""
    W, H, S = 1920, 1080, 3
    im = Image.new('RGB', (W * S, H * S), (255, 255, 255))
    d = ImageDraw.Draw(im)
    rose, blue, gray = hexc('#a8687a'), hexc('#7c9fb3'), (239, 238, 239)
    for r in range(0, 8):
        y = 47 + 164.3 * r
        for k in range(-1, 13):
            x = (57 if r % 2 == 0 else 140) + 164 * k
            col = gray
            if r in (0, 6) and k % 3 == 1:
                col = rose
            if r == 3 and (k + 1) % 3 == 0:
                col = rose
            if r == 1 and (k + 1) % 4 == 0:
                col = blue
            if r == 5 and k % 4 == 1:
                col = blue
            flower4(d, x, y, 39, col, S)
    return im.resize((W, H), Image.LANCZOS)


def d254():
    S = 6
    m = Image.new('L', (82 * S, 82 * S), 0)
    flower4(ImageDraw.Draw(m), 41, 41, 39, 255, S)
    return fit(colorize(m.resize((82, 82), Image.LANCZOS), hexc('#83a2b2')), 82, 82, G(254)['bbox'])


def quarter_discs(which):
    """3000×3000 の四隅に半径 1500 の四分円。which = [(中心 x, 中心 y, 色), …]"""
    W = 3000
    S = 2
    im = Image.new('RGBA', (W * S, W * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for cx, cy, col in which:
        d.ellipse(((cx - 1500) * S, (cy - 1500) * S, (cx + 1500) * S, (cy + 1500) * S), fill=col + (255,))
    return im.resize((W, W), Image.LANCZOS)


YEL, BLU = hexc('#eeca67'), hexc('#6bacbf')


def d213():
    return quarter_discs([(3000, 0, YEL), (0, 3000, YEL)])


def d214():
    return quarter_discs([(0, 0, BLU), (3000, 3000, BLU)])


def d211():
    return quarter_discs([(3000, 0, YEL), (0, 3000, YEL), (0, 0, BLU), (3000, 3000, BLU)])


# ---------------------------------------------------------------- 枠・格子
def d181():
    """窓枠: 上下の帯に小窓、左右にひし形の桟、まんなかに横桟。線 = 暗い紫茶、四隅の小窓だけ半透明の灰。"""
    W, H, S = 1920, 1080, 2
    im = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    col = hexc('#4d3c47') + (255,)
    pane = hexc('#9a9ca6') + (255,)

    def box(x0, y0, x1, y1, c=col):
        d.rectangle((x0 * S, y0 * S, x1 * S - 1, y1 * S - 1), fill=c)
    for x0, x1 in ((100, 300), (W - 300, W - 100)):
        box(x0, 18, x1, 150, pane)
        box(x0, 930, x1, 1072, pane)
    for y0, y1 in ((0, 18), (150, 170), (910, 930), (1072, 1080)):
        box(0, y0, W, y1)
    for x in (80, 736):
        box(x, 0, x + 20, H)
        box(W - x - 20, 0, W - x, H)
    for x in (300, 518):
        for y0, y1 in ((0, 150), (930, 1080)):
            box(x, y0, x + 18, y1)
            box(W - x - 18, y0, W - x, y1)
    box(0, 530, 80, 550)
    box(W - 80, 530, W, 550)
    box(756, 530, W - 756, 550)
    for mx in (False, True):
        pts = [(418, 172), (735, 540), (418, 908), (101, 540), (418, 172)]
        if mx:
            pts = [(W - x, y) for x, y in pts]
        d.line([(x * S, y * S) for x, y in pts], fill=col, width=17 * S, joint='curve')
    return im.resize((W, H), Image.LANCZOS)


def d304():
    """細い桟の格子(縦 128 おき・横 227 おき)+ まんなかの太い柱。線のまわりに薄い影。"""
    W, H, S = 1920, 1080, 2
    m = Image.new('L', (W * S, H * S), 0)
    d = ImageDraw.Draw(m)
    for k in range(0, 16):
        x = 65 + 128 * k
        if abs(x - 961) < 40:
            continue
        d.rectangle(((x - 2.5) * S, 0, (x + 2.5) * S, H * S), fill=255)
    for k in range(0, 5):
        y = 75 + 227 * k
        d.rectangle((0, (y - 2.5) * S, W * S, (y + 2.5) * S), fill=255)
    d.rectangle((937 * S, 0, 985 * S, H * S), fill=255)
    m = m.resize((W, H), Image.LANCZOS)
    a = np.asarray(m).astype(np.float32) / 255
    sh = ndi.gaussian_filter(a, 5) * 0.55
    alpha = np.clip(np.maximum(a, sh), 0, 1)
    rgb = np.ones((H, W, 3), np.float32) * np.array(hexc('#43353a'), np.float32)
    return to_img(rgb, alpha)


# ---------------------------------------------------------------- 棒の菓子
def stick(rgb, alp, p0, p1, width, colfn, seed=0):
    """丸い棒(両端が丸い)を円柱の陰影つきで描き足す。colfn(t, d, n) → 色(t = 長さ方向 0..1、d = 幅方向 -1..1、n = 粒)。"""
    H, W = alp.shape
    x0, y0 = p0
    x1, y1 = p1
    r = width / 2
    xa, xb = int(max(0, min(x0, x1) - r - 2)), int(min(W, max(x0, x1) + r + 3))
    ya, yb = int(max(0, min(y0, y1) - r - 2)), int(min(H, max(y0, y1) + r + 3))
    yy, xx = np.mgrid[ya:yb, xa:xb].astype(np.float32)
    L = math.hypot(x1 - x0, y1 - y0)
    ux, uy = (x1 - x0) / L, (y1 - y0) / L
    t = ((xx - x0) * ux + (yy - y0) * uy) / L
    dperp = -(xx - x0) * uy + (yy - y0) * ux
    tc = np.clip(t, 0, 1)
    dist = np.hypot(xx - (x0 + ux * L * tc), yy - (y0 + uy * L * tc))
    n = vnoise(yb - ya, xb - xa, 3.0, seed)
    col, wmul = colfn(tc, np.clip(dperp / r, -1, 1), n)
    a = np.clip(r * wmul - dist + 0.5, 0, 1)
    dn = np.clip(dperp / (r * wmul), -1, 1)
    shade = 0.50 + 0.55 * np.sqrt(np.clip(1 - dn * dn, 0, 1)) + 0.38 * np.exp(-((dn + 0.38) / 0.2) ** 2)
    col = col * shade[..., None]
    reg = (slice(ya, yb), slice(xa, xb))
    rgb[reg] = rgb[reg] * (1 - a[..., None]) + col * a[..., None]
    alp[reg] = np.maximum(alp[reg], a)


def pretz_col(sauce=False):
    def f(t, d, n):
        base = np.array([238, 150, 36], np.float32) * (0.88 + 0.24 * n[..., None])
        fleck = (n > 0.80)[..., None]
        base = np.where(fleck, base * np.array([0.78, 0.62, 0.5], np.float32), base)   # 焼き色の粒
        if sauce:
            st = (np.sin(t * 60 + d * 2.5) > 0.55)[..., None] & (np.abs(d) < 0.6)[..., None]
            base = np.where(st, np.array([196, 70, 30], np.float32), base)
        return base, np.ones_like(t)
    return f


def pocky_col(split=0.27):
    def f(t, d, n):
        bis = np.array([250, 196, 92], np.float32) * (0.9 + 0.15 * n[..., None])
        cho = np.array([92, 52, 48], np.float32) * (0.75 + 0.4 * n[..., None])
        isb = (t < split)[..., None]
        return np.where(isb, bis, cho), np.where(t < split, 0.84, 1.0)
    return f


PRETZ_STICKS = [((300, 40), (190, 1445), 54, False), ((48, 180), (330, 1290), 52, False), ((82, 70), (300, 1262), 50, False),
                ((205, 260), (240, 1010), 44, True), ((160, 100), (250, 1345), 54, False), ((342, 190), (228, 1440), 54, False)]
POCKY_STICKS = [((432, 60), (345, 1500), 58), ((440, 180), (420, 1470), 58), ((520, 36), (270, 1560), 58),
                ((600, 90), (200, 1585), 58), ((545, 260), (120, 1600), 58), ((690, 210), (40, 1560), 58)]


def bundle(W, H, sticks, kind, bbox):
    rgb = np.zeros((H, W, 3), np.float32)
    alp = np.zeros((H, W), np.float32)
    for k, s in enumerate(sticks):
        cf = pretz_col(s[3]) if kind == 'pretz' else pocky_col()
        stick(rgb, alp, s[0], s[1], s[2], cf, seed=k * 7 + (5 if kind == 'pretz' else 50))
    return fit(to_img(rgb, alp), W, H, bbox)


def d322():
    return bundle(392, 1488, PRETZ_STICKS, 'pretz', G(322)['bbox'])


def d323():
    return bundle(728, 1636, POCKY_STICKS, 'pocky', G(323)['bbox'])


def outlined_small(big, W, H, bbox, edge=5):
    """大きい束を 1/4 にして白いふちを付ける(シール風)。"""
    a = big.getchannel('A')
    bb = a.getbbox()
    c = big.crop(bb)
    inner = (bbox[2] - bbox[0] - 2 * edge, bbox[3] - bbox[1] - 2 * edge)
    c = c.resize(inner, Image.LANCZOS)
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    out.paste(c, (bbox[0] + edge, bbox[1] + edge))
    al = np.asarray(out.getchannel('A')).astype(np.float32) / 255
    grow = np.clip(ndi.gaussian_filter(ndi.maximum_filter(al, size=2 * edge - 1), 0.8) * 1.4, 0, 1)
    white = to_img(np.ones((H, W, 3), np.float32) * np.array([252, 248, 240], np.float32), grow)
    white.alpha_composite(out)
    return white


def d274():
    return outlined_small(d322(), 98, 372, [0, 0, 98, 372], 4)


def d275():
    return outlined_small(d323(), 182, 409, [0, 0, 182, 409], 4)


def d107():
    """チョコの棒 1 本(上がチョコ・下が素焼き)+ 桃色のにじんだふち。"""
    W, H = 55, 185
    rgb = np.zeros((H, W, 3), np.float32)
    alp = np.zeros((H, W), np.float32)
    stick(rgb, alp, (27.5, 178), (27.5, 8), 13, pocky_col(0.2), 3)
    g = np.clip(ndi.gaussian_filter(alp, 1.6) * 1.6, 0, 1)
    glow = to_img(np.ones((H, W, 3), np.float32) * np.array([205, 110, 100], np.float32), g * 0.85)
    glow.alpha_composite(to_img(rgb, alp))
    return fit(glow, W, H, G(107)['bbox'])


def d109():
    """黄色い棒に赤い粒(サラダ味風)。"""
    W, H = 55, 185

    def cf(t, d, n):
        base = np.ones(t.shape + (3,), np.float32) * np.array([232, 205, 92], np.float32)
        dots = (np.sin(t * 46 + 1.0) * np.sin(d * 3.2 + t * 23) > 0.55)[..., None]
        return np.where(dots, np.array([228, 70, 44], np.float32), base), np.ones_like(t)
    rgb = np.zeros((H, W, 3), np.float32)
    alp = np.zeros((H, W), np.float32)
    stick(rgb, alp, (27.5, 10), (27.5, 176), 17, cf, 4)
    rgb = rgb * 0 + (rgb / np.maximum(0.5, 1))  # 陰影はそのまま
    g = np.clip(ndi.gaussian_filter(alp, 1.2) * 1.5, 0, 1)
    glow = to_img(np.ones((H, W, 3), np.float32) * np.array([236, 158, 102], np.float32), g * 0.8)
    glow.alpha_composite(to_img(rgb, alp))
    return fit(glow, W, H, G(109)['bbox'])


# ---------------------------------------------------------------- 桜
def petal_pts(L, wd, notch=0.16, tipw=0.5, n=16):
    """花びら 1 枚(根元 = 原点、先が +y 方向)。根元は細く、6 割の所でいちばん広く、先は 2 つの角と V の切れ込み。"""
    left = []
    for k in range(n + 1):
        t = k / n
        w = wd * (0.10 + 0.90 * math.sin(math.pi * t ** 0.9 * 0.62) ** 1.3)
        left.append((-w, L * t * 0.84))
    tipx = wd * tipw
    pts = [(0, 0)] + left[1:] + [(-tipx, L), (0, L * (1 - notch)), (tipx, L)] + [(-x, y) for x, y in reversed(left[1:])]
    return pts


def sakura(W, H, bbox, petal_col, top_col=None, stamens=False, rot=0.0, gap=0.0, widths=(1.0, 1.0, 1.0, 1.0, 1.0), top_scale=(1.0, 0.72)):
    """5 弁の桜(切れ込みのある花びら)。上の 1 枚だけ色を変えられる。"""
    S = 2 if max(W, H) > 2000 else 3
    C = 1600
    im = Image.new('RGBA', (C * S, C * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx = cy = C / 2
    order = [1, 2, 3, 4, 0]
    for k in order:
        a = rot + k * 2 * math.pi / 5      # 0 = 上
        L = 560 * (top_scale[0] if k == 0 else 1.0)
        wd = 138 * widths[k] * (top_scale[1] if k == 0 else 1.0)
        pts = petal_pts(L, wd, notch=0.17 if k else 0.2, tipw=0.42 if k else 0.5)
        out = []
        for x, y in pts:
            y = y + gap * 560
            X = x * math.cos(a) + y * math.sin(a)
            Y = -(-x * math.sin(a) + y * math.cos(a))
            out.append(((cx + X) * S, (cy + Y) * S))
        d.polygon(out, fill=tuple(top_col if (k == 0 and top_col) else petal_col) + (255,))
    if stamens:
        g = (40, 232, 60, 255)
        rng = np.random.default_rng(5)
        for k in range(15):
            a = 2 * math.pi * k / 15 + (rng.random() - .5) * 0.2
            r1 = 230 + rng.random() * 150
            d.line(((cx + math.sin(a) * 62) * S, (cy - math.cos(a) * 62) * S, (cx + math.sin(a) * r1) * S, (cy - math.cos(a) * r1) * S), fill=g, width=int(5 * S))
        d.ellipse(((cx - 62) * S, (cy - 62) * S, (cx + 62) * S, (cy + 62) * S), outline=g, width=int(8 * S))
    return fit(im, W, H, bbox)


def d282():
    return sakura(3000, 3000, G(282)['bbox'], hexc('#d6adaf'), hexc('#a09ac0'), stamens=True, rot=0.0)


def d270():
    return sakura(1920, 1080, G(270)['bbox'], hexc('#cfa4a6'), None, rot=0.12, top_scale=(1.0, 1.0))


def d204():
    im = sakura(1000, 1000, G(204)['bbox'], hexc('#cfa4a6'), hexc('#998fb6'), rot=0.0, gap=0.07)
    a = np.asarray(im).copy()
    a[..., 3] = (a[..., 3] * 0.88).astype(np.uint8)   # 元は少し透けている
    return Image.fromarray(a, 'RGBA')


def blossom(im, x, y, r, rot, S, rng):
    """枝の花: 丸い 5 弁(外が桃・内が淡い)+ 濃い芯 + しべの点。"""
    d = ImageDraw.Draw(im)
    for k in range(5):
        a = rot + k * 2 * math.pi / 5
        px_, py_ = x + math.sin(a) * r * 0.55, y - math.cos(a) * r * 0.55
        d.polygon([(p[0] * S, p[1] * S) for p in poly_ellipse(px_, py_, r * 0.40, r * 0.50, a, 20)], fill=(252, 160, 200, 255))
        d.polygon([(p[0] * S, p[1] * S) for p in poly_ellipse(x + math.sin(a) * r * 0.60, y - math.cos(a) * r * 0.60, r * 0.27, r * 0.36, a, 18)], fill=(255, 196, 224, 255))
        # 先の小さな切れ込み
        tx, ty = x + math.sin(a) * r * 1.04, y - math.cos(a) * r * 1.04
        d.polygon([(p[0] * S, p[1] * S) for p in poly_ellipse(tx, ty, r * 0.07, r * 0.09, a, 8)], fill=(0, 0, 0, 0))
    d.ellipse(((x - r * 0.2) * S, (y - r * 0.2) * S, (x + r * 0.2) * S, (y + r * 0.2) * S), fill=(238, 110, 160, 255))
    for k in range(8):
        a = rot + 0.3 + k * 2 * math.pi / 8
        rr = r * (0.28 + rng.random() * 0.18)
        sx_, sy_ = x + math.sin(a) * rr, y - math.cos(a) * rr
        d.line((x * S, y * S, sx_ * S, sy_ * S), fill=(255, 232, 240, 255), width=max(1, int(1.6 * S)))
        d.ellipse(((sx_ - 3.2) * S, (sy_ - 3.2) * S, (sx_ + 3.2) * S, (sy_ + 3.2) * S), fill=(255, 245, 235, 255))


def branch(W, H, bbox, trunk, twigs, brown, seed, per_twig=(4, 6), fr=(86, 106)):
    """桜の枝: 太さの変わる曲線の幹 + 小枝、その先と途中に花。"""
    S = 2
    im = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    rng = np.random.default_rng(seed)
    thick_curve(d, trunk, brown + (255,), S)
    spots = []
    for tw in twigs:
        thick_curve(d, tw, brown + (255,), S)
        cs = catmull(tw, 20)
        n = int(rng.integers(per_twig[0], per_twig[1] + 1))
        for j in range(n):
            t = 0.35 + 0.65 * (j + 0.5) / n
            p = cs[min(len(cs) - 1, int(t * (len(cs) - 1)))]
            side = (rng.random() - 0.5) * 2
            spots.append((p[0] + side * 120, p[1] + (rng.random() - 0.5) * 150))
        spots.append((tw[-1][0], tw[-1][1]))
    placed = []
    for (x, y) in spots:
        r = fr[0] + rng.random() * (fr[1] - fr[0])
        if any(math.hypot(x - px_, y - py_) < 0.85 * (r + pr) for px_, py_, pr in placed):
            continue
        placed.append((x, y, r))
        blossom(im, x, y, r, rng.random() * 6.28, S, rng)
    return fit(im.resize((W, H), Image.LANCZOS), W, H, bbox)


def d309():
    """左から入って下でいったん沈み、上と右上へ伸びる枝。"""
    trunk = [(58, 1420, 150), (300, 1500, 135), (620, 1650, 110), (860, 1900, 88), (1000, 2060, 78), (1160, 2030, 70), (1280, 1830, 62), (1400, 1640, 54)]
    twigs = [
        [(1400, 1640, 52), (1300, 1450, 36), (1120, 1250, 26), (1080, 1000, 18), (1010, 700, 12), (1060, 420, 8)],
        [(1120, 1250, 22), (1300, 1050, 14), (1560, 900, 9), (1640, 720, 7)],
        [(1090, 1010, 16), (980, 1000, 10), (900, 1080, 7)],
        [(1400, 1640, 44), (1560, 1570, 30), (1700, 1380, 20), (1900, 1250, 13), (2140, 1000, 9), (2280, 760, 7)],
        [(1700, 1380, 18), (1750, 1180, 11), (1640, 1300, 7)],
        [(1900, 1250, 12), (2040, 1330, 8), (1960, 1400, 6)],
        [(1560, 1570, 20), (1700, 1680, 12), (1760, 1640, 7)],
    ]
    return branch(2400, 2400, G(309)['bbox'], trunk, twigs, hexc('#6f3d20'), 309)


def d310():
    """左上から下がり、右へ横に広がる枝。花が多い。"""
    trunk = [(47, 660, 150), (220, 860, 130), (430, 1040, 105), (480, 1320, 90), (640, 1560, 80), (760, 1620, 70), (900, 1500, 60), (1080, 1400, 50)]
    twigs = [
        [(1080, 1400, 48), (980, 1180, 30), (1050, 950, 20), (1180, 800, 12), (1150, 700, 8)],
        [(1080, 1400, 44), (1280, 1500, 32), (1500, 1400, 24), (1700, 1330, 16), (1950, 1300, 10), (2200, 1380, 7)],
        [(1500, 1400, 22), (1600, 1150, 14), (1780, 900, 9), (1860, 760, 7)],
        [(1050, 950, 16), (1250, 880, 10), (1400, 760, 7)],
        [(1700, 1330, 14), (1900, 1100, 9), (2180, 1020, 7), (2300, 1100, 6)],
        [(1280, 1500, 20), (1420, 1100, 12), (1380, 950, 8)],
        [(1600, 1150, 12), (1500, 1000, 8), (1560, 800, 6)],
        [(1950, 1300, 9), (2080, 1500, 7), (1800, 1560, 6)],
    ]
    return branch(2400, 2400, G(310)['bbox'], trunk, twigs, hexc('#5e3b13'), 310, per_twig=(6, 9), fr=(80, 98))


# ---------------------------------------------------------------- 赤い線の図案(ソウルジェム・板チョコ・りんご・たい焼き)
def gem_mask(S=3):
    """卵形の宝石(斜めのかすれ線)+ 飾り枠(玉の並び)+ 上の環 + 下の台。L。"""
    W, H = 318, 567
    m = Image.new('L', (W * S, H * S), 0)
    d = ImageDraw.Draw(m)

    def E(cx, cy, rx, ry, **kw):
        d.ellipse(((cx - rx) * S, (cy - ry) * S, (cx + rx) * S, (cy + ry) * S), **kw)
    cx, cy = 159, 280
    E(cx, cy, 152, 176, outline=255, width=6 * S)
    E(cx, cy, 108, 148, outline=255, width=5 * S)
    for k in range(26):                      # 枠の玉と小さな穴
        a = 2 * math.pi * (k + 0.5) / 26
        x, y = cx + math.cos(a) * 130, cy + math.sin(a) * 162
        E(x, y, 15, 15, fill=255)
        E(x, y, 5.5, 5.5, fill=0)
    E(cx, cy, 91, 132, fill=255)
    for k in range(-12, 14):                  # かすれた斜めの線(抜き)
        y0 = cy + k * 21
        d.line(((cx - 100) * S, (y0 + 24) * S, (cx + 100) * S, (y0 - 24) * S), fill=0, width=int(2.4 * S))
    E(cx, cy, 91, 132, outline=255, width=6 * S)
    # 上: 首・襟・環
    d.polygon([(132 * S, 66 * S), (186 * S, 66 * S), (204 * S, 104 * S), (114 * S, 104 * S)], outline=255, width=5 * S)
    d.arc((92 * S, 92 * S, 226 * S, 140 * S), 180, 360, fill=255, width=6 * S)
    d.rounded_rectangle((139 * S, 6 * S, 179 * S, 66 * S), radius=12 * S, outline=255, width=7 * S)
    # 下: ひし形の飾り・波形の受け皿・台
    d.polygon([(cx * S, 425 * S), ((cx + 26) * S, 452 * S), (cx * S, 479 * S), ((cx - 26) * S, 452 * S)], outline=255, width=6 * S)
    E(cx, 452, 8, 8, fill=255)
    for k in range(-4, 5):
        E(cx + k * 17, 476 + abs(k) * 1.5, 9, 9, outline=255, width=3 * S)
    d.arc(((cx - 80) * S, 420 * S, (cx + 80) * S, 500 * S), 20, 160, fill=255, width=6 * S)
    E(cx, 524, 98, 40, outline=255, width=3 * S)
    return m.resize((W, H), Image.LANCZOS)


def d205():
    m = gem_mask()
    im = fringe(m, core=(232, 48, 20), edge=(210, 140, 40), blur=1.6, gain=1.3)
    return fit(im, 318, 567, G(205)['bbox'])


def choco_mask(S=3):
    """斜めに置いた板チョコ: 上半分はむいた板(四角い区切り・点々の網)、下半分は包み紙(走り書きの線)。L(回転前は横長)。"""
    W, H = 780, 330
    m = Image.new('L', (W * S, H * S), 0)
    d = ImageDraw.Draw(m)
    rng = np.random.default_rng(210)
    x_split = 440
    d.rectangle((x_split * S, 0, W * S - 1, H * S - 1), fill=255)
    for r in range(2):
        for c in range(3):
            bx = x_split + 26 + c * 108
            by = 28 + r * 150
            d.rectangle((bx * S, by * S, (bx + 76) * S, (by + 122) * S), fill=0)
            d.rectangle((bx * S, by * S, (bx + 76) * S, (by + 122) * S), outline=255, width=3 * S)
    d.rectangle((2 * S, 2 * S, x_split * S, (H - 2) * S), outline=255, width=3 * S)
    for _ in range(46):   # 包み紙の絵のような走り書き
        x, y = 30 + rng.random() * (x_split - 60), 25 + rng.random() * (H - 50)
        pts = [(x, y)]
        a = rng.random() * 6.28
        for k in range(int(4 + rng.random() * 6)):
            a += (rng.random() - 0.5) * 1.6
            x += math.cos(a) * 22
            y += math.sin(a) * 22
            pts.append((min(x_split - 8, max(8, x)), min(H - 8, max(8, y))))
        d.line([(px * S, py * S) for px, py in pts], fill=255, width=int((2 + rng.random() * 3) * S), joint='curve')
    m = m.resize((W, H), Image.LANCZOS)
    a = np.asarray(m).astype(np.float32) / 255
    yy, xx = np.mgrid[0:H, 0:W]
    dots = 0.55 + 0.45 * (np.sin(xx * 0.9) * np.sin(yy * 0.9) > -0.2)       # 網点
    a = np.where(xx >= x_split, a * dots, a * (0.75 + 0.25 * (vnoise(H, W, 3, 21) > 0.35)))
    return Image.fromarray((a * 255).astype(np.uint8), 'L').rotate(47, expand=True, resample=Image.BICUBIC)


def d210():
    return fit(fringe(choco_mask(), core=(250, 44, 8), edge=(253, 120, 40), blur=1.5, gain=1.25), 662, 674, G(210)['bbox'])


def apple_outline(cx, cy, rx, ry, n=90):
    """りんごの外形(上にくぼみ、下が少しすぼまる)。"""
    pts = []
    for k in range(n):
        t = 2 * math.pi * k / n
        x = math.sin(t)
        y = -math.cos(t)
        dent = 0.20 * math.exp(-(x / 0.33) ** 2) if y < 0 else 0.07 * math.exp(-(x / 0.3) ** 2)
        wide = 1.0 - 0.13 * max(0, y) ** 1.5
        pts.append((cx + rx * x * wide * (1 + 0.04 * math.sin(3 * t)), cy + ry * y * (1 - dent)))
    return pts


def apple_parts(W, H, seed, S=4):
    """りんごの型(L)と、てかりの斑の型(0..1)と、軸の型。"""
    body = Image.new('L', (W * S, H * S), 0)
    d = ImageDraw.Draw(body)
    cx, cy, rx, ry = W / 2, H * 0.57, W * 0.47, H * 0.40
    d.polygon([(x * S, y * S) for x, y in apple_outline(cx, cy, rx, ry)], fill=255)
    stem = Image.new('L', (W * S, H * S), 0)
    ds = ImageDraw.Draw(stem)
    thick_curve(ds, [(cx + W * 0.02, cy - ry * 0.82, W * 0.022), (cx - W * 0.0, cy - ry * 1.05, W * 0.02), (cx - W * 0.03, H * 0.015 + W * 0.02, W * 0.03)], 255, S)
    body = body.resize((W, H), Image.LANCZOS)
    stem = stem.resize((W, H), Image.LANCZOS)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    rr = np.hypot((xx - cx) / rx, (yy - cy) / ry)
    f = 0.55 * fbm(H, W, W / 9, seed, 3) + 0.75 * fbm(H, W, W / 30, seed + 3, 3, sx=0.6, sy=1.7)
    field = f * 1.35 - rr * 0.30 - 0.20
    return body, field, stem


def d87():
    """まるごとのりんご: 赤 + クリーム色のてかりの斑(版画のような 2 色)+ 軸。"""
    W, H = 157, 189
    body, field, stem = apple_parts(W, H, 87)
    b = np.asarray(body).astype(np.float32) / 255
    cream = np.clip((field - 0.30) * 14, 0, 1)
    red, cr, pk = np.array(hexc('#cf4a48'), np.float32), np.array(hexc('#fffbe0'), np.float32), np.array(hexc('#e9a08e'), np.float32)
    mid = np.clip(1 - np.abs(field - 0.30) * 16, 0, 1) * 0.6
    rgb = red * (1 - cream[..., None]) + cr * cream[..., None]
    rgb = rgb * (1 - mid[..., None]) + pk * mid[..., None]
    edge = np.clip((ndi.gaussian_filter(b, 1.2) - 0.25) * 4, 0, 1) < 0.93
    rgb = np.where(edge[..., None], red, rgb)
    st = np.asarray(stem).astype(np.float32) / 255
    rgb = rgb * (1 - st[..., None]) + np.array([190, 60, 60], np.float32) * st[..., None]
    return fit(to_img(rgb, np.maximum(b, st)), W, H, G(87)['bbox'])


def d216():
    """赤いりんごの影絵(ふちが濃く、中は抜け、点々が散る)+ 橙のにじみ。軸は左上へ。"""
    W, H = 392, 430
    body, field, stem = apple_parts(W, H, 216)
    b = np.asarray(body).astype(np.float32) / 255
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    rr2 = np.hypot((xx - W * 0.56) / (W * 0.47), (yy - H * 0.55) / (H * 0.40))      # 抜けは右上寄り → 左と下のふちが太い
    hole = np.clip((0.80 + (fbm(H, W, 26, 216, 3) - 0.5) * 0.55 - rr2) * 14, 0, 1)
    specks = (vnoise(H, W, 5, 99) > 0.80) & (vnoise(H, W, 30, 98) > 0.45)
    m = b * (1 - hole) + b * hole * specks
    m = np.maximum(m, np.asarray(stem).astype(np.float32) / 255)
    im = Image.fromarray((np.clip(m, 0, 1) * 255).astype(np.uint8), 'L').rotate(18, expand=True, resample=Image.BICUBIC)
    return fit(fringe(im, core=(255, 4, 4), edge=(252, 110, 20), blur=2.4, gain=1.5), W, H, G(216)['bbox'])


def half_apple(colors, S=4):
    """半分に切ったりんご(切り口が手前)。colors = 皮・果肉・芯。RGBA(回転ずみ)。"""
    W, H = 170, 170
    skin, flesh, core = colors
    im = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx, cy = 85, 88
    d.polygon([(x * S, y * S) for x, y in apple_outline(cx, cy + 4, 76, 68)], fill=skin + (255,))          # 皮(下と左にはみ出す)
    d.polygon([(x * S, y * S) for x, y in apple_outline(cx + 3, cy - 3, 69, 61)], fill=flesh + (255,))      # 切り口
    rng = np.random.default_rng(92)
    for k in range(9):                                                                                     # 芯: 小さな粒の集まり
        a = rng.random() * 6.28
        r = rng.random() * 9
        x, y = cx + 3 + math.cos(a) * r * 0.7, cy - 4 + math.sin(a) * r * 1.6
        d.polygon([(p[0] * S, p[1] * S) for p in poly_ellipse(x, y, 2 + rng.random() * 3.5, 1.5 + rng.random() * 3, a, 8)], fill=core + (255,))
    d.line(((cx + 3) * S, (cy - 34) * S, (cx + 3) * S, (cy - 12) * S), fill=core + (255,), width=int(1.6 * S))
    d.line(((cx + 3) * S, (cy + 6) * S, (cx + 3) * S, (cy + 26) * S), fill=core + (255,), width=int(1.2 * S))
    return im.resize((W, H), Image.LANCZOS).rotate(-52, expand=True, resample=Image.BICUBIC)


def d92():
    return fit(half_apple((hexc('#cf4a48'), hexc('#fffcdb'), hexc('#d55a55'))), 158, 153, G(92)['bbox'])


def taiyaki_mask(S=3):
    """たい焼き: 胴(うろこの斜め格子)・顔(目は二重丸・口)・尾びれ・背と腹のひれ。L(回転ずみ、頭が右上)。"""
    W, H = 470, 300
    m = Image.new('L', (W * S, H * S), 0)
    d = ImageDraw.Draw(m)
    cx, cy, rx, ry = 285, 150, 150, 88
    body = Image.new('L', (W * S, H * S), 0)
    ImageDraw.Draw(body).ellipse(((cx - rx) * S, (cy - ry) * S, (cx + rx) * S, (cy + ry) * S), fill=255)
    sc = Image.new('L', (W * S, H * S), 0)
    ds = ImageDraw.Draw(sc)
    for k in range(-20, 30):                     # うろこ: 2 方向の斜め線
        x = k * 30
        ds.line((x * S, 0, (x + 170) * S, H * S), fill=255, width=int(4.5 * S))
        ds.line((x * S, H * S, (x + 170) * S, 0), fill=255, width=int(4.5 * S))
    ds.rectangle((345 * S, 0, W * S, H * S), fill=0)   # 顔にはうろこなし
    m.paste(sc, (0, 0), ImageChops.multiply(body, sc))
    d.ellipse(((cx - rx) * S, (cy - ry) * S, (cx + rx) * S, (cy + ry) * S), outline=255, width=7 * S)
    d.arc((285 * S, 55 * S, 395 * S, 245 * S), -62, 62, fill=255, width=6 * S)             # えら
    for r_, w_ in ((22, 5), (11, 5)):
        d.ellipse(((385 - r_) * S, (122 - r_) * S, (385 + r_) * S, (122 + r_) * S), outline=255, width=w_ * S)
    d.arc((398 * S, 150 * S, 436 * S, 196 * S), 100, 250, fill=255, width=6 * S)           # 口
    tail = [(140, 150), (14, 40), (52, 150), (14, 262), (140, 150)]
    d.line([(x * S, y * S) for x, y in tail], fill=255, width=7 * S, joint='curve')
    for yy_ in (80, 115, 185, 220):
        d.line((132 * S, 150 * S, 34 * S, yy_ * S), fill=255, width=4 * S)
    d.line([(220 * S, 70 * S), (262 * S, 30 * S), (330 * S, 68 * S)], fill=255, width=6 * S, joint='curve')    # 背びれ
    d.line([(240 * S, 234 * S), (258 * S, 272 * S), (305 * S, 233 * S)], fill=255, width=6 * S, joint='curve')  # 腹びれ
    m = m.resize((W, H), Image.LANCZOS)
    a = np.asarray(m).astype(np.float32) / 255
    a *= 0.8 + 0.2 * (vnoise(H, W, 2.5, 253) > 0.3)       # 線のかすれ
    return Image.fromarray((a * 255).astype(np.uint8), 'L').rotate(27, expand=True, resample=Image.BICUBIC)


def d253():
    return fit(fringe(taiyaki_mask(), core=(250, 60, 10), edge=(253, 140, 10), blur=1.5, gain=1.3), 444, 384, G(253)['bbox'])


# ---------------------------------------------------------------- 水色の和風模様(四角の寄せ + 図案)
def d172():
    """152 px の水色の四角を寄せた模様(無地・縞・市松・麻の葉)+ 水色に刷った図案 5 つ。"""
    W, H = 1920, 1080
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    ox, oy, c = 580, 312, 152

    def cell(col, row):
        return (ox + col * c, oy + row * c, ox + (col + 1) * c, oy + (row + 1) * c)
    plain = {(3, 0): '#92c0cc', (6, 0): '#b1d0da', (1, 1): '#92c0cc', (2, 1): '#eef7f8', (1, 2): '#bedbe2', (2, 2): '#b1d0da',
             (5, 2): '#acd2dc', (1, 3): '#acd2dc', (4, 2): '#c8dde5', (3, 4): '#9cc6d6'}
    for k, v in plain.items():
        d.rectangle(cell(*k), fill=hexc(v) + (255,))
    x0, y0, x1, y1 = cell(1, 1)                      # 細い縦縞
    for x in range(x0, x1, 6):
        d.line((x, y0, x, y1), fill=(140, 188, 201, 255), width=1)
    for (col, row), bc in (((0, 3), '#92c0cc'), ((3, 3), '#b1d0da')):   # 市松
        x0, y0, x1, y1 = cell(col, row)
        n = 6
        s = c / n
        d.rectangle((x0, y0, x1, y1), fill=(255, 255, 255, 255))
        for i in range(n):
            for j in range(n):
                if (i + j) % 2 == 0:
                    d.rectangle((x0 + i * s, y0 + j * s, x0 + (i + 1) * s, y0 + (j + 1) * s), fill=hexc(bc) + (255,))
    for (col, row) in ((4, 2), (3, 4)):                                # 麻の葉
        S = 3
        t = Image.new('L', (c * S, c * S), 0)
        asanoha_lines(ImageDraw.Draw(t), c * S, c * S, 25.33 * S, 14.6 * S, 0, 0, max(1, int(0.9 * S)), 255)
        t = t.resize((c, c), Image.LANCZOS)
        x0, y0, _, _ = cell(col, row)
        im.paste(Image.new('RGBA', (c, c), (236, 245, 248, 255)), (x0, y0), t)

    def icon(mask, box, col=hexc('#9bbac6'), alpha=0.95):
        bb = mask.getbbox()
        mk = mask.crop(bb).resize((box[2] - box[0], box[3] - box[1]), Image.LANCZOS)
        mk = mk.point(lambda v: int(v * alpha))
        im.alpha_composite(colorize(mk, col), (box[0], box[1]))
    icon(gem_mask().rotate(90, expand=True), (459, 618, 732, 768))
    icon(choco_mask(), (1192, 466, 1336, 618), hexc('#a9bcc6'))
    icon(taiyaki_mask(), (892, 936, 1030, 1056))
    # 半分のりんご・まるごとのりんご(濃い青緑と淡い水色の 2 色)
    ha = half_apple((hexc('#4d6d78'), hexc('#dffcff'), hexc('#4d6d78')))
    ha = ha.crop(ha.getbbox()).resize((146, 142), Image.LANCZOS)
    im.alpha_composite(ha, (1040, 468))
    body, field, stem = apple_parts(126, 152, 87)
    b = np.maximum(np.asarray(body), np.asarray(stem)).astype(np.float32) / 255
    lt = np.clip((field - 0.30) * 14, 0, 1)[..., None]
    rgb = np.array(hexc('#4d6d78'), np.float32) * (1 - lt) + np.array(hexc('#c9eef3'), np.float32) * lt
    im.alpha_composite(to_img(rgb, b), (1202, 768))
    g = G(172)['bbox']
    bb = im.getchannel('A').getbbox()
    assert abs(bb[0] - g[0]) < 4 and abs(bb[3] - g[3]) < 4, (bb, g)
    return im


# ---------------------------------------------------------------- 菓子・盆
def d206():
    """いちごのケーキ: 茶色いスポンジの円柱(粒の質感)+ 上から垂れる桃色のクリーム + いちご 3 つ。"""
    W = H = 1200
    S = 2
    im = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    rng = np.random.default_rng(206)
    x0, x1, yt, yb = 378, 884, 470, 742
    # スポンジ(下が丸い円柱)
    d.rectangle((x0 * S, yt * S, x1 * S, (yb - 28) * S), fill=(190, 112, 62, 255))
    d.ellipse((x0 * S, (yb - 60) * S, x1 * S, yb * S), fill=(176, 100, 54, 255))
    im = im.resize((W, H), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32)
    n = fbm(H, W, 9, 2060, 3)
    n2 = vnoise(H, W, 4, 2061)
    xx = np.arange(W, dtype=np.float32)[None, :]
    cyl = 0.80 + 0.28 * np.sqrt(np.clip(1 - ((xx - (x0 + x1) / 2) / ((x1 - x0) / 2)) ** 2, 0, 1))
    a[..., :3] *= (cyl * (0.72 + 0.56 * n))[..., None]
    crumb = (n2 > 0.74)[..., None]
    a[..., :3] = np.where(crumb, a[..., :3] * 0.5 + np.array([236, 170, 96], np.float32) * 0.5, a[..., :3])
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')
    top = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(top)
    pink, pink2, pink3 = (240, 205, 212, 255), (226, 170, 178, 255), (252, 232, 236, 255)
    # クリーム: 上の面の楕円 + ふちから垂れるしずく
    for k in range(13):
        x = x0 + 8 + k * (x1 - x0 - 16) / 12
        dl = 28 + rng.random() * 46
        d.rounded_rectangle(((x - 24) * S, (yt - 6) * S, (x + 24) * S, (yt + dl + 3) * S), radius=22 * S, fill=pink2)
        d.rounded_rectangle(((x - 24) * S, (yt - 10) * S, (x + 24) * S, (yt + dl - 4) * S), radius=22 * S, fill=pink)
    d.ellipse(((x0 - 6) * S, (yt - 42) * S, (x1 + 6) * S, (yt + 30) * S), fill=pink)
    d.ellipse(((x0 + 40) * S, (yt - 34) * S, (x1 - 60) * S, (yt + 6) * S), fill=pink3)
    # いちご
    for (sx_, sy_, rot) in ((470, 418, -0.5), (650, 412, 0.25), (792, 424, 1.1)):
        pts = []
        for k in range(40):
            t = 2 * math.pi * k / 40
            lx = 46 * math.cos(t) * (1 - 0.32 * math.sin(t))
            ly = 40 * math.sin(t)
            pts.append(((sx_ + lx * math.cos(rot) - ly * math.sin(rot)) * S, (sy_ + lx * math.sin(rot) + ly * math.cos(rot)) * S))
        d.polygon(pts, fill=(214, 44, 48, 255))
        d.polygon([((p[0] / S - sx_) * 0.55 + sx_ - 6) * S if j == 0 else ((p[1] / S - sy_) * 0.45 + sy_ - 9) * S for p in pts for j in (0, 1)], fill=(236, 92, 88, 255))
        for k in range(12):
            a_ = rng.random() * 6.28
            r_ = rng.random() * 30
            px_, py_ = sx_ + math.cos(a_) * r_, sy_ + math.sin(a_) * r_ * 0.8
            d.ellipse(((px_ - 2.2) * S, (py_ - 2.8) * S, (px_ + 2.2) * S, (py_ + 2.8) * S), fill=(250, 214, 150, 255))
        lx_, ly_ = sx_ - math.cos(rot) * 0 + math.sin(rot) * 34, sy_ - math.cos(rot) * 34
        for k in range(4):
            a_ = -rot + k * 0.7 - 1.0
            d.polygon([(lx_ * S, ly_ * S), ((lx_ + math.sin(a_) * 30 - 7) * S, (ly_ - math.cos(a_) * 24) * S), ((lx_ + math.sin(a_) * 30 + 7) * S, (ly_ - math.cos(a_) * 20) * S)], fill=(108, 170, 96, 255))
    im.alpha_composite(top.resize((W, H), Image.LANCZOS))
    return fit(im, W, H, G(206)['bbox'])


def tray(front_only):
    """浅い盆(斜め上から。ふちが波形、取っ手の穴)。front_only = 手前の 2 枚の壁だけ。"""
    W = H = 1200
    S = 2
    im = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    Lc, Fc, Rc, Bc = (125, 648), (640, 800), (1080, 690), (560, 572)        # 左・手前・右・奥 の角(ふちの高さ)
    wall = 68
    line = (58, 54, 50, 255)
    outer, inner, floor = hexc('#dedad0') + (255,), hexc('#c4bfb2') + (255,), hexc('#b3ae9f') + (255,)

    def rim(p, q, amp, ph, n=60):
        """p→q の上のふち(波形)。"""
        pts = []
        for k in range(n + 1):
            s = k / n
            x = p[0] + (q[0] - p[0]) * s
            y = p[1] + (q[1] - p[1]) * s
            bump = amp * math.exp(-((s - ph) / 0.17) ** 2) + amp * 0.22 * abs(math.sin(s * 40)) * math.exp(-((s - ph) / 0.2) ** 2) - amp * 0.35 * math.exp(-((s - (1 - ph)) / 0.25) ** 2)
            pts.append((x, y - bump))
        return pts

    def poly(pts, fill):
        d.polygon([(x * S, y * S) for x, y in pts], fill=fill)
        d.line([(x * S, y * S) for x, y in pts + [pts[0]]], fill=line, width=int(2.5 * S), joint='curve')

    def slot(p, q, s, w_, h_, fill):
        x = p[0] + (q[0] - p[0]) * s
        y = p[1] + (q[1] - p[1]) * s + 30
        ang = math.atan2(q[1] - p[1], q[0] - p[0])
        pts = [(x + math.cos(t) * w_ * math.cos(ang) - min(0, math.sin(t)) * 0 - math.sin(t) * h_ * (1 if math.sin(t) < 0 else 0.25) * -math.sin(ang) * 0, y + math.cos(t) * w_ * math.sin(ang) + math.sin(t) * h_ * (1 if math.sin(t) < 0 else 0.3)) for t in (2 * math.pi * k / 30 for k in range(30))]
        poly(pts, fill)
    if not front_only:
        r1 = rim(Lc, Bc, 50, 0.4)
        r2 = rim(Bc, Rc, 46, 0.55)
        poly(r1 + [(Bc[0], Bc[1] + wall - 10), (Lc[0], Lc[1] + wall)], inner)
        poly(r2 + [(Rc[0], Rc[1] + wall), (Bc[0], Bc[1] + wall - 10)], inner)
        poly([(Lc[0] + 14, Lc[1] + wall - 6), (Bc[0], Bc[1] + wall - 12), (Rc[0] - 14, Rc[1] + wall - 8), (Fc[0], Fc[1] + wall - 20)], floor)
        slot(Lc, Bc, 0.42, 60, 15, floor)
    r3 = rim(Lc, Fc, 46, 0.3)
    r4 = rim(Fc, Rc, 46, 0.66)
    poly(r3 + [(Fc[0], Fc[1] + wall), (Lc[0], Lc[1] + wall + 6)], outer)
    poly(r4 + [(Rc[0], Rc[1] + wall + 14), (Fc[0], Fc[1] + wall)], outer)
    slot(Fc, Rc, 0.60, 62, 17, (150, 146, 138, 255))
    for k in range(6):                                   # 透かしの小さな穴
        s = 0.18 + k * 0.05
        x, y = Lc[0] + (Fc[0] - Lc[0]) * s, Lc[1] + (Fc[1] - Lc[1]) * s + 6
        d.ellipse(((x - 3) * S, (y - 5) * S, (x + 3) * S, (y + 5) * S), fill=line)
    return im.resize((W, H), Image.LANCZOS)


def d207():
    return fit(tray(False), 1200, 1200, G(207)['bbox'])


def d208():
    return fit(tray(True), 1200, 1200, G(208)['bbox'])


# ---------------------------------------------------------------- ロゴ風の字・バーコード
def round_mask(m, r):
    """型の角を丸める(ぼかして切り直す)。"""
    return m.filter(ImageFilter.GaussianBlur(r)).point(lambda v: 255 if v > 127 else 0).filter(ImageFilter.GaussianBlur(0.8))


def d73():
    """10th ANNIVERSARY の記念マーク風: 太い丸い「10」(0 は卵形の宝石と受け皿)・th・弓なりの帯に字・左右の飾り線と星。
    字はフリーフォント(Noto Sans JP Black)を丸めて使い、形は自前の図形で組む。"""
    W, H, S = 969, 920, 3
    pink, beige = hexc('#ee6e7c'), hexc('#e8c9b2')
    m = Image.new('L', (W * S, H * S), 0)      # 桃色の型
    b = Image.new('L', (W * S, H * S), 0)      # 肌色の型
    d = ImageDraw.Draw(m)
    db = ImageDraw.Draw(b)

    def cap(p, q, w, dr=None, f=255):
        dr = dr or ImageDraw.Draw(m)
        dr.line((p[0] * S, p[1] * S, q[0] * S, q[1] * S), fill=f, width=int(w * S))
        for x, y in (p, q):
            dr.ellipse(((x - w / 2) * S, (y - w / 2) * S, (x + w / 2) * S, (y + w / 2) * S), fill=f)
    # 1
    cap((367, 295), (367, 518), 94)
    cap((325, 318), (360, 296), 96)
    # 0 = しずく形の宝石 + 卵形の穴 + 受け皿 + 台
    gx, gy = 575, 385
    d.ellipse(((gx - 112) * S, (gy - 105) * S, (gx + 112) * S, (gy + 118) * S), fill=255)
    d.polygon([((gx - 80) * S, (gy - 70) * S), ((gx - 22) * S, (gy - 142) * S), ((gx + 22) * S, (gy - 142) * S), ((gx + 80) * S, (gy - 70) * S)], fill=255)
    d.ellipse(((gx - 34) * S, (gy - 158) * S, (gx + 34) * S, (gy - 100) * S), fill=255)
    cup = Image.new('L', m.size, 0)
    dc = ImageDraw.Draw(cup)
    dc.ellipse(((gx - 128) * S, (gy - 80) * S, (gx + 128) * S, (gy + 150) * S), fill=255)
    dc.rectangle((0, 0, W * S, (gy + 22) * S), fill=0)
    gap = Image.new('L', m.size, 0)
    dg = ImageDraw.Draw(gap)
    dg.ellipse(((gx - 104) * S, (gy - 120) * S, (gx + 104) * S, (gy + 100) * S), fill=255)
    m.paste(0, (0, 0), ImageChops.multiply(cup, ImageChops.invert(gap)).point(lambda v: 0))  # (何もしない: 下で組む)
    d.ellipse(((gx - 44) * S, (gy - 50) * S, (gx + 44) * S, (gy + 62) * S), fill=0)        # 卵形の穴
    ring = ImageChops.subtract(cup, gap)
    # 宝石と受け皿の間のすき間
    sep = Image.new('L', m.size, 0)
    ds_ = ImageDraw.Draw(sep)
    ds_.ellipse(((gx - 104) * S, (gy - 120) * S, (gx + 104) * S, (gy + 100) * S), outline=255, width=13 * S)
    ds_.rectangle((0, 0, W * S, (gy + 22) * S), fill=0)
    m = ImageChops.subtract(m, sep)
    m = ImageChops.lighter(m, ring)
    d = ImageDraw.Draw(m)
    for sgn in (-1, 1):                       # 受け皿のとがった両端
        d.polygon([((gx + sgn * 128) * S, (gy + 36) * S), ((gx + sgn * 118) * S, (gy + 12) * S), ((gx + sgn * 100) * S, (gy + 40) * S)], fill=255)
    d.ellipse(((gx - 22) * S, (gy + 62) * S, (gx + 22) * S, (gy + 100) * S), fill=255)     # 穴の下のふくらみ
    d.ellipse(((gx - 78) * S, (gy + 140) * S, (gx + 78) * S, (gy + 184) * S), fill=255)    # 台
    d.rectangle(((gx - 26) * S, (gy + 120) * S, (gx + 26) * S, (gy + 160) * S), fill=255)
    # th(フォントを丸める)
    f = ImageFont.truetype(F_BLACK, 150 * S)
    t = Image.new('L', m.size, 0)
    ImageDraw.Draw(t).text((492 * S, 668 * S), 'th', font=f, fill=255, anchor='mm')
    t = round_mask(t.filter(ImageFilter.MaxFilter(2 * S + 1)), 4 * S)
    m = ImageChops.lighter(m, t)
    d = ImageDraw.Draw(m)
    # 左右の飾り線・点・星
    def star(x, y, r, rot):
        d = ImageDraw.Draw(m)
        pts = []
        for k in range(10):
            a = rot + k * math.pi / 5
            rr = r if k % 2 == 0 else r * 0.58
            pts.append(((x + math.sin(a) * rr) * S, (y - math.cos(a) * rr) * S))
        d.polygon(pts, fill=255)
    for sgn in (-1, 1):
        def X(x):
            return 484.5 + sgn * (x - 484.5)
        for (xa, ya, xb, yb) in ((100, 412, 142, 418), (75, 456, 145, 456), (88, 495, 118, 492), (72, 548, 105, 540), (125, 574, 160, 565), (135, 532, 155, 527), (34, 456, 46, 456)):
            cap((X(xa), ya), (X(xb), yb), 17)
        ImageDraw.Draw(m).ellipse(((X(147) - 9) * S, (491 - 9) * S, (X(147) + 9) * S, (491 + 9) * S), fill=255)
        star(X(60), 407, 19, 0.3 * sgn)
        star(X(28), 552, 19, -0.2 * sgn)
    m = round_mask(m, 2 * S)
    # 弓なりの帯
    band_o = Image.new('L', m.size, 0)
    dbo = ImageDraw.Draw(band_o)
    oc, orad = (485, 488), 430
    ic, irad = (485, 430), 365
    dbo.ellipse(((oc[0] - orad) * S, (oc[1] - orad) * S, (oc[0] + orad) * S, (oc[1] + orad) * S), fill=255)
    dbo.ellipse(((ic[0] - irad) * S, (ic[1] - irad) * S, (ic[0] + irad) * S, (ic[1] + irad) * S), fill=0)
    dbo.polygon([(0, 0), (W * S, 0), (W * S, 690 * S), (700 * S, 735 * S), (485 * S, 760 * S), (270 * S, 735 * S), (0, 690 * S)], fill=0)
    dbo.polygon([(0, 690 * S), (205 * S, 668 * S), (120 * S, 760 * S), (0, 760 * S)], fill=0)
    dbo.polygon([(W * S, 690 * S), (764 * S, 668 * S), (849 * S, 760 * S), (W * S, 760 * S)], fill=0)
    band_i = band_o.filter(ImageFilter.MinFilter(2 * (14 * S // 2) * 2 + 1))
    # 帯の両端の旗
    for sgn in (-1, 1):
        def X(x):
            return 484.5 + sgn * (x - 484.5)
        flag = [(X(62), 606), (X(278), 606), (X(278), 728), (X(62), 728), (X(96), 667)]
        d2 = ImageDraw.Draw(band_o)
        d2.polygon([(x * S, y * S) for x, y in flag], fill=255)
        d2.line([(x * S, y * S) for x, y in flag + [flag[0]]], fill=255, width=14 * S, joint='curve')
        inner_flag = [(X(84), 622), (X(250), 622), (X(140), 712), (X(84), 712), (X(108), 667)]
        ImageDraw.Draw(band_i).polygon([(x * S, y * S) for x, y in inner_flag], fill=255)
    m = ImageChops.lighter(m, round_mask(band_o, 2 * S))
    b = ImageChops.lighter(b, band_i)
    # 旗の中の 3 本線(桃色)
    stripes = Image.new('L', m.size, 0)
    for sgn in (-1, 1):
        def X(x):
            return 484.5 + sgn * (x - 484.5)
        for yy_, xa, xb in ((640, 122, 240), (666, 122, 215), (692, 122, 188)):
            cap((X(xa), yy_), (X(xb), yy_), 13, ImageDraw.Draw(stripes))
    # 帯の字: 1 字ずつ弧に沿って回して置く
    txt = 'ANNIVERSARY'
    fa = ImageFont.truetype(F_BLACK, 62 * S)
    letters = Image.new('L', m.size, 0)
    tc, tr = (485, 456), 394
    a0, a1 = math.radians(-39), math.radians(39)
    for k, ch in enumerate(txt):
        a = a0 + (a1 - a0) * k / (len(txt) - 1)
        g = Image.new('L', (110 * S, 110 * S), 0)
        ImageDraw.Draw(g).text((55 * S, 55 * S), ch, font=fa, fill=255, anchor='mm')
        g = g.rotate(math.degrees(a), resample=Image.BICUBIC)
        x = tc[0] + math.sin(a) * tr
        y = tc[1] + math.cos(a) * tr
        letters.paste(255, (int((x - 55) * S), int((y - 55) * S)), g)
    letters = round_mask(letters, 2.2 * S)
    pk = ImageChops.lighter(stripes, letters)
    bm = ImageChops.subtract(b, pk)
    m = ImageChops.lighter(ImageChops.subtract(m, b), pk)
    im = Image.new('RGBA', m.size, (0, 0, 0, 0))
    im.paste(Image.new('RGBA', m.size, beige + (255,)), (0, 0), bm)
    im.paste(Image.new('RGBA', m.size, pink + (255,)), (0, 0), m)
    return fit(im.resize((W, H), Image.LANCZOS), W, H, G(73)['bbox'])


def d76():
    """JAN 8 桁(11111111)のバーコード: 規格どおりの棒の並び(左 = 奇数パリティ、右 = 偶数)+ 下に数字。"""
    W, H, S = 151, 124, 6
    Lc, Rc = '0011001', '1100110'
    bits = '101' + Lc * 4 + '01010' + Rc * 4 + '101'
    im = Image.new('RGB', (W * S, H * S), (255, 255, 255))
    d = ImageDraw.Draw(im)
    x0, mw = 14.0, 123.0 / len(bits)
    guard = set(range(0, 3)) | set(range(31, 36)) | set(range(64, 67))
    for k, bch in enumerate(bits):
        if bch == '1':
            y1 = 118 if k in guard else 106
            d.rectangle((round((x0 + k * mw) * S), 3 * S, round((x0 + (k + 1) * mw) * S) - 1, y1 * S), fill=(0, 0, 0))
    f = ImageFont.truetype(F_REG, 18 * S)
    for g_, xs in ((0, 21), (1, 83)):
        for k in range(4):
            d.text(((xs + k * 13.2 + 5) * S, 113 * S), '1', font=f, fill=(0, 0, 0), anchor='mm')
    return im.resize((W, H), Image.LANCZOS)


def pretz_banner(fill_gray):
    """PRETZ と手書き風に書いた、はためく帯(上下に赤い帯)。字はフリーフォント(APJapanesefont)を太らせ、帯の形に沿って曲げる。"""
    W, H = 1920, 1080
    sw, sh = 2400, 900
    red = np.array(hexc('#d24145'), np.float32)
    src_a = Image.new('L', (sw, sh), 0)         # 赤の型
    d = ImageDraw.Draw(src_a)
    d.rectangle((0, 0, sw, 60), fill=255)
    d.rectangle((0, sh - 66, sw, sh), fill=255)
    f = ImageFont.truetype(F_HAND, 900)
    t = Image.new('L', (sw, sh), 0)
    dt = ImageDraw.Draw(t)
    xs = [90, 520, 980, 1420, 1880]
    for ch, x, dy in zip('PRETZ', xs, (40, 0, -10, -30, 10)):
        dt.text((x, sh / 2 + dy), ch, font=f, fill=255, anchor='lm')
    t = t.filter(ImageFilter.MaxFilter(27)).filter(ImageFilter.GaussianBlur(3)).point(lambda v: 255 if v > 110 else 0)
    wear = (vnoise(sh, sw, 5, 78) > 0.13) | (vnoise(sh, sw, 60, 79) > 0.2)     # ごく軽いかすれ
    t = Image.fromarray((np.asarray(t) * wear).astype(np.uint8), 'L')
    src_a = ImageChops.lighter(src_a, t)
    ra = np.asarray(src_a).astype(np.float32) / 255
    # 帯の形: 上の辺 T(u) と下の辺 B(u)
    from scipy.interpolate import PchipInterpolator as PI
    Tu = [0, .5, .72, .88, 1]
    Tp = [(235, 430), (900, 240), (1200, 214), (1400, 250), (1510, 372)]
    Bu = [0, .5, .78, .92, 1]
    Bp = [(348, 956), (1050, 722), (1450, 672), (1620, 696), (1705, 757)]
    Tx, Ty = PI(Tu, [p[0] for p in Tp]), PI(Tu, [p[1] for p in Tp])
    Bx, By = PI(Bu, [p[0] for p in Bp]), PI(Bu, [p[1] for p in Bp])
    S = 2
    nu, nv = 5200, 2200
    u = np.linspace(0, 1, nu, dtype=np.float32)[None, :]
    v = np.linspace(0, 1, nv, dtype=np.float32)[:, None]
    X = Tx(u) * (1 - v) + Bx(u) * v
    Y = Ty(u) * (1 - v) + By(u) * v
    si = np.clip((v * (sh - 1)).astype(int), 0, sh - 1) + np.zeros_like(u, int)
    sj = np.clip((u * (sw - 1)).astype(int), 0, sw - 1) + np.zeros_like(v, int)
    val = ra[si, sj]
    xi = np.clip((X * S).astype(int), 0, W * S - 1)
    yi = np.clip((Y * S).astype(int), 0, H * S - 1)
    acc = np.zeros((H * S, W * S), np.float32)
    cnt = np.zeros((H * S, W * S), np.float32)
    np.add.at(acc, (yi, xi), val)
    np.add.at(cnt, (yi, xi), 1)
    inside = cnt > 0
    redm = np.where(inside, acc / np.maximum(cnt, 1), 0)
    inside = ndi.binary_closing(inside, iterations=2)
    redm = ndi.gaussian_filter(redm, 0.7)
    if fill_gray:
        alpha = inside.astype(np.float32)
        rgb = np.array([208, 208, 208], np.float32) * (1 - redm[..., None]) + red * redm[..., None]
    else:
        alpha = redm
        rgb = np.ones((H * S, W * S, 3), np.float32) * red
    im = to_img(rgb, alpha).resize((W, H), Image.LANCZOS)
    return im


def d79():
    return fit(pretz_banner(True), 1920, 1080, G(79)['bbox'])


def d78():
    return fit(pretz_banner(False), 1920, 1080, G(78)['bbox'])


# ---------------------------------------------------------------- 実行
HOW = {
    84: ('washi', '和紙: 白の地 + 薄桃のむら(重ねた乱れ)+ しわの凹凸を光の勾配で + 細い繊維の線'),
    303: ('washi', '和紙(#84 と同じ作り・別の種)'),
    306: ('d306', '白い布: ゆがめた斜めの波を重ねた高さの地図を左上の光で陰影'),
    307: ('d307', '木の板: 横板 8 枚・横に伸ばした乱れの木目・濃いすじ・板の溝・四隅を暗く'),
    293: ('grad_flecks', '桃→クリーム→黄の縦の移り変わり + 明るい小さな粒'),
    320: ('grad_flecks', '同上(別の種)'),
    83: ('d83', '麻の葉の白線(三角格子 + 重心から頂点へ。周期 288×162)'),
    376: ('yagasuri_mask/d376', '矢絣(列幅 24.85・帯 53.5 の山形を列ごとにずらす)を灰白 2 階調で'),
    313: ('yagasuri_mask/d313', '矢絣をえんじ 1 色・透明の地で'),
    106: ('lantern_diamond', '暗い赤のひし形の板(勾配 + 粒 + ふち)に赤い提灯形(卵・ひだ・金具)と四隅の飾り'),
    370: ('lantern_pattern', 'ひし形の板を周期 220×175.5 の千鳥に並べる'),
    296: ('lantern_pattern', '同上'),
    314: ('lantern_pattern', '同上'),
    318: ('d318', '小豆色の地 + 円い紋と四角の織り柄(周期 101×100、弱い濃淡)+ 織り目の粒'),
    290: ('d290', '暗い紫の地 + 葉の輪を 1/4 だけ描いて上下左右に写した 200 px の単位を敷く'),
    295: ('bow_lattice', '片側が波形のふちの濃い形(142.25×171 おき、リボンは 1 列おきに上下)+ 間の列に白い二重線のひし形'),
    294: ('bow_lattice', '同じ柄を桃・紺・クリームで描き、ぼかして 9 px おきの網点の濃淡をのせる(編み目風)'),
    255: ('d255', '白地に 4 弁の小花を千鳥(164 おき)。えんじ・青を決まった位置に'),
    254: ('d254', '4 弁の小花 1 つ(青)'),
    211: ('quarter_discs', '四隅に半径 1500 の四分円(黄 2・青 2)'),
    213: ('quarter_discs', '右上と左下に黄の四分円'),
    214: ('quarter_discs', '左上と右下に青の四分円'),
    181: ('d181', '窓枠: 帯・柱・ひし形の桟を長方形と太線で、四隅の小窓を灰で'),
    304: ('d304', '細い格子(縦 128・横 227 おき)+ 中央の太い柱 + ぼかした影'),
    322: ('bundle/stick', 'プリッツ風の棒 6 本: 円柱の陰影(幅方向の式)+ 焼き色の粒、1 本はたれの縞'),
    323: ('bundle/stick', 'ポッキー風の棒 6 本: 上 27% が素焼き・下がチョコ、円柱の陰影'),
    274: ('outlined_small', '#322 と同じ束を 1/4 で描き白いふち'),
    275: ('outlined_small', '#323 と同じ束を 1/4 で描き白いふち'),
    107: ('d107', 'チョコの棒 1 本 + 桃色のにじみ'),
    109: ('d109', '黄色い棒に赤い粒 + にじみ'),
    282: ('sakura', '切れ込みのある花びら 5 枚(上だけ薄紫)+ 緑のしべ 15 本と輪'),
    270: ('sakura', '花びら 5 枚(桃 1 色、少し右に傾ける)'),
    204: ('sakura', '花びら 5 枚を離して置く(上だけ薄紫、少し透ける)'),
    309: ('branch/blossom', '太さの変わる曲線の幹と小枝 7 本 + 5 弁の花(桃 2 階調・芯・しべ)を種 309 で'),
    310: ('branch/blossom', '幹と小枝 8 本 + 花(種 310)'),
    205: ('gem_mask/fringe', '卵形の宝石(斜めの抜き線)・玉の並ぶ枠・環・台の線画 → 赤い芯と橙のにじみ'),
    210: ('choco_mask/fringe', '板チョコ(区切り 3×2 と網点)+ 包み紙(走り書き)を 47° 回す → 赤と橙'),
    216: ('apple_parts/d216', 'りんごの外形から中を乱れで抜いた影絵 + 点々 + 軸 → 赤と橙のにじみ'),
    253: ('taiyaki_mask/fringe', 'たい焼き(楕円の胴・斜め格子のうろこ・二重丸の目・尾びれ)を 27° 回す → 赤と橙'),
    87: ('apple_parts/d87', 'りんごの外形 + 乱れで作ったクリーム色の斑(2 色刷り風)+ 軸'),
    92: ('half_apple', '半分のりんご(皮・切り口・芯の粒)を回す'),
    172: ('d172', '152 px の水色の四角(無地・縞・市松・麻の葉)+ 自作の図案 5 つ(宝石・板チョコ・たい焼き・りんご 2)を水色で'),
    206: ('d206', 'ケーキ: 円柱のスポンジ(乱れの粒)+ 垂れるクリーム + いちご 3 つ'),
    207: ('tray', '盆: 4 つの角から壁・底の多角形、波形のふち、取っ手の穴、暗い線'),
    208: ('tray', '盆の手前の壁 2 枚だけ'),
    73: ('d73', '記念マーク風: 丸い棒の 1・しずく形の宝石の 0・Noto Black を丸めた th と弧に沿う ANNIVERSARY・帯と旗・飾り線と星'),
    76: ('d76', 'JAN-8 の棒の並び(11111111)を規格の符号で + 数字(Noto Regular)'),
    79: ('pretz_banner', '平らな帯(赤い上下の帯 + APJapanesefont を太らせた PRETZ)を上下の辺の曲線に沿って曲げる。灰の地つき'),
    78: ('pretz_banner', '同じ帯の赤い部分だけ'),
}
FUNCS = {84: d84, 303: d303, 306: d306, 307: d307, 293: d293, 320: d320, 83: d83, 376: d376, 313: d313, 106: d106, 370: d370, 296: d296, 314: d314,
         318: d318, 290: d290, 295: d295, 294: d294, 255: d255, 254: d254, 211: d211, 213: d213, 214: d214, 181: d181, 304: d304, 322: d322, 323: d323,
         274: d274, 275: d275, 107: d107, 109: d109, 282: d282, 270: d270, 204: d204, 309: d309, 310: d310, 205: d205, 210: d210, 216: d216, 253: d253,
         87: d87, 92: d92, 172: d172, 206: d206, 207: d207, 208: d208, 73: d73, 76: d76, 79: d79, 78: d78}
STATUS_FILE = R + 'PROC_B/status.json'   # {番号: [状態, メモ]}(自分の目で見て決めた値)


def main():
    only = None
    if '--only' in sys.argv:
        only = [int(x) for x in sys.argv[sys.argv.index('--only') + 1].split(',')]
    ids = only or list(FUNCS)
    os.makedirs(OUT, exist_ok=True)
    if '--put' in sys.argv:
        sys.path.insert(0, HERE)
        import rebuild_lib as RL
        st = json.load(open(STATUS_FILE, encoding='utf-8'))
        for i in ids:
            x = ASSIGN[i]
            p = OUT + f'{i}.png'
            im = Image.open(p)
            assert im.size == (x['w'], x['h']), (i, im.size)
            a = RL.upload(p, f'rebuild_procB_{i:03d}.png')
            s, note = st.get(str(i), ['仮', ''])
            RL.put('PROC_B', x['key'], a['id'], x['w'], x['h'], 'proc', f'rebuild_proc_b.py:{HOW[i][0]}(PIL: {HOW[i][1]})', s, note)
            print('put', i, a['id'], s)
        return
    for i in ids:
        x = ASSIGN[i]
        im = FUNCS[i]()
        g = G(i)
        if not g['alpha'] and im.mode == 'RGBA':
            im = im.convert('RGB')
        assert im.size == (x['w'], x['h']), (i, im.size, x['w'], x['h'])
        im.save(OUT + f'{i}.png')
        bb = im.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox() if im.mode == 'RGBA' else (0, 0) + im.size
        print(i, im.mode, im.size, 'bbox', bb, 'geom', g['bbox'], flush=True)


if __name__ == '__main__':
    main()
