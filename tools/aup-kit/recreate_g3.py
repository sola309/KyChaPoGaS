#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""作り直し G3: S30「3Dモデル羅列」・S32「車両内」の連番(屋上の舞台・廊下・槍・時計・放射光など)と、無い静止画の仮の板。

- 3D は mesh レイヤー(箱・板・複製)+ camera。模様の絵(金網・空・人の影絵)は PIL で手続きで描いて data URL で貼る。
- 人物の 3D モデル・SD 絵は元絵が要るので、同じ位置・大きさの影絵の板(仮)。
"""
import base64
import io
import math
import os

from recreate_lib import *   # noqa: F401,F403

CX, CY = 960, 540


# ---------------------------------------------------------------- 手続きの絵(data URL)

_TEX = {}


def _url(im):
    b = io.BytesIO()
    im.save(b, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(b.getvalue()).decode()


def tex(name):
    """名前で引く小さな絵。PIL が無ければ None(色だけで描く)。"""
    if name in _TEX:
        return _TEX[name]
    try:
        from PIL import Image, ImageDraw, ImageFilter
    except Exception:
        _TEX[name] = None
        return None
    if name == 'net':        # 金網(ひし形の針金)。透明の地
        im = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        for o in (-64, 0, 64):
            d.line((o, 0, o + 64, 64), fill=(70, 86, 80, 255), width=3)
            d.line((o + 64, 0, o, 64), fill=(70, 86, 80, 255), width=3)
    elif name == 'sky':      # 空(POLISH 11/16: 白一色に見えたので描き直し): 上が青、地平線へ白っぽい暖色。横に流れる雲の層
        import random
        im = Image.new('RGBA', (512, 512))
        d = ImageDraw.Draw(im)
        # 画面に映るのは地平線の近く(絵の下 1/4)だけなので、色の移りと雲はそこに寄せる
        stops = [(0.0, (96, 150, 218)), (0.70, (120, 172, 228)), (0.86, (176, 212, 240)), (0.95, (232, 240, 246)), (1.0, (255, 238, 208))]
        for y in range(512):
            t = y / 511
            for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
                if t0 <= t <= t1:
                    u = (t - t0) / (t1 - t0)
                    d.line((0, y, 512, y), fill=tuple(int(c0[i] + (c1[i] - c0[i]) * u) for i in range(3)) + (255,))
        r = random.Random(11)
        cl = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
        dc = ImageDraw.Draw(cl)
        for i in range(16):      # 白い雲のかたまり(小さな丸を横に並べる)。灰色のすじは使わない(曇り空に見えたので)
            cx, cy = r.randint(0, 511), r.randint(372, 478)
            for j in range(r.randint(4, 8)):
                w, h = r.randint(14, 34), r.randint(3, 7)
                x, y = cx + r.randint(-36, 36), cy + r.randint(-3, 3)
                for dx in (0, -512, 512):
                    dc.ellipse((x + dx, y, x + dx + w, y + h), fill=(255, 255, 252, r.randint(150, 235)))
        im.alpha_composite(cl.filter(ImageFilter.GaussianBlur(1.6)))
    elif name == 'figure':   # 立っている人の影絵(頭・ポニーテール・胴・脚)。白で描いて色はマテリアルで付ける
        im = Image.new('RGBA', (128, 320), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.ellipse((38, 6, 90, 60), fill=(255, 255, 255, 255))
        d.polygon([(84, 14), (112, 40), (104, 150), (88, 60)], fill=(255, 255, 255, 255))
        d.polygon([(44, 58), (84, 58), (96, 170), (32, 170)], fill=(255, 255, 255, 255))
        d.polygon([(18, 70), (44, 62), (40, 150), (26, 150)], fill=(255, 255, 255, 255))
        d.polygon([(84, 62), (110, 70), (102, 150), (88, 150)], fill=(255, 255, 255, 255))
        d.rectangle((40, 168, 60, 316), fill=(255, 255, 255, 255))
        d.rectangle((68, 168, 88, 316), fill=(255, 255, 255, 255))
    elif name.startswith('chibi'):    # SD 絵の影絵(大きな頭 + 小さな体)。'chibi#rrggbb' = 色つき
        c = tuple(int(name[6 + i:8 + i], 16) for i in (0, 2, 4)) + (255,) if '#' in name else (255, 255, 255, 255)
        im = Image.new('RGBA', (200, 260), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.ellipse((20, 8, 180, 160), fill=c)
        d.polygon([(150, 30), (198, 90), (176, 200), (150, 110)], fill=c)
        d.polygon([(66, 150), (134, 150), (150, 232), (50, 232)], fill=c)
        d.rectangle((66, 228, 92, 256), fill=c)
        d.rectangle((108, 228, 134, 256), fill=c)
    elif name == 'floor':    # コンクリートの床(POLISH 11/16: 白飛びして見えたので暗め + 目地 + しみ)
        import random
        r = random.Random(3)
        im = Image.new('RGBA', (256, 256))
        px = im.load()
        for y in range(256):
            for x in range(256):
                v = 150 + r.randint(-12, 12)
                px[x, y] = (v, v - 5, v - 16, 255)
        im = im.filter(ImageFilter.GaussianBlur(0.8))
        st = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
        ds = ImageDraw.Draw(st)
        for i in range(14):
            x, y, w = r.randint(-30, 240), r.randint(-30, 240), r.randint(30, 90)
            ds.ellipse((x, y, x + w, y + w * r.uniform(0.4, 0.9)), fill=(96, 88, 76, r.randint(18, 46)) if i % 3 else (236, 230, 214, 40))
        im.alpha_composite(st.filter(ImageFilter.GaussianBlur(7)))
        d = ImageDraw.Draw(im)
        for k in (0, 128):       # 目地(2 × 2 枚)
            d.line((k, 0, k, 256), fill=(112, 106, 96, 255), width=2)
            d.line((0, k, 256, k), fill=(112, 106, 96, 255), width=2)
    elif name == 'bld':      # 街の建物の壁(窓の列)。白で描いて色はマテリアルで付ける
        im = Image.new('RGBA', (64, 64), (232, 232, 228, 255))
        d = ImageDraw.Draw(im)
        for yy in range(6, 64, 16):
            for xx in range(5, 64, 16):
                d.rectangle((xx, yy, xx + 8, yy + 8), fill=(120, 132, 150, 255))
    elif name == 'blob':     # 足もとの影(まるくぼけた黒)
        im = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.ellipse((8, 8, 56, 56), fill=(24, 20, 18, 235))      # POLISH2 11/16: 濃く(前は 150 でほぼ見えなかった)
        im = im.filter(ImageFilter.GaussianBlur(5))
    else:
        raise KeyError(name)
    _TEX[name] = _url(im)
    return _TEX[name]


def mat(color, tname=None, repeat=None, **kw):
    m = {'color': color, 'roughness': 1}
    u = tex(tname) if tname else None
    if u:
        m['texture'] = {'url': u}
        if repeat:
            m['texture_repeat'] = list(repeat)
    m.update(kw)
    return m


def box(size, pos, color, rot=None, **kw):
    o = {'geometry': 'box', 'size': list(size), 'position': list(pos), 'material': kw.pop('material', None) or mat(color)}
    if rot:
        o['rotation'] = list(rot)
    o.update(kw)
    return o


def plane(size, pos, color, rot=None, tname=None, repeat=None, **mk):
    o = {'geometry': 'plane', 'size': list(size), 'position': list(pos), 'material': mat(color, tname, repeat, side='double', **mk)}
    if rot:
        o['rotation'] = list(rot)
    return o


def cam(n, zoom, keys, tkeys):
    """keys / tkeys: [(f, (x, y, z), ease?)](mesh レイヤーの原点 = 画面のまん中 からの座標)"""
    def K(ks):
        return kf(*[(k[0], [CX + k[1][0], CY + k[1][1], k[1][2]]) + tuple(k[2:]) for k in ks])
    return layer('cam', 'camera', n, {'zoom': zoom, 'target': K(tkeys)}, transform={'position': K(keys)})


def mesh(id, n, objects, light=None, unlit=False):
    src = {'objects': objects, 'light': light or {'direction': [-0.4, -1, -0.5], 'intensity': 1.6, 'ambient': 1.1}}
    if unlit:
        src['unlit'] = True
    return layer(id, 'mesh', n, src, pos=[CX, CY, 0])


def figure(pos, color, h=165, name='figure', rot=None):
    """人物の仮の板(影絵)。足もとが pos。"""
    w = h * (128 / 320 if name == 'figure' else 200 / 260)
    o = {'geometry': 'plane', 'size': [w, h], 'position': [pos[0], pos[1] - h / 2, pos[2]],
         'material': mat(color, name, side='double', type='basic', transparent=True)}
    if not tex(name):
        o['material']['opacity'] = 0.8
    if rot:
        o['rotation'] = list(rot)
    return o


# ================================================================ B14 屋上の 3D の舞台(S30 3389-3633)
# 座標(mesh の原点 = 屋上の床のまん中。y 下・z 奥。1 = 約 1cm):
#   床 y=0(x ±1600, z ±1500)/ 金網 z=+1500(高さ 300)/ その先は 25m 下に街 / 手前 z=-1500 から一段高い台(床 y=-60、細い柵、ベンチ)
# 連番の分け方(S30 の使い方から): 背景 = 空 / 街 = 街と地面 / 足場 1〜3 = 金網ごしの棟と木組み / フェンス = 金網 / 高台足場 = 屋上の床 / 1.08 = 全部 + 人物(3458 から上にかぶる)

# FEEL2: 完成版 3520〜3552 の 1 コマごとの動きの速さ(feel-kit の実測。数だけ)。添字 0 = comp の 130 → 131 コマの動き
ROOF_ORBIT_SPEED = [9, 9, 10, 11, 10, 13, 12, 12, 13, 13, 14, 16, 17, 20, 24, 23, 29, 31, 30, 40, 37, 43, 52, 56, 61, 71, 79, 92, 117, 135, 211, 201, 299]
ROOF_ORBIT_POW = 0.7       # v15: 回りこみの配分(1 = 手本の速さの累積そのまま。小さいほど前半へ配る)
ROOF_PHI_END = 128.0      # v14: 回りこみの終わりの向き(度)
ROOF_ORBIT_END = ((700, -330, 1080), (150, -40, 1550))      # 回りこみの終わりの カメラの位置・注視点


def _orbit(a, b, f0=130):
    """f0 から 1 コマごとのキー。進み具合 = ROOF_ORBIT_SPEED の累積の割合(終わりへ向けて加速しつづける)"""
    tot = float(sum(ROOF_ORBIT_SPEED))
    out, acc = [(f0, tuple(a))], 0.0
    for i, v in enumerate(ROOF_ORBIT_SPEED):
        acc += v
        if i % 2 == 1 or i >= len(ROOF_ORBIT_SPEED) - 9:      # 終わりの 9 コマは 1 コマごと(速さが急に上がる所)
            u = acc / tot
            out.append((f0 + i + 1, tuple(round(x + (y - x) * u, 2) for x, y in zip(a, b))))
    return out[:-1]      # 終わり(163)は hold のキーで置く


def _pull(a, b, f0=114, f1=130, r=1.6):
    """v6: 引き(3503〜3519)の途中のキー。人物までの距離が 245 → 391(r = 1.6 倍)に伸びるので、まっすぐ等速で下がると画面の動きは頭が速く終わりが遅い山になる
    (区間描きで 6・17・22・20・18・16・13・7・4。完成版は 12・11・11・10・10・10・9・9・9 でほぼ一定)。距離が等比で伸びるように進ませて、画面の動きを一定にする"""
    out = []
    for f in range(f0 + 2, f1, 2):
        t = (f - f0) / (f1 - f0)
        u = (r ** t - 1) / (r - 1)
        out.append((f, tuple(round(x + (y - x) * u, 2) for x, y in zip(a, b))))
    return out


# ---- v7(VRMSAK): 前半のカメラ。人物(後ろ姿の VRM)の立つ所 ROOF_P を中心に、完成版のコマを 100px の目盛りで目で測った数から作る ----
# 止め(3414〜3503。完成版 3500): 金網の上端 y=294・下端 818、人物の髪の頭頂 185・短パンのすそ 735 → カメラの高さ 151・金網まで 393.5・見下ろし 9.75°、人物は髪の頭頂 165・カメラから 198
# 引きの終わり(3519): 金網 293〜696、人物 240〜882 → 高さ 153・見下ろし 10°・人物まで 330
# 回りこみ(3520〜3552): 人物の画面位置(x・頭頂・足もと)と見える向きから、コマごとの (向き φ・距離 r・高さ・見下ろし θ・人物を画面の左へ外す角 δ)。
#   完成版は人物の右側へ 150° ほど回りながら上がって離れ、人物は画面の左へ流れる(v6 までは 60° ほどで、動きの量が手本の半分だった)
ROOF_P = (9.0, 1312.0)      # 後ろ姿の人物の足もと(x, z)。金網(z=1500)の 188 手前
ROOF_ORBIT_KEYS = [  # (コマ, φ, r, 高さ, θ, δ)
    (130, 0, 340, 153, 10.0, 0.4), (140, 15, 371, 172, 12.5, 5.3), (150, 35, 394, 203, 15.6, 12.8), (156, 52, 417, 233, 19.0, 19.2),
    (159, 65, 459, 267, 23.0, 23.2), (161, 75, 507, 292, 26.0, 25.3), (162, 90, 544, 307, 28.5, 23.0), (163, 105, 577, 320, 30.0, 22.0)]
# 人物は回りこみの終わりにカメラのほうへ振り向きはじめる(完成版 3549 で真横・3552 で斜め前が見える。カメラの回りより 25〜45° 多い)
ROOF_TURN = [(150, 0), (156, 8), (159, 25), (161, 30), (162, 40), (163, 45)]


def _pchip(xs, ys, x):
    """単調な 3 次補間(行き過ぎない)。"""
    n = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    m = [d[0]] + [0.0 if d[i - 1] * d[i] <= 0 else 3 * (h[i - 1] + h[i]) / ((2 * h[i] + h[i - 1]) / d[i - 1] + (h[i] + 2 * h[i - 1]) / d[i]) for i in range(1, n - 1)] + [d[-1]]
    i = max(0, min(n - 2, max(j for j in range(n) if xs[j] <= x) if x >= xs[0] else 0))
    t = (x - xs[i]) / h[i]
    return ((2 * t ** 3 - 3 * t ** 2 + 1) * ys[i] + (t ** 3 - 2 * t ** 2 + t) * h[i] * m[i] + (-2 * t ** 3 + 3 * t ** 2) * ys[i + 1] + (t ** 3 - t ** 2) * h[i] * m[i + 1])


def _orbit_cam(phi, r, hc, th, dl, L=600.0):
    """人物のまわりの (φ, r, 高さ, θ, δ) → カメラの位置・注視点(mesh の座標。y は下が正)"""
    ph, t, dd = math.radians(phi), math.radians(th), math.radians(dl)
    cx, cz = ROOF_P[0] + r * math.sin(ph), ROOF_P[1] - r * math.cos(ph)
    dx, dz = -math.sin(ph), math.cos(ph)                                              # カメラ → 人物
    vx, vz = dx * math.cos(dd) + dz * math.sin(dd), -dx * math.sin(dd) + dz * math.cos(dd)      # 右へ δ 振る(人物は画面の左へ)
    return (round(cx, 2), round(-hc, 2), round(cz, 2)), (round(cx + L * vx * math.cos(t), 2), round(-hc + L * math.sin(t), 2), round(cz + L * vz * math.cos(t), 2))


def _roof_front_cam():
    hold = ((0, -151, 1106.5), (0, -83.4, 1500))
    P0, T0 = _orbit_cam(*ROOF_ORBIT_KEYS[0][1:])
    pos = [(0, (0, hold[0][1] - 490, hold[0][2]), 'outCubic'), (8, hold[0]), (114, hold[0])] + _pull(hold[0], P0, r=1.3)
    tgt = [(0, (0, hold[1][1] - 490, hold[1][2]), 'outCubic'), (8, hold[1]), (114, hold[1])] + _pull(hold[1], T0, r=1.3)
    xs = [k[0] for k in ROOF_ORBIT_KEYS]
    # v13(POLISH5): 向き φ だけ終わりの 7 コマを 1 コマごとに(v12 は 159→161 が 1 コマ 5°、161→163 が 15° と段になり、3550 で動きの量が一度落ちていた)。
    #   156(52°)〜163(105°)のあいだを、手本の 1 コマごとの速さ(ROOF_ORBIT_SPEED の終わり 7 個 = 79・92・117・135・211・201・299)の割合で分けた
    px = [130, 140, 150, 156, 157, 158, 159, 160, 161, 162, 163]
    py = [0, 15, 35, 52, 55.7, 60.0, 65.5, 71.8, 81.6, 91.0, 105]
    # v14(POLISH6): 回りこみの量が手本の半分(3540〜3552 の動きの量 380→3000 に対し 240→1330)。原因 = 向き φ も距離・高さも「コマに対してほぼ一定の速さ」で進み、
    #   終わりの数コマに動きが集まっていなかった(手本は 33 コマのうち終わりの 4 コマで全体の 47% を動く)。
    #   → 向き φ を「手本の 1 コマごとの速さ(ROOF_ORBIT_SPEED)の累積の割合」で 130〜163 の全部に配り直し、距離・高さ・見下ろし・外し角は φ の関数(測ったキーの組は同じ)にした。
    #   道(通る点の並び)は v13 と同じで、進み方だけ終わりへ寄せた。終わりの向きは ROOF_PHI_END(測った 105° より少し先まで回す)
    # v15(POLISH7): v14 の配り方(速さの累積そのまま)は前半が手本より遅かった(3521〜3539 の動きの量 56〜203 に対し手本 92〜404。終わりの 1 コマは 15°以上回って
    #   動きの道具も目も追えない)。回る量(ROOF_PHI_END)は同じまま、重みを 速さ^0.7 に(前半の 19 コマの取り分 17.5% → 27.5%・最後の 1 コマ 21° → 14°)
    wts = [v ** ROOF_ORBIT_POW for v in ROOF_ORBIT_SPEED]
    tot = float(sum(wts))
    phis = [k[1] for k in ROOF_ORBIT_KEYS]
    acc = 0.0
    for f in range(130, 164):
        if f > 130:
            acc += wts[f - 131]
        phi = ROOF_PHI_END * acc / tot
        pq = min(phi, phis[-1])
        prm = [phi] + [_pchip(phis, [k[j] for k in ROOF_ORBIT_KEYS], pq) for j in range(2, 6)]
        if phi > phis[-1]:      # 測った終わりより先: 終わりの 2 つのキーの傾きのまま伸ばす
            for j in range(2, 6):
                prm[j - 1] += (ROOF_ORBIT_KEYS[-1][j] - ROOF_ORBIT_KEYS[-2][j]) / (phis[-1] - phis[-2]) * (phi - phis[-1])
        P, T = _orbit_cam(*prm)
        pos.append((f, P)); tgt.append((f, T))
    return {'pos': pos, 'tgt': tgt}


_RF = _roof_front_cam()


def _settle_drift(p0, p1, p2, f0=164, f1=204, f2=245):
    """f0 で p0 → f1 で p1 → f2 で p2。p1→p2 の等速の流れを f0 までさかのぼらせ、その線からのずれを 2^(-10t) で減らす(1 コマごとのキー)。"""
    out = []
    for f in range(f0, f1 + 1):
        t = (f - f0) / (f1 - f0)
        d = 0.0 if f == f1 else 2 ** (-10 * t)
        line = [b + (c - b) * (f - f1) / (f2 - f1) for b, c in zip(p1, p2)]
        l0 = [b + (c - b) * (f0 - f1) / (f2 - f1) for b, c in zip(p1, p2)]
        out.append((f, tuple(round(l + (a - z) * d, 2) for l, a, z in zip(line, p0, l0))))
    return out + [(f2, tuple(p2))]

ROOF_CAM = dict(
    zoom=kf((0, 1400), (163, 1400, 'hold'), (164, 2600), (245, 2600)),      # v6: 後半は望遠
    # v4: 前半(〜164)を完成版 3440〜3550 から測り直した。3414〜3503 は止まったまま(人物は斜めのワイプで現れる)→ 3503 から引き、3543〜3550 で右へ回りこむ。
    #     カメラの高さ ≈ 金網の上端(地平線と金網の上端が重なる)。人物(165)は金網の 180 手前
    # v5(feel-kit で完成版を 1 コマずつ測った): 頭のせり上がりは 8 コマで止まる(3390〜3397)。3504 から引き(減速)、右への回りこみは 3519 から切り替わり(3553)へ向けて
    #     加速しつづける 1 本の動き(inCubic。v4 は直線 3 本のつぎはぎ)。切り替わりの直後(3554〜3563)は速い横移動が 10 コマで減速して止まり(= 前のカットの勢いを引き継ぐ)、
    #     そのあとは 1 コマ 2〜3px のゆっくりした横移動だけ。
    # FEEL2(完成版を測り直した): 引き(3504〜3519)は減速せず同じ速さのまま回りこみへつながる。回りこみ(3519〜3552)の速さは 9 → 299 px/コマ まで上がりつづけ
    #     (v5 は終わりの 7 コマが 60 で頭打ち・量は手本の約 1/3)、切り替わりは 3553(v5 は 2 コマ遅い 3555)。切り替わりのあと(3553〜3590)は速い横移動が 10 コマで収まり、
    #     そのあと 1 コマ 1.0%→0.1% のゆるい寄りが 3590 まで減速しながら続く(v5 は 3566 で止まっていた)。
    #     回りこみの進み方 = 完成版の 1 コマごとの速さ(ROOF_ORBIT_SPEED)を足し上げた割合。回りこむ量は x 450 → ROOF_ORBIT_END(空の板の外が映らないよう、空の左右に壁を足した)
    # v7(VRMSAK): 前半(〜163)を、人物(VRM)の頭頂・すそ・足もとと金網の上下の画面位置から合わせ直した(_roof_front_cam)。v6 までの値は R/VRMSAK/recreate_g3.before_vrmsak.py
    pos=(_RF['pos'][:-1] + [(163, _RF['pos'][-1][1], 'hold')] + _settle_drift((-314, -405.5, -2720), (-284, -380, -2615), (-364, -380, -2593))),
    tgt=(_RF['tgt'][:-1] + [(163, _RF['tgt'][-1][1], 'hold')] + _settle_drift((452, -175, -1670), (26, -124, -1550), (-54, -124, -1528))),
    # v14(POLISH6): 切り替わりの直後の振り幅を 1.5 倍に(手本は 3553 で切らずにカメラを振りぬいていて、3554〜3556 の動きの量が 1220〜1390。v13 は 850)。止まる先は同じ
    # v13(POLISH5): 切り替わりのあと。v12 は outExpo(164〜204)のあとに別のゆっくりした流れ(204〜245)をつないでいて、outExpo の尾(3582〜3594)で動きの量が 0.5 まで落ちて
    #     ほぼ静止していた(手本は 47 前後で動きつづける)。_settle_drift = 「204〜245 の流れを 164 までさかのぼらせた直線」+「残りを指数で減らす」を 1 コマごとに焼いた 1 本(止まらずに流れへつながる)。流れの量も 2.5 倍に(204→245 で横へ 80。v12 は 32 で、動きの量が手本の 1/4)
    # v12(POLISH4): 切り替わりのあとの横移動。v11 は outQuad 10 コマ → outCubic 30 コマの 2 本つなぎで、174 で一度止まってから動き直し、3566 にはほぼ静止していた
    #     (動きの量 85→0。完成版は 140 から 3580 まで減りつづける)。振り幅を 1.5 倍にして outExpo 1 本(40 コマ)に = 頭のコマが最速で、長い余韻
    # v6: 後半(164〜)のカメラを測り直した。完成版 3585 の 7 体の頭頂・足もと・柵の下の線・柱の上下を 100px の目盛りで目で測り、さらに柵の柱の傾き(左 −4.2°〜右 +3.3°)から望遠だと分かり、zoom 2600(前半は 1400 のまま)・高さ 380・見下ろし 13°・柵に対して 16° 斜め、と出した
    #     (R/V6/fitcam2.py・roofcam.json。柱の高さが左 201・右 197 でそろうので向きは合っている)。前は高さ 420・見下ろし 34°で、柵とベンチが 3 倍ほど大きく映っていた。
    #     FEEL2 の動き(切り替わりの直後の速い横移動 10 コマ → ゆるい寄り)は、キーの時刻と差分をそのまま新しい土台に移した
)

# 3D モデルの杏子たち(仮: マネキン = mesh の mannequin)。足もとの位置は、完成版 3580 の足の画面位置を ROOF_CAM から床へ逆算した値。
# 服の色・ポーズは完成版を見て決めた(本人の右 = こちら向きのとき画面の左)。
_KSKIN, _KHAIR = '#f7dccd', '#a8324e'
_HIP_R = {'shoulder_r': [-22, 62, 46], 'elbow_r': 98, 'hand_r': 'fist'}


def kyoko(pos, colors, outfit, pose=None, preset='stand', rot=0, h=220, phase=None, n=245, seed=0, **kw):
    """人物の仮置き(マネキン)。足もとが pos。こちら(カメラ側 = z 負)を向く。小さく体がゆれる。"""
    per = 70 + seed * 7
    sw = lambda amp, ph=0.0, base=0.0: {'k': [dict(f=f, v=round(base + amp * math.sin(2 * math.pi * (f / per + ph + seed * 0.13)), 3)) for f in range(0, n + 10, 10)]}  # noqa: E731
    ps = {'root': [0, 0, sw(1.2)], 'chest': [sw(1.2, 0.25, 1), 0, sw(-1.0)], 'head': [0, sw(4, 0.1), sw(2, 0.3)], 'pony_1': [sw(3, 0.4, 3), sw(5, 0.5), 0], 'pony_2': [0, sw(6, 0.65), 0], 'pony_3': [0, sw(7, 0.8), 0]}
    ps.update(pose or {})
    o = {'geometry': 'mannequin', 'position': list(pos), 'rotation': [0, rot, 0], 'body': {'height': h, 'heads': 5.6, 'thickness': 0.95, 'shoulder': 0.95},
         'colors': {'skin': _KSKIN, 'hair': _KHAIR, 'ribbon': '#1c1a1e', 'eyes': '#8a2030', **colors}, 'hair': {'style': 'ponytail', 'length': 0.5, 'thickness': 1.05}, 'outfit': outfit,
         'face': False, 'outline': {'width': h / 330, 'color': '#4a2a34'}, 'material': {'type': 'toon', 'toon_steps': 3}, 'self_light': 0.35, 'preset': preset, 'pose': ps}
    if phase is not None:
        o['phase'] = phase
    o.update(kw)
    return o


# ---- v3: 2D の立ち絵 + パーツ分解(puppet)を、3D の舞台の中に板で立てる ----
# パペット 1 体 = 透明の comp 1 個(aux:P2D_<puppet_id>)→ mesh の板のテクスチャ(comp_id)に貼る(舞台の奥行きの中に立つ = 柵の前後が正しく出る)。
_P2D_SEEN = {}
# 屋上に並ぶ子のポーズ(関節。完成版 3580: G = 右手でピース・C = 両手を広げる・A = 右手を腰・E = こぶしを胸・D = 左手を振る。F・H は立ち姿のまま = H の駆けるポーズは 2D では出せない)
ROOF_POSE = {'G': {'pose': {'shoulder_r': 44, 'elbow_r': [96, 0.95], 'shoulder_l': 20}}, 'C': {'pose': {'shoulder_l': 55, 'shoulder_r': 55}}, 'A': {'pose_preset': 'hand_on_hip', 'pose_amount': 1, 'pose': {'shoulder_l': 14}},
             'E': {'pose': {'shoulder_r': 32, 'elbow_r': [-158, 0.85], 'shoulder_l': 22}}, 'D': {'pose': {'shoulder_l': 122, 'elbow_l': psway(245, 16, 44, 0, 30), 'shoulder_r': 26}}, 'F': {'pose': {'shoulder_l': 16, 'shoulder_r': 16}}}


def _p2d_comp(g, n=245):
    """パペットを 1 体だけ置いた透明の comp を登録する(同じパペットは 1 個)。→ 登録のキー"""
    key = 'aux:P2D_' + g['puppet_id']      # 台帳の ID は B13p(recreate.py は ID の順に作るので、B14 より前に来る名前にしてある)
    if key not in _P2D_SEEN:
        _P2D_SEEN[key] = g
        cw, ch = g['canvas']

        @reg(key, 'B13p', f'仮: puppet レイヤー {g["puppet_id"]} を 1 体置いた透明の comp(屋上の板に貼る。新しく生成した立ち絵・ユーザー未確認)', placeholder=True)
        def _f(ctx, g=g, cw=cw, ch=ch):
            src = dict(ROOF_POSE.get(str(g.get('key')), {})) if use_bones(g['puppet_id']) else {}      # 関節のあるパペットは完成版のポーズに寄せる
            L = [puppet_layer('p', n, g, [g['head'][0], g['head'][1]], g['head_h'], seed=len(g["puppet_id"]) % 7, turn=0.06, wind=0.25, source=src)]
            return doc('仮: 2D 立ち絵 + 分解 ' + g['puppet_id'], n, L, w=cw, h=ch)
    return key


def board(ctx, g, pos, h, yaw=0):
    """パペットの comp を貼った板。人物の箱の高さを h(舞台の単位)に、足もとを pos に合わせる。yaw = 板の向き(度。カメラのほうへ向ける)。"""
    cw, ch = g['canvas']
    x0, y0, x1, y1 = g['box']
    k = h / (y1 - y0)
    return {'geometry': 'plane', 'size': [cw * k, ch * k], 'position': [pos[0] + (cw / 2 - g['head'][0]) * k, pos[1] - (y1 - ch / 2) * k, pos[2]], 'rotation': [0, yaw, 0],
            'material': {'type': 'basic', 'color': '#ffffff', 'side': 'double', 'transparent': True, 'alpha_test': 0.02, 'texture': {'comp_id': ctx.comp(_p2d_comp(g)), 'transparent': True}}}


# 屋上の人物の衣装の記号(KEY/OUTFITS.md)と向き。パペットがあれば板、無ければマネキン
B_SIT_KEY = 'v11:roof/B_bench_sit.png'      # POLISH3 11/16: 腰かけた姿の絵(replace_POLISH3.json)。前は 'v4:roof/B_sit.png'(床座りの絵 11128)
ROOF_SYMS = [('A', 'back'), ('G', None), ('C', None), ('F', None), ('A', None), ('E', None), ('H', None), ('D', None), ('B', 'sit')]
ROOF_PUPPETS = [None if v == 'sit' else find_puppet(s, v) for s, v in ROOF_SYMS]     # 登録の時点で引く(how に書くため)
for _g in ROOF_PUPPETS:
    if _g:
        _p2d_comp(_g)


def roof_people_how():
    names = ['1 人目(後ろ姿 A)', 'G', 'C', 'F', 'A', 'E', 'H', 'D', '座る B']
    pu = [nm for nm, g in zip(names, ROOF_PUPPETS) if g]
    mq = [nm for nm, g in zip(names, ROOF_PUPPETS) if not g and nm != '座る B']
    vr = os.environ.get('AUP_VRM', '1') != '0' and PEOPLE != 'mannequin'
    if vr:      # v7: 私服パーカーの 2 体は VRM
        pu = [x for x in pu if x not in ('1 人目(後ろ姿 A)', 'A')]
        mq = [x for x in mq if x not in ('1 人目(後ろ姿 A)', 'A')]
    return (('。私服パーカーの 2 体(1 人目の後ろ姿・並びの A)= ユーザー提供の 3D モデル(VRM。ユーザー本人の作)を model レイヤーで。AUP_VRM=0 で前の立ち絵に戻る' if vr else '')
            + '。人物は仮: ' + (f'2D 立ち絵 + 分解の板(puppet)= {"・".join(pu)}' if pu else '') + ('、' if pu and mq else '') + (f'マネキン = {"・".join(mq)}' if mq else '')
            + '、座る B = 新しく生成した座り姿の絵の板(v4:roof/B_sit.png)(puppet・絵は板なので、回りこみは出せない)')


def _cam_yaw(x, z):
    """板をカメラのほうへ向ける角度のキー(ROOF_CAM の位置のキーの時刻ごと)。"""
    ks = []
    for k in ROOF_CAM['pos']:
        f, (cx, cy, cz) = k[0], k[1]
        ks.append((f, round(math.degrees(math.atan2(cx - x, -(cz - z))), 2)) + tuple(k[2:]))
    return kf(*ks)


# v6: 並ぶ 7 体の足もと(完成版 3585 の足の画面位置を、測り直したカメラから床へ逆算。R/V6/roofcam.json)と、座る B の板(ベンチの上・高さ 128)
ROOF_FEET_V6 = {1: (-299, -1022), 2: (-71, -724), 3: (-22, -1437), 4: (189, -1082), 5: (478, -573), 6: (597, -919), 7: (454, -1457)}
ROOF_BSIT_V6 = dict(pos=(6, 0, -1726), h=164, seat=(40, -54, -1680))      # v12(POLISH4): ベンチごと 170 奥へ(画面の下端で脚が切れていた → 足もとまで画面に入る)。前は pos=(6, 0, -1896), seat=(40, -54, -1850)
_V11_ROOF_BSIT_V6 = dict(pos=(6, 0, -1896), h=164, seat=(40, -54, -1850))      # POLISH3 11/16: 腰かけた姿の新しい絵(足は床・腰はベンチの板)。板の手前のふち(z=-1892)のすぐ前に立てる。前(POLISH2)は pos=(40, -54, -1850), h=138 = 床座りの絵を板の上に乗せていた
_OLD_ROOF_BSIT_V6 = dict(pos=(40, -54, -1850), h=138)      # POLISH2: (-30, -83, -2004) から奥へ(ベンチの脚まで画面に入るように)
ROOF_SHADOW_OFS = (14, 6)      # POLISH2: 並ぶ 7 体の足もとの影のずらし(x, z)
ROOF_BENCH = ((40, -1680, 230), (345, -1610, 190))      # POLISH2 11/16: ベンチ = 横長(x にのびる)の板 2 台(x, z, 幅)。1 台目に座る B を乗せる(前は奥へのびる細い板で、B は板の左の空中に居た)


def roof_figures(n, ctx=None):
    F = _roof_mannequins(n)
    for i, (x, z) in ROOF_FEET_V6.items():
        F[i]['position'] = [x, 0, z]
    if ctx is None:
        return F
    for i, g in enumerate(ROOF_PUPPETS):
        if not g:
            continue
        m = F[i]
        px, py, pz = m['position']
        F[i] = board(ctx, g, (px, py, pz), m['body']['height'], yaw=_cam_yaw(px, pz) if i == 0 else 0)
        if i == 0:      # v6: 1 人目(後ろ姿)は後半のカットには居ない(完成版 3553〜)。後半は床の下へ
            y0 = F[i]['position'][1]
            F[i]['position'][1] = kf((0, y0), (163, y0, 'hold'), (164, y0 + 3000), (245, y0 + 3000))
    a = ctx.asset(B_SIT_KEY)
    if a and PEOPLE != 'mannequin':      # v4: 座る B = 新しく生成した座り姿の絵(槍つき。仮・ユーザー未確認)の板。高さ 200・下端はベンチの下の床
        h = ROOF_BSIT_V6['h']
        w = h * a['w'] / a['h']
        px, py, pz = ROOF_BSIT_V6['pos']
        F[8] = {'geometry': 'plane', 'size': [w, h], 'position': [px, py + 2.5 - h / 2, pz], 'B_sit': True,      # POLISH2: 絵の接地の線(下から 3.5%)をベンチの板の上面(y=-83)へ
                'material': {'type': 'basic', 'color': '#ffffff', 'side': 'double', 'transparent': True, 'alpha_test': 0.02, 'texture': {'asset_id': a['asset_id']}}}
    return F


def _roof_mannequins(n):
    HOOD = ({'top': '#8fb3a6', 'bottom': '#55698f', 'socks': '#2a2630', 'shoes': '#2a2630'}, {'sleeves': 1, 'pants': 0.1, 'socks': 0.85})
    wave = {'k': [dict(f=f, v=round(48 + 14 * math.sin(2 * math.pi * f / 44), 2)) for f in range(0, n + 8, 8)]}
    F = [
        # 1 人目: 金網の前で街を見ている後ろ姿(緑のパーカー・右手を腰)。完成版 3475〜3550
        kyoko((15, 0, 1320), *HOOD, pose={**_HIP_R, 'shoulder_l': [0, 0, 14], 'elbow_l': 10, 'hip_l': [0, 0, 6], 'hip_r': [0, 0, 6]}, rot=180, h=176, n=n, seed=0),
        # 後半の並び(完成版 3565〜3633)。左から: 黒のロングワンピース(右手でピース)/ 白のセーター + スカート(両手を広げる)/ 白のワンピース / 緑のパーカー(手を腰)/ 赤のワンピース(手を胸)/ 黒のシスター服(片足を上げて駆ける)/ 水着(左手を振る)
        kyoko((-715, 0, -1119), {'top': '#2a262c', 'bottom': '#2a262c', 'skirt': '#3a3a34', 'shoes': '#2a2228'}, {'sleeves': 0.3, 'pants': 0.05, 'skirt': 1.75, 'skirt_flare': 0.7},
              pose={'shoulder_r': [12, -80, 48], 'elbow_r': 118, 'hand_r': 'peace', 'shoulder_l': [0, 0, 20]}, rot=-12, n=n, seed=1),
        kyoko((-563, 0, -998), {'top': '#f2ecdc', 'bottom': '#8a8468', 'skirt': '#8a8468', 'shoes': '#b03040'}, {'sleeves': 1, 'pants': 0.05, 'skirt': 0.6, 'skirt_flare': 0.8},
              pose={'shoulder_l': [0, -30, 55], 'shoulder_r': [0, -30, 55], 'elbow_l': 10, 'elbow_r': 10, 'hand_l': 'open', 'hand_r': 'open'}, rot=-6, n=n, seed=2),
        kyoko((-336, 0, -1301), {'top': '#f8f4ea', 'bottom': '#f8f4ea', 'skirt': '#f8f4ea', 'shoes': '#e8e0d8'}, {'sleeves': 0, 'pants': 0.05, 'skirt': 1.35, 'skirt_flare': 0.9},
              pose={'shoulder_l': [0, 0, 24], 'shoulder_r': [0, 0, 24], 'hand_l': 'open', 'hand_r': 'open'}, n=n, seed=3),
        kyoko((-235, 0, -1039), *HOOD, pose={**_HIP_R, 'shoulder_l': [0, 0, 16]}, rot=4, n=n, seed=4),
        kyoko((-136, 0, -832), {'top': '#c0434a', 'bottom': '#c0434a', 'skirt': '#c0434a', 'shoes': '#6a3a3a'}, {'sleeves': 0.2, 'pants': 0.05, 'skirt': 1.3, 'skirt_flare': 0.9},
              pose={'shoulder_r': [38, 25, 14], 'elbow_r': 138, 'hand_r': 'fist', 'shoulder_l': [0, 0, 22]}, rot=6, n=n, seed=5),
        kyoko((83, 0, -930), {'top': '#1d1b22', 'bottom': '#1d1b22', 'skirt': '#1d1b22', 'shoes': '#2a2228'}, {'sleeves': 0.8, 'pants': 0.05, 'skirt': 1.0, 'skirt_flare': 1.0},
              preset='run', phase=0.18, ground=False, pose={}, rot=28, n=n, seed=6),
        kyoko((112, 0, -1253), {'top': '#b12c3d', 'bottom': '#b12c3d', 'skirt': '#e87a5a', 'shoes': _KSKIN}, {'sleeves': 0, 'pants': 0.06, 'skirt': 1.1, 'skirt_flare': 0.6},
              pose={'shoulder_l': [0, -90, 118], 'elbow_l': wave, 'hand_l': 'open', 'shoulder_r': [0, 0, 26]}, rot=8, n=n, seed=7),
        # ベンチに座る魔法少女(槍を持つ)
        kyoko((-167, -52, -1493), {'top': '#a32f48', 'bottom': '#a32f48', 'skirt': '#e68aa8', 'socks': '#3b2233', 'shoes': '#7a2338'}, {'sleeves': 0, 'pants': 0.08, 'skirt': 0.62, 'skirt_flare': 0.9, 'socks': 1.55, 'boots': 0.9},
              preset='sit', pose={'shoulder_l': [50, 0, 20], 'elbow_l': 70, 'hand_l': 'fist'}, rot=-45, h=200, n=n, seed=8),
    ]
    return F


def roof_parts(n, parts, figures=False, ctx=None):
    """parts: bg, city, fence, sc1, sc2, sc3, stand の組"""
    P = set(parts)
    O = []
    if 'bg' in P:
        O.append(plane((260000, 70000), (0, -33500, 60000), '#ffffff', tname='sky', type='basic'))
        for sx in (-1, 1):      # FEEL2: 空の左右の壁(回りこみでカメラが横を向いても、空の板の外の黒が映らないように)
            O.append(plane((140000, 70000), (sx * 130000, -33500, -10000), '#ffffff', rot=(0, 90, 0), tname='sky', type='basic'))
    if 'roof' in P:   # 屋上(= 連番「高台足場」)
        O.append(box((3200, 120, 3000), (0, 60, 0), '#d2c9b4', material=mat('#ffffff', 'floor', (10, 10))))       # 屋上の床
        O.append(box((3200, 2400, 3000), (0, 1320, 0), '#b9b3a6'))                                              # 建物の胴
    if 'city' in P:
        O.append(plane((300000, 300000), (0, 2500, 60000), '#5a4353', rot=(90, 0, 0)))
        for i, (cnt, sz, col, seed) in enumerate(((260, (1500, 380, 1500), '#a9a9a6', 5), (200, (900, 600, 900), '#8f9090', 6), (90, (2600, 300, 1800), '#c9c8c2', 7))):
            O.append({'geometry': 'box', 'size': list(sz), 'position': [0, 2500 - sz[1] / 2, 47000], 'material': mat(col, 'bld', (3, 2)),
                      'instances': {'count': cnt, 'seed': seed, 'layout': 'box', 'area': [130000, 0, 54000], 'scale': [0.5, 1.4]}})
    # v4: 金網ごしの棟は屋上より 3m 低い細長い屋根が奥へのびる形(完成版 3465 の白い台形)。前は 20m 下にあって画面の外だった
    if 'sc1' in P:
        # POLISH2 11/16: 白一色の箱 → コンクリートの質感(回りこみの終わり 3549〜3552 で画面の半分を占めるので)
        O.append(box((200, 1500, 1100), (-1150, 1050, 2720), '#e6e4dc', material=mat('#f4f2ea', 'floor', (2, 6))))
        O.append(box((200, 1500, 1100), (-620, 1050, 2720), '#efeee8', material=mat('#fbf9f2', 'floor', (2, 6))))
    if 'sc2' in P:
        O.append(box((210, 1500, 1000), (-290, 1050, 2800), '#e2e0d8', material=mat('#f0eee6', 'floor', (2, 6))))
        O.append(box((340, 1400, 300), (-200, 1150, 2330), '#dcdad2', material=mat('#e8e6de', 'floor', (2, 2))))
    if 'sc3' in P:    # 右の木組みの足場
        for k in range(6):
            O.append(box((300, 420, 240), (560 + k * 120, 510, 2230 + k * 215), '#d9b45c', material=mat('#d9b45c', wireframe=True)))
        O.append(box((330, 20, 1300), (860, 300, 2760), '#e8dcc0', rot=(0, -29, 0)))
    if 'fence' in P:
        # v4: 金網は高さ 154・柱は 40 おき・網目は 8(完成版 3465: 金網の高さ 175px に柱の間 45px・網目 9px)
        O.append(plane((3200, 154), (0, -77, 1500), '#ffffff', tname='net', repeat=(400, 19), type='basic', transparent=True))
        O.append({'geometry': 'box', 'size': [3.2, 158, 3.2], 'position': [0, -79, 1500], 'material': mat('#33463a'),
                  'instances': {'count': 81, 'layout': 'grid', 'grid': [81, 1, 1], 'spacing': [40, 0, 0]}})
        O.append(box((3200, 3.5, 3.5), (0, -154, 1500), '#33463a'))
    if 'stand' in P:  # 高台: 床・細い柵・ベンチ・塔屋(戸口が光る)
        O.append(plane((3200, 2100), (0, -2, -450), '#c2b896', rot=(90, 0, 0), tname='floor', repeat=(16, 10), type='basic'))
        O.append(plane((3200, 900), (0, 0, 1050), '#c2b896', rot=(90, 0, 0), tname='floor', repeat=(16, 5), type='basic'))      # v6: 後半は奥の床も日かげ(前半は床の下に隠しておく)
        O[-1]['position'][1] = kf((0, 40), (163, 40, 'hold'), (164, -2), (245, -2))                 # 後半に映る側の床は日かげ(暗い)
        # v6(完成版 3585 を測り直した): 手前の床は柵の向こうと同じ高さ。柵 = 高さ 200・柱の間 55 の細い柱 + 金網(上の横木は映っていない)。ベンチ = 高さ 83 の板 2 枚が柵から手前へまっすぐのびる
        O.append(box((3600, 2800, 1300), (0, 1400, -2150), '#b5a26e', material=mat('#b5a26e', 'floor', (8, 4))))
        O.append(plane((3200, 200), (0, -100, -1510), '#ffffff', tname='net', repeat=(400, 25), type='basic', transparent=True, alpha_test=0.05))
        O.append({'geometry': 'box', 'size': [5, 200, 5], 'position': [0, -100, -1510], 'material': mat('#9a9a5c'),
                  'instances': {'count': 59, 'layout': 'grid', 'grid': [59, 1, 1], 'spacing': [55, 0, 0]}})
        for bx, bz, bw in ROOF_BENCH:      # POLISH2: 横長のベンチ(板 + 脚 4 本 + 床の影)
            O.append(box((bw, 10, 84), (bx, -49, bz), '#6f5a44'))      # 板の上面 y=-54(腰かけの高さ)
            for lx in (-bw / 2 + 8, bw / 2 - 8):
                for lz in (-34, 34):
                    O.append(box((8, 44, 8), (bx + lx, -22, bz + lz), '#d9a040'))
            O.append(plane((bw + 60, 150), (bx - 16, -3.2, bz - 10), '#ffffff', rot=(90, 0, 0), tname='blob', type='basic', transparent=True))
        # v13(POLISH5): 黄色い木組みの台。v12 までは箱の wireframe(細い線 + 面の対角線)で、作りかけの線に見えていた → 角材 9 の柱 4 本 + 上と中段の横木(完成版 3580 の左下: 黄色い木の枠に横木)
        _fx, _fz, _fw, _fh, _ft = -331, -1700, 110, 84, 8      # 高さ 150 だと画面の左端で背の高い棚に見えた(全編シート 3564〜3612)→ 84(完成版は腰かけほどの高さ)
        # v14(POLISH6): 明るい黄色の木組みは、画面の左下の端で切れた「黄色いいす」に見えて目に入った(ユーザー指摘の続き)。
        #   → ほかの 2 台と同じ作りのベンチ(こげ茶の板 + 脚 + 床の影)にして場面になじませた。置き場所は同じ(左下の端にかかる)
        _bw3 = 170
        O.append(box((_bw3, 10, 84), (_fx, -49, _fz), '#6f5a44'))
        for lx in (-_bw3 / 2 + 8, _bw3 / 2 - 8):
            for lz in (-34, 34):
                O.append(box((8, 44, 8), (_fx + lx, -22, _fz + lz), '#b98a3a'))
        O.append(plane((_bw3 + 60, 150), (_fx - 16, -3.2, _fz - 10), '#ffffff', rot=(90, 0, 0), tname='blob', type='basic', transparent=True))
        O.append(box((560, 380, 560), (-1300, -190, 1180), '#8d887c'))
        O.append(plane((90, 190), (-1300, -95, 895), '#ffd84a', type='basic'))
    extra = []
    if figures:
        F = roof_figures(n, ctx)
        sit_pic = bool(F[8].pop('B_sit', False))
        if ctx is not None and VRM_ON:      # v7: 私服パーカーの 2 体(1 人目の後ろ姿・並びの A)は VRM の model レイヤー(舞台の mesh の上に重ねる)
            F[0] = F[4] = None
            extra = roof_vrm_layers(n, VRM_PARKA[ctx.project_id])
        O.extend(x for x in F if x)
        for _i, (sx_, sz_) in ROOF_FEET_V6.items():      # POLISH 11/16: 並ぶ 7 体の足もとに丸い影(宙に浮いて見えたので)
            O.append(plane((150, 78), (sx_ + ROOF_SHADOW_OFS[0], -3.5, sz_ + ROOF_SHADOW_OFS[1]), '#ffffff', rot=(90, 0, 0), tname='blob', type='basic', transparent=True))
        if sit_pic:      # POLISH2: 座る B の、ベンチの板の上の影
            _st = ROOF_BSIT_V6['seat']      # POLISH3: 影は腰の下(板の上)と足もと(床)
            O.append(plane((130, 56), (_st[0] + 4, _st[1] - 1.2, _st[2] + 6), '#ffffff', rot=(90, 0, 0), tname='blob', type='basic', transparent=True))
            O.append(plane((110, 50), (ROOF_BSIT_V6['pos'][0] - 40, -3.6, ROOF_BSIT_V6['pos'][2] - 14), '#ffffff', rot=(90, 0, 0), tname='blob', type='basic', transparent=True))
        if not sit_pic:
            O.append(box((330, 4, 4), (-105, -235, -1485), '#b0343a', rot=(0, 0, -35)))                          # 槍(座り姿の絵には槍が描いてある)
    lt = {'direction': [-0.4, -1, -0.5], 'intensity': kf((150, 1.6), (175, 0.6)), 'ambient': kf((150, 1.1), (175, 0.42))}     # 後半は床が暗い(日かげ)
    c = cam(n, ROOF_CAM['zoom'], ROOF_CAM['pos'], ROOF_CAM['tgt'])
    if extra:
        c['source']['zbuffer'] = False      # レイヤーを奥行きで並べ替えない(舞台の mesh の原点はカメラの後ろに来るので、並べ替えると人物が舞台の下に隠れる)
    return [c] + extra + [mesh('stage', n, O, light=lt)]


# ---- v7(VRMSAK): 屋上の私服パーカー 2 体 = VRM(ユーザー提供の 3D モデル) ----
from recreate_g2 import VRM_PARKA, VRM_ON, VRM_LOOK      # noqa: E402
ROOF_VRM = dict(
    back=dict(h=168, yaw=180),                  # 1 人目(後ろ姿): 髪の頭頂が 165 になる身長(リボン・あほ毛こみの箱の高さ)
    line=dict(pos=ROOF_FEET_V6[4], h=216, yaw=0),      # 並びの A
)


def roof_vrm_layers(n, aid):
    """上から順に: 手前の柵(並びの A の脚に重なる分だけ)・並びの A・1 人目の後ろ姿。model レイヤーは mesh と奥行きの前後が付かないので、人物より手前の物は別の mesh で上に重ねる"""
    R = ROOF_VRM
    w = lambda amp, per, base=0.0, ph=0.0: psway(n, amp, per, ph, base)      # noqa: E731
    # 1 人目: 金網の前で街を見る後ろ姿。右手を腰・左手は下ろして少し開く・足を肩幅に。光は左の低い所から(完成版 3519 の床の影は足もとから右へのびる・濃さは床の 1 割弱)
    back = layer('vrm_back', 'model', n, {
        'asset_id': aid, 'height': R['back']['h'], 'shadow': {'opacity': 0.12, 'color': '#4a3a30', 'blur': 4},
        'light': {'direction': [-1, -1.1, -0.3], 'intensity': 1.1, 'ambient': 0.0},
        'vrm': dict(VRM_LOOK, shade={'shift': -0.7, 'toony': 0.95}, preset='hand_on_hip', pose={'shoulder_l': [0, 0, 16], 'elbow_l': [8, 0, 0], 'hand_l': 'open', 'hip_l': [0, 0, 11], 'hip_r': [0, 0, 3],
                                                             'head': [0, w(1.2, 170, 0), 0], 'chest': [w(0.4, 130, 0), 0, 0],
                                                             'root': [0, 0, 0]},
                    auto_blink={'interval': 3.4, 'seed': 3}, spring={'stiffness': 2.5, 'gravity': 0.2})},
        t1=164, transform={'position': [CX + ROOF_P[0], CY, ROOF_P[1]],
                           # v8(VRMFIX): 振り向きはレイヤーの向きのキーで(v7 は「キーにすると後ろ姿が正面向きに描かれる」不具合を避けて体の軸 root で回していた。原因 = 要素ごとのキーが 0 と読まれた。scene.js を直した)
                           'rotation': dict(kf(*([(0, [0, R['back']['yaw'], 0])] + [(f, [0, round(R['back']['yaw'] + R['back'].get('turn_sign', -1) * _pchip([k[0] for k in ROOF_TURN], [k[1] for k in ROOF_TURN], f), 2), 0]) for f in range(150, 164)])), interp='linear')})
    # 並びの A(後半 164〜): こちら向き・右手を腰。後半は日かげなので光を弱める
    lx, lz = R['line']['pos']
    cx, _cy, cz = ROOF_CAM['pos'][-2][1]
    line = layer('vrm_line', 'model', n, {
        'asset_id': aid, 'height': R['line']['h'], 'shadow': {'opacity': 0.14, 'color': '#2a2620', 'blur': 4},
        'light': {'direction': [-0.5, -1, -0.8], 'intensity': 1.06, 'ambient': 0.0},
        'vrm': dict(VRM_LOOK, preset='hand_on_hip', pose={'shoulder_l': [0, 0, 14], 'elbow_l': [8, 0, 0], 'hand_l': 'open', 'hip_l': [0, 0, 8], 'hip_r': [0, 0, 8], 'head': [0, w(2.0, 150, 0), w(1.0, 190, 0, 0.3)]},
                    expressions={'Joy': 0.3}, auto_blink={'interval': 3.1, 'seed': 8}, spring={'stiffness': 2.5, 'gravity': 0.2})},
        t0=164, transform={'position': [CX + lx, CY, lz], 'rotation': [0, R['line']['yaw'] + round(math.degrees(math.atan2(cx - lx, -(cz - lz))), 1) * R['line'].get('sign', 1), 0]})
    # 手前の柵(金網 + 柱)のうち、カメラから A を見る線が通る所だけ(x −24〜136。金網の目 8・柱の間 55 に合わせた切り方)
    front = mesh('front', n, [
        plane((160, 200), (56, -100, -1510), '#ffffff', tname='net', repeat=(20, 25), type='basic', transparent=True, alpha_test=0.05),
        {'geometry': 'box', 'size': [5, 200, 5], 'position': [55, -100, -1510], 'material': mat('#9a9a5c'), 'instances': {'count': 3, 'layout': 'grid', 'grid': [3, 1, 1], 'spacing': [55, 0, 0]}}],
        light={'direction': [-0.4, -1, -0.5], 'intensity': 0.6, 'ambient': 0.42})
    front['in'] = 164
    return [front, line, back]


def _roof(key, lid, parts, n=144, figures=False, bg=None, note=''):
    @reg(key, lid, 'mesh(箱・板・複製)+ camera' + note)
    def f(ctx):
        return doc('再現 B14 屋上 ' + key.rsplit('/', 1)[-1], n, roof_parts(n, parts, figures, ctx), bg=bg)
    return f


_S30 = 'scene/30_3Dモデル羅列/'
_roof(_S30 + '1.03_背景', 'B14', ['bg'])
_roof(_S30 + '1.06/街', 'B14', ['city'], n=145)
_roof(_S30 + '1.03足場1', 'B14', ['sc1'])
_roof(_S30 + '1.03足場2中', 'B14', ['sc2'])
_roof(_S30 + '1.03足場3右', 'B14', ['sc3'])
_roof(_S30 + '1.03フェンス', 'B14', ['fence'])
_roof(_S30 + '1.03高台足場', 'B14', ['roof'])
_roof(_S30 + '1.08', 'B14', ['bg', 'roof', 'city', 'sc1', 'sc2', 'sc3', 'fence', 'stand'], n=245, figures=True, bg='#eef0f0', note=roof_people_how())


# ================================================================ B18 廊下(S32 3977-4179)
# 座標: 入口の面が z=0、廊下は奥へ 5200。幅 600・高さ 400(床 y=+200、天井 y=-200)。両側はガラスの壁と黄色い柱、その外は教室

COR_CAM = dict(
    zoom=1050,
    # v5(測った): 寄りは速さを保ったまま 4011(34 コマ目)でぴたりと止まり、そのあとは動かない(v4 は 39 までなめらかに減速し、最後まで寄りつづけていた)
    pos=[(0, (0, 0, -40000)), (8, (0, 0, -12000)), (18, (0, 0, -1750)), (28, (0, 0, -543), 'outQuad'), (34, (0, 0, 40), 'outCubic'), (90, (0, 0, 300)), (203, (0, 0, 300))],
    # v12(POLISH4): 止まったあと(4011〜)。完成版は人物が動きつづけ 4037 まで動きの量 10→0 と減っていくが、こちらは人物が板なので 4016 から完全に静止していた → 寄りの余韻(60 コマかけて 110 だけ・減速)を足した
    tgt=[(0, (0, 0, 6000)), (203, (0, 0, 6000))],
)

COR_KYOKO = [(-150, 900, 150), (160, 1150, 150), (-60, 1500, 130), (60, 1800, 150), (230, 1400, 150), (-240, 1700, 140), (20, 2300, 150), (-140, 2700, 150),
             (140, 3000, 150), (-30, 3400, 150), (260, 760, 170), (-270, 820, 170)]


# 廊下に並ぶ魔法少女の杏子の絵(Blender の中に板で置いてあった)。2 巡目は、置き換え表の新しく生成した立ち絵(透明の切り抜き。**仮 = ユーザー未確認の生成絵**)を板に貼る。
# (x, 床からの浮き, z, 高さ)。完成版 4020〜4080 を見て: 手前は大きく(枠の高さの半分ほど)、宙に跳ぶ絵もあり、奥へ向かって小さく密に並ぶ
COR_PICS = ['13.5_サビ歌情報背景/02-1.png', '13.5_サビ歌情報背景/03-1.png', '13.5_サビ歌情報背景/04-2-1.png', '13.5_サビ歌情報背景/06-1.png', '13.5_サビ歌情報背景/09-2.png', '静止画素材/3.png']
COR_BOARDS = [(-200, 0, 700, 270), (230, 0, 720, 260), (-60, 0, 900, 250), (110, 0, 950, 240), (-250, 90, 1000, 250), (60, 130, 1150, 220), (190, 60, 1250, 230), (-130, 0, 1300, 220),
              (0, 0, 1500, 210), (-220, 0, 1700, 220), (220, 0, 1750, 210), (-70, 40, 2000, 200), (90, 0, 2200, 200), (-170, 0, 2500, 200), (160, 30, 2800, 200), (-40, 0, 3100, 200),
              (60, 0, 3500, 200), (-120, 0, 3900, 200), (120, 0, 4300, 200), (0, 0, 4700, 200)]


def corridor_boards(ctx):
    pics = [v for v in (ctx.asset(k) for k in COR_PICS) if v] if ctx is not None else []
    spear = [v for v in (ctx.asset(f'v4:corridor/{i:02d}.png') for i in range(1, 13)) if v] if ctx is not None else []      # v4: 槍を持つ魔法少女服の杏子 12 種(GEN_A。仮・ユーザー未確認)
    O = []
    for i, (x, lift, z, h) in enumerate(COR_BOARDS):
        if not pics:                                   # 絵がまだ無いとき(36 など)は影絵の板のまま
            O.append(figure((x, 195 - lift, z), ('#c6303a', '#a8324a', '#d04858')[i % 3], h=h))
            continue
        mg = [v for v in pics if v.get('asset_id') and v is pics[-1]] if len(pics) == len(COR_PICS) else []      # 魔法少女服の立ち絵(静止画素材/3.png)
        a = mg[0] if mg and i % 2 == 0 else pics[(i * 5 + i // 3) % max(1, len(pics) - (1 if mg else 0))]      # 半分は魔法少女服、残りはほかの衣装の立ち絵
        if len(spear) >= 6:                            # 完成版 4020〜4080 は全員が槍を持つ魔法少女服 → 槍の絵だけを順に(12 枚目 = 逆立ちの絵は浮いた板にだけ)
            a = spear[(i * 5) % len(spear)]
            if a is spear[-1] and len(spear) == 12 and lift == 0:
                a = spear[(i * 5 + 1) % 11]
        h = h * 1.25
        w = h * a['w'] / a['h']
        O.append({'geometry': 'plane', 'size': [w, h], 'position': [x, 198 - lift - h / 2, z], 'scale': [-1 if (i % 2) == (1 if x < 0 else 0) else 1, 1, 1],
                  'material': {'type': 'basic', 'color': '#ffffff', 'side': 'double', 'transparent': True, 'alpha_test': 0.02, 'texture': {'asset_id': a['asset_id']}}})
    return O


def corridor_parts(n, parts, ctx=None):
    P = set(parts)
    O = []
    L = 5200
    if 'ceil' in P:      # 天井(入口の外まで続く面: 遠くからは画面の上半分を覆う)
        O.append(plane((40000, L + 60000), (0, -200, (L - 60000) / 2), '#e8e2a8', rot=(90, 0, 0), type='basic'))
    if 'floor' in P:
        O.append(plane((40000, L + 60000), (0, 200, (L - 60000) / 2), '#6c8fb4', rot=(90, 0, 0), type='basic'))
    if 'room' in P:      # 教室のかたまり(廊下の両わき)
        for s in (-1, 1):
            O.append(box((20000, 400, L), (s * 10300, 0, L / 2), '#f2cf3a', material=mat('#f2cf3a', type='basic')))
    if 'full' in P:
        O.append(plane((600, L), (0, 200, L / 2), '#6c8fb4', rot=(90, 0, 0), type='basic'))                     # 廊下の床
        O.append(plane((3600, L), (0, 201, L / 2), '#3d5a80', rot=(90, 0, 0), type='basic'))                    # 教室の床
        O.append(plane((3600, L), (0, -200, L / 2), '#dfe3b0', rot=(90, 0, 0), type='basic'))                   # 天井
        O.append(plane((3600, 400), (0, 0, L), '#eef0d8', type='basic'))                                        # つきあたり
        for s in (-1, 1):
            O.append(plane((L, 400), (s * 1800, 0, L / 2), '#f3efc8', rot=(0, 90, 0), type='basic'))            # 外の壁(窓の光)
            O.append(plane((L, 400), (s * 300, 0, L / 2), '#bfe0d8', rot=(0, 90, 0), type='basic', opacity=0.22, transparent=True, depth_write=False))   # ガラス
            O.append({'geometry': 'box', 'size': [26, 400, 26], 'position': [s * 300, 0, L / 2], 'material': mat('#c9b23a'),
                      'instances': {'count': 34, 'layout': 'grid', 'grid': [1, 1, 34], 'spacing': [0, 0, 155]}})                                     # 黄色い柱
            O.append(box((14, 14, L), (s * 300, -60, L / 2), '#c9b23a'))                                         # 横桟
            O.append(box((14, 30, L), (s * 300, 185, L / 2), '#d8c24a'))
            O.append({'geometry': 'box', 'size': [70, 6, 50], 'position': [s * 1000, 130, L / 2], 'material': mat('#9fb6cf'),
                      'instances': {'count': 8 * 30, 'layout': 'grid', 'grid': [8, 1, 30], 'spacing': [150, 0, 170]}})                              # 机
        O.append({'geometry': 'cylinder', 'radius': 60, 'height': 8, 'position': [0, -150, L / 2], 'material': mat('#ffffff', type='basic'),
                  'instances': {'count': 13, 'layout': 'grid', 'grid': [1, 1, 13], 'spacing': [0, 0, 400]}})                                         # 天井の灯り
        O.append(box((8, 50, L), (0, -175, L / 2), '#ffffff', material=mat('#ffffff', type='basic')))
        O.extend(corridor_boards(ctx))                    # 杏子の絵(仮: 新しく生成した立ち絵を貼った板)
    return [cam(n, COR_CAM['zoom'], COR_CAM['pos'], COR_CAM['tgt']), mesh('corridor', n, O, light={'direction': [0.3, -1, -0.6], 'intensity': 1.2, 'ambient': 1.5})]


def _cor(key, parts, n, note=''):
    @reg(key, 'B18', 'mesh(箱・板・複製)+ camera' + note)
    def f(ctx):
        return doc('再現 B18 廊下 ' + key.rsplit('/', 1)[-1], n, corridor_parts(n, parts, ctx))
    return f


_S32 = 'scene/32_車両内/'
_cor(_S32 + 'Blender_教室/1.00天井', ['ceil'], 203)
_cor(_S32 + 'Blender_教室/1.00廊下', ['floor'], 203)
_cor(_S32 + 'Blender_教室/1.00教室', ['room'], 203)
_cor(_S32 + 'Blender_教室/1.02教室', ['room'], 203)
_cor(_S32 + 'Blender_教室/1.03full', ['full'], 203, note='。中の杏子の絵 20 枚は仮(新しく生成した魔法少女の立ち絵 6 種 = ユーザー未確認の生成絵 を板に貼った)')


# ================================================================ 2D で組む物

def shp(id, n, kind, w, h, pos, fill=None, **kw):
    src = {'kind': kind, 'width': w, 'height': h, 'fill': fill}
    for k in ('stroke', 'stroke_width', 'start', 'end', 'inner', 'petals', 'sides', 'points', 'closed', 'radius'):
        if k in kw:
            src[k] = kw.pop(k)
    return layer(id, 'shape', n, src, pos=list(pos), **kw)


GOLD, GEMRED = '#ecc85a', '#e02626'


def gem(id, n, x, y, s=1.0, parent=None, red=True, tr=None):
    """ソウルジェムの影絵: 金の台と枠 + 赤い卵。先頭が最前面。"""
    kw = {'parent': parent} if parent else {}
    L = []
    if red:
        L.append(shp(id + 'e', n, 'ellipse', 92 * s, 128 * s, (x, y - 8 * s), GEMRED, **kw))
    L.append(shp(id + 'r', n, 'ellipse', 124 * s, 160 * s, (x, y - 8 * s), None if not red else GOLD, stroke=GOLD, stroke_width=14 * s, **kw))
    L.append(shp(id + 'b', n, 'path', 110 * s, 40 * s, (x, y + 84 * s), GOLD, points=[[-30 * s, -16 * s], [30 * s, -16 * s], [52 * s, 16 * s], [-52 * s, 16 * s]], closed=True, **kw))
    L.append(shp(id + 't', n, 'ellipse', 22 * s, 30 * s, (x, y - 98 * s), GOLD, **kw))
    if tr:
        for l in L:
            l.setdefault('transform', {}).update(tr)
    return L


@reg(_S30 + 'ソウルジェムと桜が回る背景/1.00', 'B16', 'shape(桜 = flower、ソウルジェム = 楕円と台)を並べて回す')
def b16(ctx):
    n = 57
    Ls = []
    cols = ['#b9b6b2', '#d8262e', '#b9b6b2', '#5aa5c4']
    for r, y in enumerate((170, 500, 830, 1160)):
        for i in range(-1, 8):
            x = 150 + i * 315 + (r % 2) * 315
            if (i + 0) % 2 == 0:
                Ls += gem(f'g{r}_{i}', n, x, y, 1.25, red=True)
            else:
                c = cols[((i // 2) + r) % 4]
                Ls.append(shp(f's{r}_{i}', n, 'flower', 280, 280, (x, y), c, petals=5, inner=0.15,
                              transform={'rotation': kf((0, (i * 37) % 72), (n, (i * 37) % 72 + (40 if (i // 2) % 2 else -40)))}))
                Ls.append(shp(f'c{r}_{i}', n, 'ellipse', 26, 26, (x, y), '#e8e5df'))
                Ls[-1], Ls[-2] = Ls[-2], Ls[-1]
    Ls.append(shp('panel', n, 'rect', 1820, 1000, (CX, CY), '#e8e5df'))
    Ls.append(layer('bg', 'solid', n, {'color': '#ffffff'}))
    return doc('再現 B16 ソウルジェムと桜が回る背景', n, Ls)


@reg(_S30 + 'ソウルジェムの暗転部分/1.01', 'B17', 'shape(金の枠が大きくなりながら回る)')
def b17(ctx):
    n = 50
    Ls = []
    spots = [(1420, 560, 2.2, 0, 10), (300, 250, 2.6, 4, -25), (1640, 60, 2.8, 8, 20), (160, 960, 3.0, 12, 15), (1000, 1000, 2.4, 16, -12), (60, 520, 1.8, 20, 30)]
    for i, (x, y, s, t0, rot) in enumerate(spots):
        tr = {'scale': kfa((t0, [0, 0]), (t0 + 14, [100, 100], 'easeOutBack'), (n, [118, 118])), 'rotation': kfa((t0, rot - 40), (t0 + 14, rot, 'easeOutCubic'), (n, rot + 8))}
        Ls.append(layer(f'n{i}', 'null', n, pos=[x, y], transform=tr, t0=t0))
        for l in gem(f'g{i}', n, 0, 0, s, parent=f'n{i}', red=False):
            l['in'] = t0
            Ls.append(l)
    return doc('再現 B17 ソウルジェムの暗転部分', n, Ls)


def _b15(k, ph):
    @reg(_S30 + f'3周囲槍回る/{k}_1.00', 'B15', 'shape(細い槍が人物の周りを回る = 横幅を cos で縮める)')
    def f(ctx):
        n = 27
        Ls = []
        for j in range(3):
            a0 = ph + j * 120
            xs = [(t, [CX + 330 * math.sin(math.radians(a0 + t * 9)), CY]) for t in range(0, n + 1, 3)]
            tr = {'rotation': -6 + j * 6}
            Ls.append(shp(f'h{j}', n, 'path', 40, 120, (0, 0), '#d0d0d0', points=[[0, -600], [16, -520], [0, -480], [-16, -520]], closed=True, transform=dict(tr), ))
            Ls[-1]['transform']['position'] = kf(*xs)
            Ls.append(shp(f's{j}', n, 'rect', 7, 1100, (0, 0), '#c0c0c0', transform=dict(tr)))
            Ls[-1]['transform']['position'] = kf(*xs)
        return doc(f'再現 B15 周囲を回る槍 {k}', n, Ls)
    return f


_b15(1, 0)
_b15(2, 40)
_b15(3, 80)


@reg(_S32 + 'Blender_ケーキ裏放射光/1.00', 'B19', 'shape(pie の扇を並べて回す。色は手元の 0104.png に合わせた)')
def b19(ctx):
    n = 104
    Ls = []
    # 扇の列(角度は画面の右上の中心から。桃・透明・薄黄・透明 …)
    seq = [('#f1a8bd', 24), (None, 14), ('#f2edb9', 7), (None, 9), ('#f1a8bd', 16), (None, 11), ('#f2edb9', 5), (None, 8), ('#f1a8bd', 30), (None, 12),
           ('#f2edb9', 8), (None, 10), ('#f1a8bd', 20), (None, 14), ('#f2edb9', 6), (None, 10), ('#f1a8bd', 26), (None, 12), ('#f2edb9', 7), (None, 9),
           ('#f1a8bd', 18), (None, 13), ('#f2edb9', 6), (None, 8)]
    tot = sum(a for _, a in seq)
    Ls.append(layer('hub', 'null', n, pos=[1560, -40], transform={'rotation': kf((0, 0), (n, 78))}))      # v13(POLISH5): 14° → 78°(1 コマ 0.75°)。v12 はほぼ止まって見え、4094〜4104 の動きの量が手本の半分で減りつづけていた(手本は放射の帯がコマごとに回って 350〜400 のまま)。角度そのものは測れていない(連続コマの見た目から)
    a = 0
    for i, (c, w) in enumerate(seq):
        w2 = w * 360 / tot
        if c:
            Ls.append(shp(f'r{i}', n, 'pie', 6000, 6000, (0, 0), c, start=a, end=a + w2, parent='hub'))
        a += w2
    return doc('再現 B19 ケーキ裏放射光', n, Ls)


def _b20(name, col, segs, spin):
    @reg(_S32 + f'Blender_4つ丸動きあり/1.00{name}', 'B20', 'shape(pie の扇が回る。3000px の円の中)')
    def f(ctx):
        n = 98
        S = 3000
        Ls = [layer('hub', 'null', n, pos=[S / 2, S / 2], transform={'rotation': kf((0, 0), (n, spin))})]
        for i, (a, b) in enumerate(segs):
            Ls.append(shp(f'p{i}', n, 'ring', S, S, (0, 0), col, start=a, end=b, inner=0.5, parent='hub'))
        return doc(f'再現 B20 4つ丸 {name}', n, Ls, w=S, h=S)
    return f


_b20('紫', '#5e3a86', [(20, 95), (200, 275)], 200)
_b20('黄色', '#eac84e', [(100, 195), (280, 15 + 360)], -160)


@reg(_S32 + 'Blender_時計/1.01', 'B21', 'shape(円・目盛り)+ text(ローマ数字)+ 針')
def b21(ctx):
    n = 82
    Wd, Hd = 3840, 2160
    c = (Wd / 2, Hd / 2)
    R = 1000
    Ls = [layer('hub', 'null', n, pos=kfa((0, [c[0], c[1] + 1500]), (16, list(c), 'easeOutCubic')), transform={'rotation': kfa((0, -25), (n, 10))})]     # 下からせり上がる
    Ls.append(shp('hm', n, 'rect', 26, 640, (0, -250), '#3a2a26', parent='hub', transform={'rotation': 0}))
    Ls.append(shp('hh', n, 'rect', 40, 440, (130, -130), '#3a2a26', parent='hub', transform={'rotation': 45}))
    Ls.append(shp('hc', n, 'ellipse', 110, 110, (0, 0), '#3a2a26', parent='hub'))
    rom = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI']
    for i, t in enumerate(rom):
        a = math.radians(i * 30)
        Ls.append(layer(f'r{i}', 'text', n, {'text': t, 'size': 230, 'weight': 700, 'font': 'Noto Serif JP', 'fill': '#3a2a26'},
                        pos=[R * 0.74 * math.sin(a), -R * 0.74 * math.cos(a)], parent='hub', transform={'rotation': i * 30}))
    Ls.append(shp('rim2', n, 'ellipse', R * 1.86, R * 1.86, (0, 0), None, stroke='#3a2a26', stroke_width=14, parent='hub'))
    Ls.append(shp('face', n, 'ellipse', R * 2, R * 2, (0, 0), '#ffffff', parent='hub'))
    Ls.append(shp('rim', n, 'ellipse', R * 2.07, R * 2.07, (0, 0), '#3a2a26', parent='hub'))
    Ls.append(shp('rim0', n, 'ellipse', R * 2.3, R * 2.3, (0, 0), '#ffffff', parent='hub'))
    return doc('再現 B21 時計', n, Ls, w=Wd, h=Hd)


# ---------------------------------------------------------------- B22 槍並べ(S32 4276-4422)

SPEAR = '#8c3d33'


def spear_obj(pos, rot=None, L=760, inst=None, anim_y=None):
    """槍 1 本(柄 = 細い円柱、穂 = 平たい四角錐、白い縁)。pos は柄のまん中。children でまとめる。"""
    g = {'geometry': 'group', 'position': list(pos), 'children': [
        {'geometry': 'cylinder', 'radius': 5, 'height': L, 'position': [0, 0, 0], 'material': mat(SPEAR, type='basic')},
        {'geometry': 'cone', 'radius': 40, 'height': 250, 'segments': 4, 'position': [0, -L / 2 - 110, -4], 'scale': [1, 1, 0.02], 'material': mat(SPEAR, type='basic')},
        {'geometry': 'cone', 'radius': 62, 'height': 330, 'segments': 4, 'position': [0, -L / 2 - 110, 4], 'scale': [1, 1, 0.02], 'material': mat('#f4efe8', type='basic')},
    ]}
    if rot:
        g['rotation'] = list(rot)
    return g


@reg(_S32 + 'Blender_槍並べ/1.01', 'B22', 'mesh(円柱 + 四角錐の槍を並べる)+ camera')
def b22(ctx):
    n = 147
    O = []
    # (1) 0〜22: 大きな槍が 1 本、左から右へ横切る
    # v13(POLISH5): 直線 3 本のつぎはぎ(1 コマ 122 → 308 → 767px と 16・22 で折れる)→ 同じ点を通る spline 1 本(なめらかに加速しつづける)
    O.append(dict(spear_obj((0, 0, 0), rot=(0, 0, 90), L=900), position=dict(kf((0, [-3200, 20, 0]), (16, [-1250, 20, 0]), (22, [600, 20, 0]), (28, [5200, 20, 0])), interp='spline'), scale=3.0))
    # (2) 26〜44: 2 本が下から斜めに上がる
    for i, (x0, r) in enumerate(((-1000, 12), (640, 18))):
        O.append(dict(spear_obj((0, 0, 0), rot=(0, 0, r), L=1100), position=kfa((10, [x0 - r * 30, 2300, 300]), (27, [x0 + r * 10, 150, 300], 'easeOutCubic'), (40, [x0 + r * 30, -2800, 300], 'easeInCubic'))))
    # (3) 44〜125: 左右に 9 本ずつ、奥へ並ぶ。下から立ち上がり、最後は上へ抜ける
    for s in (-1, 1):
        for k in range(11):
            t0 = 33 + k * 1.2
            x, z = s * (700 - k * 30), k * 90 - 100
            ytop = 170 + k * 27.5
            # v13(POLISH5): 扇に倒れる動き。v12 は 98+k から直線で 24° 倒れ、手本(4384 まで静止 → 4397 が山)より 6 コマ早く動きだして量も大きかった
            #   → 倒れ = 104+k から inQuad で 17°(動きだしは小さく、抜けの加速へつながる)、抜け = 106+k から
            O.append(dict(spear_obj((0, 0, 0), L=800), position=kf((t0, [x, 5000, z], 'easeOutBack'), (t0 + 10, [x, ytop, z]), (106 + k, [x, ytop, z], 'easeInCubic'), (134 + k, [x + s * 900, -3400, z])),
                          rotation=kf((104 + k, [0, 0, 0], 'easeInQuad'), (124 + k, [0, 0, s * 17]))))
    C = cam(n, 1100, [(0, (0, 0, -1100)), (n, (0, 0, -1100))], [(0, (0, 0, 0)), (n, (0, 0, 0))])
    return doc('再現 B22 槍並べ', n, [C, mesh('spears', n, O, unlit=True)])


# ================================================================ P03 無い静止画(SD の杏子 6 枚)= 仮の板

def _p03(fn, col):
    @reg('still:静止画素材/20_ミステリアストレイン直後SD/' + fn, 'P03', '仮の板(SD 絵の影絵)', placeholder=True)
    def f(ctx):
        Wd, Hd = 1000, 1300
        u = tex('chibi' + col)
        Ls = [layer('fig', 'image', 10, {'url': u}, pos=[Wd / 2, Hd / 2], transform={'scale': [500, 500]})] if u else \
             [shp('fig', 10, 'ellipse', 800, 1100, (Wd / 2, Hd / 2), col)]
        return doc('仮の板 P03 ' + fn, 10, Ls, w=Wd, h=Hd)
    return f


for _fn, _c in (('FABStPUVUAUP9ZL-1_out-1_out.png', '#b8404e'), ('EzoH1hjVkAIGiHz-1_out-1_out.png', '#a83a52'), ('04_out.png', '#c04a48'),
                ('16.png', '#b03c5a'), ('12.png', '#c6504e'), ('11-1.png', '#a8364a')):
    _p03(_fn, _c)
