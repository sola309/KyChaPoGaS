#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""作り直し G3: S30「3Dモデル羅列」・S32「車両内」の連番(屋上の舞台・廊下・槍・時計・放射光など)と、無い静止画の仮の板。

- 3D は mesh レイヤー(箱・板・複製)+ camera。模様の絵(金網・空・人の影絵)は PIL で手続きで描いて data URL で貼る。
- 人物の 3D モデル・SD 絵は元絵が要るので、同じ位置・大きさの影絵の板(仮)。
"""
import base64
import io
import math

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
    elif name == 'sky':      # 空: 上が青灰、地平線へ白く。横に流れる雲のすじ
        im = Image.new('RGBA', (256, 256))
        d = ImageDraw.Draw(im)
        for y in range(256):
            t = y / 255
            d.line((0, y, 256, y), fill=(int(228 + 27 * t), int(234 + 20 * t), int(242 + 8 * t), 255))
        cl = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
        dc = ImageDraw.Draw(cl)
        import random
        r = random.Random(7)
        for i in range(26):
            x, y, w, h = r.randint(-40, 230), r.randint(20, 215), r.randint(50, 150), r.randint(3, 9)
            dc.ellipse((x, y, x + w, y + h), fill=(255, 250, 240, r.randint(90, 190)) if i % 3 else (205, 214, 228, 120))
        im.alpha_composite(cl.filter(ImageFilter.GaussianBlur(3)))
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
    elif name == 'floor':    # コンクリートの床(ざらつき)
        import random
        r = random.Random(3)
        im = Image.new('RGBA', (128, 128))
        px = im.load()
        for y in range(128):
            for x in range(128):
                v = 205 + r.randint(-16, 16)
                px[x, y] = (v, v - 6, v - 22, 255)
        im = im.filter(ImageFilter.GaussianBlur(0.7))
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

ROOF_CAM = dict(
    zoom=1400,
    pos=[(0, (0, -800, 670)), (25, (0, -310, 670), 'easeOutCubic'), (71, (0, -310, 670), 'easeInOutSine'), (101, (0, -141, 163), 'easeOutSine'), (116, (0, -141, 163), 'easeInOutSine'),
         (143, (0, -230, 10), 'easeInSine'), (165, (-420, -560, -1200), 'easeOutSine'), (188, (-300, -420, -1830), 'easeOutCubic'), (245, (-120, -420, -1850))],
    tgt=[(0, (0, -508, 2670)), (25, (0, -18, 2670), 'easeOutCubic'), (71, (0, -18, 2670), 'easeInOutSine'), (101, (0, 56, 1500), 'linear'), (116, (0, 56, 1500), 'easeInOutSine'), (143, (0, 0, 1500), 'easeInSine'),
         (165, (-100, 0, 300), 'easeOutSine'), (188, (-260, 157, -830), 'easeOutCubic'), (245, (-80, 157, -850))],
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
         'outline': {'width': h / 330, 'color': '#4a2a34'}, 'material': {'type': 'toon', 'toon_steps': 3}, 'self_light': 0.35, 'preset': preset, 'pose': ps}
    if phase is not None:
        o['phase'] = phase
    o.update(kw)
    return o


def roof_figures(n):
    HOOD = ({'top': '#8fb3a6', 'bottom': '#55698f', 'socks': '#2a2630', 'shoes': '#2a2630'}, {'sleeves': 1, 'pants': 0.1, 'socks': 0.85})
    wave = {'k': [dict(f=f, v=round(48 + 14 * math.sin(2 * math.pi * f / 44), 2)) for f in range(0, n + 8, 8)]}
    F = [
        # 1 人目: 金網の前で街を見ている後ろ姿(緑のパーカー・右手を腰)。完成版 3475〜3550
        kyoko((15, 0, 420), *HOOD, pose={**_HIP_R, 'shoulder_l': [0, 0, 14], 'elbow_l': 10, 'hip_l': [0, 0, 6], 'hip_r': [0, 0, 6]}, rot=180, h=165, n=n, seed=0),
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
        kyoko((300, -58, -1690), {'top': '#a32f48', 'bottom': '#a32f48', 'skirt': '#e68aa8', 'socks': '#3b2233', 'shoes': '#7a2338'}, {'sleeves': 0, 'pants': 0.08, 'skirt': 0.62, 'skirt_flare': 0.9, 'socks': 1.55, 'boots': 0.9},
              preset='sit', pose={'shoulder_l': [50, 0, 20], 'elbow_l': 70, 'hand_l': 'fist'}, rot=-150, h=200, n=n, seed=8),
    ]
    return F


def roof_parts(n, parts, figures=False):
    """parts: bg, city, fence, sc1, sc2, sc3, stand の組"""
    P = set(parts)
    O = []
    if 'bg' in P:
        O.append(plane((260000, 70000), (0, -33500, 60000), '#ffffff', tname='sky', type='basic'))
    if 'roof' in P:   # 屋上(= 連番「高台足場」)
        O.append(box((3200, 120, 3000), (0, 60, 0), '#d2c9b4', material=mat('#ffffff', 'floor', (8, 8))))       # 屋上の床
        O.append(box((3200, 2400, 3000), (0, 1320, 0), '#b9b3a6'))                                              # 建物の胴
    if 'city' in P:
        O.append(plane((300000, 300000), (0, 2500, 60000), '#5a4353', rot=(90, 0, 0)))
        for i, (cnt, sz, col, seed) in enumerate(((260, (1500, 380, 1500), '#a9a9a6', 5), (200, (900, 600, 900), '#8f9090', 6), (90, (2600, 300, 1800), '#c9c8c2', 7))):
            O.append({'geometry': 'box', 'size': list(sz), 'position': [0, 2500 - sz[1] / 2, 42000], 'material': mat(col),
                      'instances': {'count': cnt, 'seed': seed, 'layout': 'box', 'area': [110000, 0, 56000], 'scale': [0.5, 1.4]}})
    if 'sc1' in P:    # 手前の白い棟(金網ごしに見える台形)
        O.append(box((700, 1000, 2200), (-1250, 2000, 3300), '#e6e4dc'))
        O.append(box((520, 1100, 1500), (-380, 1950, 3600), '#efeee8'))
    if 'sc2' in P:
        O.append(box((560, 1000, 1700), (330, 2000, 3500), '#e2e0d8'))
        O.append(box((420, 900, 420), (-760, 2050, 2500), '#d8b860', material=mat('#d8b860', wireframe=True)))
    if 'sc3' in P:    # 右の木組みの足場
        for k in range(5):
            O.append(box((700, 500, 380), (1250 + k * 30, 2250 - k * 20, 2500 + k * 420), '#d9b45c', material=mat('#d9b45c', wireframe=True)))
        O.append(box((760, 30, 2200), (1300, 1960, 3300), '#e8dcc0'))
    if 'fence' in P:
        O.append(plane((3200, 300), (0, -150, 1500), '#ffffff', tname='net', repeat=(150, 14), type='basic', transparent=True))
        O.append({'geometry': 'box', 'size': [14, 310, 14], 'position': [0, -155, 1500], 'material': mat('#33463a'),
                  'instances': {'count': 17, 'layout': 'grid', 'grid': [17, 1, 1], 'spacing': [200, 0, 0]}})
        O.append(box((3200, 10, 10), (0, -300, 1500), '#33463a'))
    if 'stand' in P:  # 高台: 床・細い柵・ベンチ・塔屋(戸口が光る)
        O.append(plane((3200, 1200), (0, -2, -900), '#77705c', rot=(90, 0, 0), type='basic'))                 # 後半に映る側の床は日かげ(暗い)
        O.append(box((3600, 2800, 1300), (0, 1340, -2150), '#c9c2ae', material=mat('#ffffff', 'floor', (8, 4))))
        O.append({'geometry': 'box', 'size': [7, 170, 7], 'position': [0, -145, -1510], 'material': mat('#9a9a5c'),
                  'instances': {'count': 45, 'layout': 'grid', 'grid': [45, 1, 1], 'spacing': [80, 0, 0]}})
        O.append(box((3600, 7, 7), (0, -230, -1510), '#9a9a5c'))
        for bx in (130, 420):
            O.append(box((230, 12, 420), (bx, -110, -1740), '#6f5a44'))
        O.append(box((240, 150, 240), (-620, -135, -1760), '#e0b040', material=mat('#e0b040', wireframe=True)))
        O.append(box((560, 380, 560), (-1300, -190, 1180), '#8d887c'))
        O.append(plane((90, 190), (-1300, -95, 895), '#ffd84a', type='basic'))
    if figures:
        O.extend(roof_figures(n))                                                                                # 人物 = 仮: マネキン
        O.append(box((4, 4, 330), (270, -190, -1700), '#b0343a', rot=(30, 40, 0)))                              # 槍
    lt = {'direction': [-0.4, -1, -0.5], 'intensity': kf((150, 1.6), (175, 0.6)), 'ambient': kf((150, 1.1), (175, 0.42))}     # 後半は床が暗い(日かげ)
    return [cam(n, ROOF_CAM['zoom'], ROOF_CAM['pos'], ROOF_CAM['tgt']), mesh('stage', n, O, light=lt)]


def _roof(key, lid, parts, n=144, figures=False, bg=None, note=''):
    @reg(key, lid, 'mesh(箱・板・複製)+ camera' + note)
    def f(ctx):
        return doc('再現 B14 屋上 ' + key.rsplit('/', 1)[-1], n, roof_parts(n, parts, figures), bg=bg)
    return f


_S30 = 'scene/30_3Dモデル羅列/'
_roof(_S30 + '1.03_背景', 'B14', ['bg'])
_roof(_S30 + '1.06/街', 'B14', ['city'], n=145)
_roof(_S30 + '1.03足場1', 'B14', ['sc1'])
_roof(_S30 + '1.03足場2中', 'B14', ['sc2'])
_roof(_S30 + '1.03足場3右', 'B14', ['sc3'])
_roof(_S30 + '1.03フェンス', 'B14', ['fence'])
_roof(_S30 + '1.03高台足場', 'B14', ['roof'])
_roof(_S30 + '1.08', 'B14', ['bg', 'roof', 'city', 'sc1', 'sc2', 'sc3', 'fence', 'stand'], n=245, figures=True, bg='#eef0f0', note='。人物は仮: マネキン(mesh の mannequin 9 体。元絵 = 3D モデルの杏子)')


# ================================================================ B18 廊下(S32 3977-4179)
# 座標: 入口の面が z=0、廊下は奥へ 5200。幅 600・高さ 400(床 y=+200、天井 y=-200)。両側はガラスの壁と黄色い柱、その外は教室

COR_CAM = dict(
    zoom=1050,
    pos=[(0, (0, 0, -40000)), (8, (0, 0, -12000), 'linear'), (18, (0, 0, -1750), 'linear'), (28, (0, 0, -543), 'easeOutCubic'), (39, (0, 0, 150), 'linear'), (203, (0, 0, 620))],
    tgt=[(0, (0, 0, 6000)), (203, (0, 0, 6000))],
)

COR_KYOKO = [(-150, 900, 150), (160, 1150, 150), (-60, 1500, 130), (60, 1800, 150), (230, 1400, 150), (-240, 1700, 140), (20, 2300, 150), (-140, 2700, 150),
             (140, 3000, 150), (-30, 3400, 150), (260, 760, 170), (-270, 820, 170)]


def corridor_parts(n, parts):
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
        for i, (x, z, h) in enumerate(COR_KYOKO[:10]):   # 杏子の絵(Blender の中に板で置いてあった)= 仮の板
            O.append(figure((x, 195, z), ('#c6303a', '#a8324a', '#d04858')[i % 3], h=h * 2.1))
    return [cam(n, COR_CAM['zoom'], COR_CAM['pos'], COR_CAM['tgt']), mesh('corridor', n, O, light={'direction': [0.3, -1, -0.6], 'intensity': 1.2, 'ambient': 1.5})]


def _cor(key, parts, n, note=''):
    @reg(key, 'B18', 'mesh(箱・板・複製)+ camera' + note)
    def f(ctx):
        return doc('再現 B18 廊下 ' + key.rsplit('/', 1)[-1], n, corridor_parts(n, parts))
    return f


_S32 = 'scene/32_車両内/'
_cor(_S32 + 'Blender_教室/1.00天井', ['ceil'], 203)
_cor(_S32 + 'Blender_教室/1.00廊下', ['floor'], 203)
_cor(_S32 + 'Blender_教室/1.00教室', ['room'], 203)
_cor(_S32 + 'Blender_教室/1.02教室', ['room'], 203)
_cor(_S32 + 'Blender_教室/1.03full', ['full'], 203, note='。中の杏子の絵は仮の板')


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
        tr = {'scale': kf((t0, [0, 0]), (t0 + 14, [100, 100], 'easeOutBack'), (n, [118, 118])), 'rotation': kf((t0, rot - 40), (t0 + 14, rot, 'easeOutCubic'), (n, rot + 8))}
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
    Ls.append(layer('hub', 'null', n, pos=[1560, -40], transform={'rotation': kf((0, 0), (n, 14))}))
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
    Ls = [layer('hub', 'null', n, pos=kf((0, [c[0], c[1] + 1500]), (16, list(c), 'easeOutCubic')), transform={'rotation': kf((0, -25), (n, 10))})]     # 下からせり上がる
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
    O.append(dict(spear_obj((0, 0, 0), rot=(0, 0, 90), L=900), position=kf((0, [-3200, 20, 0]), (16, [-1250, 20, 0], 'linear'), (22, [600, 20, 0], 'linear'), (28, [5200, 20, 0])), scale=3.0))
    # (2) 26〜44: 2 本が下から斜めに上がる
    for i, (x0, r) in enumerate(((-1000, 12), (640, 18))):
        O.append(dict(spear_obj((0, 0, 0), rot=(0, 0, r), L=1100), position=kf((10, [x0 - r * 30, 2300, 300]), (27, [x0 + r * 10, 150, 300], 'easeOutCubic'), (40, [x0 + r * 30, -2800, 300], 'easeInCubic'))))
    # (3) 44〜125: 左右に 9 本ずつ、奥へ並ぶ。下から立ち上がり、最後は上へ抜ける
    for s in (-1, 1):
        for k in range(11):
            t0 = 33 + k * 1.2
            x, z = s * (700 - k * 30), k * 90 - 100
            ytop = 170 + k * 27.5
            O.append(dict(spear_obj((0, 0, 0), L=800), position=kf((t0, [x, 5000, z]), (t0 + 10, [x, ytop, z], 'easeOutBack'), (100 + k, [x, ytop, z], 'easeInCubic'), (132 + k, [x + s * 900, -3400, z])),
                          rotation=kf((98 + k, [0, 0, 0]), (118 + k, [0, 0, s * 24]))))
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
