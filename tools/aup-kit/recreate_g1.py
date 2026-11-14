#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""作り直し G1: S4(冒頭線路螺旋)・S8/S13(タイトルパート)の Blender 連番(B01〜B09)。

数値はどれも完成版(final_1.05.mp4)を見て測ったもの。絵そのものは使っていない。
"""
from recreate_lib import *   # noqa: F401,F403

S4 = 'scene/04_冒頭線路螺旋/Blender/'


def _sakura_asset(ctx):
    a = ctx.asset('キャプチャ素材\\05-1.png')
    return a['asset_id'] if a else None


# ---------------------------------------------------------------- B04 奥行き穴あき背景
# 完成版と元絵(キャプチャ素材/05-1.png)を特徴点で合わせて測った値:
#   拡大 1.702 倍で一定(60 コマ目から 1 コマ 0.00043 ずつ縮む)、回転は 65°×(1−t)^3(42 コマで 0)、横ずれ ≈ 0.75 px/度。色は元絵のまま。
B04_ROT = 65.0
B04_ROT_N = 42


def _b04_tr(n, extra_rot=0.0, scale=None):
    sc = scale or kf((0, [170.2, 170.2]), (60, [170.2, 170.2]), (n, [170.2 - 0.0431 * (n - 60)] * 2))
    return {'position': kf((0, [960 + 0.75 * B04_ROT, 540], 'outCubic'), (B04_ROT_N, [960, 540])),
            'rotation': kf((0, B04_ROT + extra_rot, 'outCubic'), (B04_ROT_N, extra_rot)), 'scale': sc}


@reg(S4 + '05_奥行き穴あき背景/1.01', 'B04', 'image(桜の木)+ 回転・拡大のキー')
def b04_bg(ctx):
    n = 321
    aid = _sakura_asset(ctx)
    return doc('再現 B04 奥行き穴あき背景 1.01(桜の木)', n, [
        layer('tree', 'image', n, {'asset_id': aid}, transform=_b04_tr(n)),
    ], bg='#f4eef4')


@reg(S4 + '05_奥行き穴あき背景/1.02', 'B04', 'shape(pie)の半透明の円盤 4 枚 + グラデーション')
def b04_discs(ctx):
    n = 321
    L = []
    # (半径, 欠けの開始角, 欠けの幅, 回る速さの倍率, 消え始め)。白 → 透明のグラデーション(左下が濃い)
    for i, (r, a0, gap, k, t0) in enumerate([(470, 100, 70, 1.0, 14), (760, 200, 60, 0.8, 16), (1150, 330, 80, 0.6, 18)]):
        fill = {'gradient': {'type': 'linear', 'angle': 45, 'stops': [[0, '#ffffffa0'], [0.5, '#ffffff38'], [1, '#ffffff06']]}}
        tr = {'position': kf((0, [960 + 0.75 * B04_ROT, 540], 'outCubic'), (B04_ROT_N, [960, 540])),
              'rotation': kf((0, B04_ROT * k, 'outCubic'), (B04_ROT_N, 0)),
              'opacity': kf((0, 100), (t0, 100, 'inOutQuad'), (t0 + 10, 0))}
        L.append(layer(f'disc{i}', 'shape', t0 + 11, {'kind': 'pie', 'width': r * 2, 'height': r * 2, 'start': a0 + gap, 'end': a0 + 360, 'fill': fill}, transform=tr))
    return doc('再現 B04 奥行き穴あき背景 1.02(円盤)', n, L)


# ---------------------------------------------------------------- B05 時計
# 完成版を見て測った動き(n = コマ − 784):
#   0〜28   針の先(矢じり)の大写しから引く。 28〜66 金の針 1 本(先 y=120、根元 y=900)
#   66〜88  針が 3 本に分かれて回り、根元が画面の中央へ。 85〜 文字盤(半径 ≈ 800。中は灰色の桜)。数字は 92〜108 に出る
#   132〜166 時計が下へ(中心 y 540 → 1500)。150 からは中が色つきに戻る
CLOCK_R = 800
ROMAN = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI']
GOLD, CREAM, INK = '#e6c56c', '#efece2', '#3b2b2c'


def _hand(L, n, hid, ang, length, head, shaft_w, head_fill, parent='piv'):
    """針 1 本: 回す null + 軸(下端が根元)+ 先の矢じり。length = [(コマ, px)…]"""
    L.append(layer(hid + '_head', 'shape', n, {'kind': 'path', 'closed': True, 'points': [[0, -head[1]], [head[0] / 2, 0], [0, -head[1] * 0.28], [-head[0] / 2, 0]],
                                              'fill': head_fill, 'stroke': '#ffffff', 'stroke_width': max(2, head[0] * 0.12), 'join': 'miter'},
                   parent=hid, transform={'position': kf(*[(f, [0, -v + head[1]]) for f, v in length])}))
    L.append(layer(hid + '_shaft', 'shape', n, {'kind': 'rect', 'width': shaft_w, 'height': 1000, 'fill': GOLD}, parent=hid,
                   transform={'anchor': [0, 500], 'position': [0, 0], 'scale': kf(*[(f, [100, v / 10]) for f, v in length])}))
    L.append(layer(hid, 'null', n, parent=parent, transform={'position': [0, 0], 'rotation': kf(*ang)}))


def clock_layers(ctx, n, tree_scale):
    L = []
    pre = [(0, 765), (66, 765), (72, 615), (80, 510), (84, 450)]
    # 針(手前から 秒・分・時)
    _hand(L, n, 'sec', [(0, 0), (64, 0), (66, -3), (72, -12), (80, -30), (84, -70), (88, -128), (91, -189), (94, -255), (97, -295), (100, -324), (106, -355), (116, -372), (126, -378), (136, -376)],
          pre + [(88, 480), (94, 492), (97, 540), (100, 600), (106, 700), (116, 780), (136, 800)], (22, 80), 2.5, '#ffffff')
    _hand(L, n, 'min', [(0, 0), (64, 0), (72, -10), (80, -24), (84, -55), (88, -98), (91, -147), (94, -196), (97, -231), (100, -252), (106, -276), (116, -290), (126, -292.5), (136, -293)],
          pre + [(88, 470), (94, 497), (97, 543), (100, 567), (106, 618), (116, 653), (126, 666), (136, 678)], (48, 112), 3.5, '#d9344e')
    _hand(L, n, 'hour', [(0, 0), (64, 0), (80, -2), (88, -5), (91, -13), (94, -16), (97, -18), (100, -19), (106, -22), (116, -24)],
          pre + [(88, 468), (91, 484), (100, 460), (116, 410), (136, 396)], (48, 112), 3.5, '#d9344e')
    # 大写しのあいだの矢じりの中(灰色)と、針の飾り(金のひし形)
    zo = kf((0, 100), (14, 100), (20, 0))
    L.insert(0, layer('zoom_head', 'shape', 20, {'kind': 'path', 'closed': True, 'points': [[0, -100], [15, -10], [0, -30], [-15, -10]], 'fill': '#8f8f92'},
                      parent='piv', transform={'position': [0, -765 + 112], 'opacity': zo}))
    L.insert(1, layer('zoom_head_w', 'shape', 20, {'kind': 'path', 'closed': True, 'points': [[0, -130], [34, 14], [0, -22], [-34, 14]], 'fill': '#ffffff'},
                      parent='piv', transform={'position': [0, -765 + 112], 'opacity': zo}))
    L.append(layer('orn', 'shape', 90, {'kind': 'path', 'closed': True, 'points': [[0, -46], [13, 0], [0, 46], [-13, 0]], 'fill': GOLD}, parent='piv',
                   transform={'position': [0, -765 + 185], 'opacity': kf((0, 100), (30, 100), (60, 0))}))
    # 文字盤(face = 中心の null。拡大で出てくる)
    fs = kf((84, [150, 150], 'outCubic'), (88, [117, 117], 'outQuad'), (100, [100, 100]))
    fo = kf((84, 0), (87, 100))
    for i, t in enumerate(ROMAN):
        a = math.radians(i * 30)
        L.append(layer(f'num{i}', 'text', n, {'text': t, 'font': 'Noto Serif JP', 'weight': 900, 'size': 195, 'fill': INK, 'tracking': -4}, parent='face', t0=92,
                       transform={'position': [math.sin(a) * 590, -math.cos(a) * 590], 'rotation': i * 30,
                                  'scale': kf((92, [6, 8], 'inQuad'), (99, [22, 30], 'outCubic'), (110, [66, 100])), 'opacity': kf((92, 0), (96, 100))}))
    for j, (r, f0) in enumerate([(120, 98), (240, 100)]):          # 出てすぐ広がって消える輪 2 本
        L.append(layer(f'pulse{j}', 'shape', f0 + 26, {'kind': 'ellipse', 'width': r * 2, 'height': r * 2, 'fill': None, 'stroke': '#ffffff', 'stroke_width': 22}, parent='face', t0=f0,
                       transform={'position': [0, 0], 'scale': kf((f0, [40, 40], 'outQuad'), (f0 + 26, [150, 150])), 'opacity': kf((f0, 0), (f0 + 5, 40), (f0 + 26, 0))}))
    L.append(layer('ring_in', 'shape', n, {'kind': 'ellipse', 'width': 750, 'height': 750, 'fill': None, 'stroke': '#ffffff', 'stroke_width': 2.5,
                                           'trim': kf((85, [0, 0], 'outQuad'), (102, [0, 1]))}, parent='face', t0=85, transform={'position': [0, 0], 'rotation': -60, 'opacity': 85}))
    L.append(layer('ring_tick', 'shape', n, {'kind': 'ellipse', 'width': 1490, 'height': 1490, 'fill': None, 'stroke': '#ffffff', 'stroke_width': 16, 'dash': [2, 37]}, parent='face', t0=92,
                   transform={'position': [0, 0], 'opacity': kf((92, 0), (104, 55))}))
    L.append(layer('ring_out', 'shape', n, {'kind': 'ellipse', 'width': 1500, 'height': 1500, 'fill': None, 'stroke': '#ffffff', 'stroke_width': 2}, parent='face', t0=85, transform={'position': [0, 0], 'opacity': 60}))
    L.append(layer('rim', 'shape', n, {'kind': 'ellipse', 'width': CLOCK_R * 2 - 70, 'height': CLOCK_R * 2 - 70, 'fill': None, 'stroke': CREAM, 'stroke_width': 70}, parent='face', t0=84,
                   transform={'position': [0, 0], 'opacity': fo}))
    aid = _sakura_asset(ctx)
    # 文字盤の中: 灰色の桜(150 コマ目から色つき + 白いもや)
    L.append(layer('veil', 'shape', n, {'kind': 'ellipse', 'width': CLOCK_R * 2 - 70, 'height': CLOCK_R * 2 - 70,
                                        'fill': {'gradient': {'type': 'linear', 'angle': 180, 'stops': [[0, '#ffffffb0'], [0.5, '#ffffff30'], [1, '#ffffff10']]}}}, parent='face', t0=148,
                   transform={'position': [0, 0], 'opacity': kf((147, 0), (149, 100))}))
    L.append(layer('in_gray', 'image', 154, {'asset_id': aid}, t0=84, matte={'layer': 'facemask', 'mode': 'alpha'},
                   transform={'position': [960, 540], 'scale': tree_scale, 'opacity': kf((84, 0), (87, 100), (147, 100), (149, 0))},
                   effects=[{'type': 'grayscale', 'params': {'amount': 100}}, {'type': 'levels', 'params': {'in_black': 0, 'in_white': 255, 'gamma': 1, 'out_black': 78, 'out_white': 212}}]))
    L.append(layer('in_color', 'image', n, {'asset_id': aid}, t0=146, matte={'layer': 'facemask', 'mode': 'alpha'},
                   transform={'position': [960, 540], 'scale': tree_scale}))
    L.append(layer('facemask', 'shape', n, {'kind': 'ellipse', 'width': CLOCK_R * 2 - 70, 'height': CLOCK_R * 2 - 70, 'fill': '#ffffff'}, parent='face', t0=84, transform={'position': [0, 0]}))
    L.append(layer('face', 'null', n, parent='piv', transform={'position': [0, 0], 'scale': fs}))
    # piv = 針の根元 = 文字盤の中心。zoom = 針の先(大写しの拡大の中心)
    L.append(layer('piv', 'null', n, parent='zoom', transform={'position': kf((0, [0, 765]), (66, [0, 765]), (72, [0, 615]), (80, [0, 495]), (84, [0, 420]), (88, [0, 405]),
                                                                           (132, [0, 405]), (136, [0, 435]), (146, [0, 630]), (148, [0, 735]), (152, [0, 1050]), (156, [0, 1245]), (161, [0, 1320]), (176, [0, 1365]), (216, [0, 1380]), (n, [0, 1395]))}))
    L.append(layer('zoom', 'null', n, transform={
        'position': kf((0, [960, -600]), (2, [960, -100]), (4, [960, 0]), (6, [960, 30]), (8, [960, 75]), (12, [960, 90]), (20, [960, 120]), (28, [960, 135])),
        'scale': kf((0, [1400, 1400]), (2, [470, 470]), (4, [360, 360]), (6, [220, 220]), (8, [200, 200]), (12, [160, 160]), (20, [130, 130]), (28, [100, 100]))}))
    return L


@reg(S4 + '06_時計/1.07', 'B05', 'shape(針・輪・矢じり)+ text(ローマ数字)+ image(桜)を円のマットで')
def b05(ctx):
    n = 321
    sc = kf((0, [170.2, 170.2]), (60, [170.2, 170.2]), (n, [170.2 - 0.0431 * (n - 60)] * 2))
    return doc('再現 B05 時計 1.07', n, clock_layers(ctx, n, sc))


# ---------------------------------------------------------------- B03 文字散らせ(ポッキーの箱・紙片・槍)
# 完成版: 赤(Rocky)と緑(PRETZ)の箱と細い紙片が 3D で舞い、槍(白い矢じり + 赤 + 金の柄)が奥へ並ぶ。小さな字の輪。カメラは前へ進む。
PKG_COMP = scene_comps().get('48', 55)      # S48 ポッキープリッツパッケージ(箱の展開図。105 コマ目 = 赤い Rocky、10 コマ目 = PRETZ)


def _mesh(id, n, objects, light=None, **kw):
    src = {'env': 'soft', 'light': light or {'ambient': 1.5, 'intensity': 1.2, 'direction': [-0.4, -1, -0.8]}, 'objects': objects}
    return layer(id, 'mesh', n, src, pos=[960, 540, 0], **kw)


def _spear(seed_path, up, count):
    """槍の列(along の同じ道に、矢じりの外・中・柄を同じ並びで置く)"""
    s = 1 if up else -1
    k = 2.4 * s
    head = [[0, -170 * k], [80 * 2.4, 120 * k], [0, 50 * k], [-80 * 2.4, 120 * k]]
    inner = [[0, -105 * k], [42 * 2.4, 78 * k], [0, 38 * k], [-42 * 2.4, 78 * k]]
    inst = {'count': count, 'layout': 'along', 'path': seed_path, 'align': False}
    return [
        {'geometry': 'extrude', 'points': inner, 'depth': 2, 'position': [0, 0, -6], 'material': {'type': 'basic', 'color': '#d9607c', 'side': 'double'}, 'instances': dict(inst)},
        {'geometry': 'extrude', 'points': head, 'depth': 2, 'material': {'type': 'basic', 'color': '#f1eeee', 'side': 'double'}, 'instances': dict(inst)},
        {'geometry': 'cylinder', 'radius': 7, 'height': 3000, 'position': [0, 1600 * s, 0], 'material': {'type': 'basic', 'color': '#e3c66f'}, 'instances': dict(inst)},
    ]


@reg(S4 + '04_杏子ちゃんとポッキーゲームしたい文字散らせ/1.04', 'B03', 'mesh(箱・紙片の instances、槍 = extrude + cylinder)+ text(円周)+ camera')
def b03(ctx):
    n = 210
    red, green = '#c8283f', '#4aa862'
    tex_r = {'type': 'standard', 'color': '#ffffff', 'roughness': 0.7, 'texture': {'comp_id': PKG_COMP, 'frame': 105}, 'texture_repeat': [0.42, 0.62], 'texture_offset': [0.0, 0.0]}
    tex_g = {'type': 'standard', 'color': '#d8f0dc', 'roughness': 0.7, 'texture': {'comp_id': PKG_COMP, 'frame': 10}, 'texture_repeat': [0.5, 0.8], 'texture_offset': [0.0, 0.05]}
    area = [5200, 3000, 6400]

    def boxes(color, tex, seed, count, size, sc):
        m = {'color': color, 'roughness': 0.75}
        return {'geometry': 'box', 'size': size, 'position': [0, 0, 2600], 'material': m, 'faces': [m, m, m, m, tex or m, tex or m],
                'instances': {'count': count, 'seed': seed, 'layout': 'box', 'area': area, 'scale': sc, 'rotation_random': [180, 180, 180],
                              'spin': [20, 30, 10], 'spin_random': [50, 60, 40], 'velocity': [0, 40, 0], 'velocity_random': [40, 50, 30]}}
    objs = [
        boxes(red, tex_r, 3, 120, [150, 235, 46], [0.6, 1.5]),
        boxes(green, tex_g, 4, 90, [150, 235, 46], [0.6, 1.5]),
        boxes(red, None, 5, 420, [84, 20, 12], [0.6, 1.4]),
        boxes(green, None, 6, 300, [84, 20, 12], [0.6, 1.4]),
    ]
    spears = (_spear({'type': 'line', 'from': [-1500, 240, -200], 'to': [1900, 240, 6200]}, True, 6)
              + _spear({'type': 'line', 'from': [-1900, -260, 300], 'to': [1300, -260, 6600]}, False, 6)
              + _spear({'type': 'line', 'from': [2300, 420, 2600], 'to': [-2400, 420, 5200]}, True, 4))
    txt = '杏子ちゃんとポッキーゲームしたい　' * 6
    rings = []
    for i, (r, pos, rot, spd) in enumerate([(620, [700, 620, 1500], [18, -12, 0], 14), (900, [1250, 520, 2600], [-14, 20, 0], -10), (520, [1500, 380, 3600], [10, 8, 0], 18)]):
        rings.append(layer(f'ring{i}', 'text', n, {'text': txt[:int(r / 9)], 'font': 'Noto Sans JP', 'weight': 400, 'size': 30, 'fill': '#7d8194', 'arc': {'radius': r, 'start': 0, 'sweep': 360}},
                           three_d=True, transform={'position': pos, 'rotation': kf((0, rot), (n, [rot[0], rot[1], spd * n / 60]))}))
        rings.append(layer(f'ringl{i}', 'shape', n, {'kind': 'ellipse', 'width': r * 2 - 70, 'height': r * 2 - 70, 'fill': None, 'stroke': '#8a8ea0', 'stroke_width': 2.5},
                           three_d=True, transform={'position': pos, 'rotation': rot, 'opacity': 70}))
    cam = layer('cam', 'camera', n, {'zoom': 1100, 'target': kf((0, [960, 540, 2400]), (n, [1000, 520, 4200]))},
                transform={'position': kf((0, [900, 560, -1500]), (n, [1040, 500, 900]))})
    return doc('再現 B03 文字散らせ(箱・紙片・槍)', n, [cam, _mesh('spears', n, spears, light={'ambient': 3, 'intensity': 0}), *rings, _mesh('boxes', n, objs)])


# ---------------------------------------------------------------- B01 線路花びら
# 完成版: 赤・紫・青の扇形の床が 1 点から手前へ広がり(視点が上がって床は下へ流れる)、14 コマ目から白い波縞の道が下からせり上がる。花びらが舞う。
def _b01_petals(n, seed):
    return [petals('pet_near', n, seed=seed, rate=3, life=3, size=70, wind=(-140, 0, 0), gravity=(0, 160, 0), colors=('#f6b9cc', '#f2a2bd')),
            petals('pet_far', n, seed=seed + 1, rate=22, life=4, size=20, wind=(-60, 0, 0), gravity=(0, 80, 0), colors=('#f6c1d2', '#f4aac4', '#ffffff'))]


@reg('aux:B01_waves', 'B01w', 'pattern(waves。白い道の縞。mesh の床に貼る)')
def b01_waves(ctx):
    return doc('部品 B01 道の波縞', 1, [layer('w', 'pattern', 1, {'kind': 'waves', 'colors': ['#ffffff', '#e2e2e4'], 'size': 128, 'width': 2048, 'height': 2048}, pos=[1024, 1024])],
               bg='#ffffff', w=2048, h=2048)


@reg(S4 + '01_線路花びら1-44/1.02', 'B01', 'mesh(3D の床: 遠くの 1 点から手前へ広がる扇形の板 3 枚 + 波縞の円盤の道)+ camera + particles')
def b01(ctx):
    # 2 巡目: 床を 3D に。床は水平な面で、遠くの 1 点(奥行き D)から手前へ細い扇形(赤・紫・青)が広がる。視点が上がる(床が下がる)と、
    # 透視で頂点が地平線から下りてきて、扇の辺が立ってくる(完成版の辺の傾き 439: 0.22 → 445: 0.82 → 452: 1.17 と頂点の高さから、扇の角度 4.8°・7.3°・16.5° と「高さ ÷ 奥行き」のキーを決めた)。
    # 12 コマ目から白い波縞の円盤(道)が下からせり上がる。
    n = 44
    D, Lw = 20000, 23000
    ratio = [(0, 0.0185), (2, 0.0395), (4, 0.057), (6, 0.069), (9, 0.085), (13, 0.098), (17, 0.11), (21, 0.12), (26, 0.135)]
    hk = kf(*[(f, [0, r * D, 0]) for f, r in ratio])
    t = lambda deg: Lw * math.tan(math.radians(deg))    # noqa: E731

    def wedge(a0, a1, col, dy):
        return {'geometry': 'extrude', 'points': [[0, 0], [t(a0), Lw], [t(a1), Lw]], 'depth': 0, 'rotation': [90, 0, 0], 'position': [0, dy, D - 1024],
                'material': {'type': 'basic', 'color': col, 'side': 'double'}}
    floor = {'geometry': 'group', 'position': hk, 'children': [wedge(-16.5, -4.8, '#d2283c', 0), wedge(-4.8, 0, '#8e78c0', 0), wedge(0, 7.3, '#6ab4c8', 0)]}
    wv = ctx.comp('aux:B01_waves')
    road = {'geometry': 'ring', 'inner': 0, 'outer': 4000, 'segments': 128, 'rotation': [90, 0, 0],
            'position': kf((12, [0, 4409, 2376], 'outCubic'), (26, [0, 2385, 2376]), (n, [0, 1734, 2376])),
            'material': {'type': 'basic', 'color': '#ffffff', 'side': 'double', **({'texture': {'comp_id': wv, 'frame': 0}, 'texture_repeat': [2, 2]} if wv else {})}}
    cam = layer('cam', 'camera', n, {'zoom': 1024, 'target': [960, 540, 0]}, transform={'position': [960, 540, -1024]})
    return doc('再現 B01 線路花びら 1.02', n, [
        cam, *_b01_petals(n, 21),
        layer('road', 'mesh', n, {'unlit': True, 'objects': [road]}, pos=[960, 540, 0], t0=12),
        layer('floor', 'mesh', n, {'unlit': True, 'objects': [floor]}, pos=[960, 540, 0], t1=21),
    ])


@reg(S4 + '01_線路花びら1-44/1.01/花びらのみ', 'B01', 'particles(petals)')
def b01_petals(ctx):
    n = 46
    return doc('再現 B01 線路花びら(花びらのみ)', n, _b01_petals(n, 31))


# ---------------------------------------------------------------- B02 螺旋線路
# 完成版: 紫・黄・青・赤の 4 本の帯の対数らせん(帯の幅は半径に比例 = 奥へ続く線路)が回り、白い立体の板(枕木)が手前を横切る。10 コマごとに寄りが変わる。
def _spiral_band(j, turns=2.7, r0=40, grow=4.2, d=0.36, step=5, a0=0):
    k = math.log(grow) / 360.0
    inner, outer = [], []
    a = a0          # a0 = 内側の巻きを省く角度(完成版の帯は半径 200 あたりから始まる)
    while a <= turns * 360:
        r = r0 * math.exp(k * a)
        c, s = math.cos(math.radians(a)), math.sin(math.radians(a))
        inner.append([round(r * (1 + j * d) * c, 1), round(r * (1 + j * d) * s, 1)])
        outer.append([round(r * (1 + (j + 1) * d) * c, 1), round(r * (1 + (j + 1) * d) * s, 1)])
        a += step
    return inner + outer[::-1]


@reg(S4 + '03_螺旋線路/1.01', 'B02', 'mesh(3D の面に対数らせんの帯 4 本 = extrude の points・厚み 0 を傾けて透視で)+ mesh(白い板 = box の ring 複製)+ camera')
def b02(ctx):
    n = 102
    cols = ['#5f3a6e', '#e8cf62', '#6fb5c5', '#d0283e']      # 内 → 外
    # 10 コマごとの寄り(拡大)と目の位置。回転は 1 コマ −7°
    segs = [(0, 150, [1090, 250]), (8, 210, [930, 330]), (18, 200, [900, 390]), (28, 230, [960, 390]), (38, 330, [1010, 500]), (48, 250, [900, 450]),
            (60, 300, [1150, 520]), (70, 270, [1000, 420]), (80, 240, [940, 480]), (92, 330, [1300, 560])]
    # 2 巡目: らせんは 3D の面。完成版の帯は「幅が半径に比例する対数らせん」(平らな渦の線路を斜め上から見た形)なので、
    # 対数らせんの帯 4 本を厚み 0 の押し出し(extrude の points)で 1 枚の平面に作り、group ごと傾けて(x 24°・y −16°)透視のカメラで見る。面の中で 1 コマ −7° 回る。
    # (helix の道に沿う帯 = extrude + path + path.up も試したが、巻きごとの縮み方が完成版(1 巻きで約 4 倍)と合わないので、平らな対数らせんにした)
    sk, pk = [], []
    for i, (f, sc, p) in enumerate(segs):
        f1 = segs[i + 1][0] if i + 1 < len(segs) else n
        sk += [(f, [sc * 0.0062] * 3), (f1 - 0.01, [sc * 0.0074] * 3)]
        pk += [(f, [p[0] - 960, p[1] - 540, 0]), (f1 - 0.01, [p[0] + 30 - 960, p[1] + 20 - 540, 0])]
    ribbons = [{'geometry': 'extrude', 'points': _spiral_band(j, turns=3.0, a0=320), 'depth': 0, 'position': [0, 0, j * 0.5], 'material': {'type': 'basic', 'color': cols[j], 'side': 'double'}} for j in range(4)]
    spiral = layer('spiral', 'mesh', n, {'unlit': True, 'objects': [
        {'geometry': 'group', 'position': kf(*pk), 'scale': kf(*sk), 'rotation': [24, -16, kf((0, 0), (n, -7 * n))], 'children': ribbons}]}, pos=[960, 540, 0])
    white = {'color': '#f4f4f4', 'roughness': 0.9}
    boards = _mesh('boards', n, [
        {'geometry': 'box', 'size': [900, 110, 46], 'material': white, 'rotation': [0, 0, kf((0, 0), (n, 300))],
         'instances': {'count': 5, 'seed': 2, 'layout': 'ring', 'axis': 'z', 'radius': 820, 'align': True, 'rotation_random': [25, 25, 40], 'scale': [0.7, 1.5],
                       'offset': kf((0, 0), (n, 0.9))}},
        {'geometry': 'box', 'size': [1500, 150, 60], 'material': white, 'position': [0, 0, -500],
         'instances': {'count': 3, 'seed': 5, 'layout': 'ring', 'axis': 'z', 'radius': 1100, 'align': True, 'rotation_random': [30, 30, 50], 'scale': [0.8, 1.3],
                       'offset': kf((0, 0.3), (n, -0.5))}},
    ], light={'ambient': 2.2, 'intensity': 0.9, 'direction': [-0.3, -1, -0.6]})
    cam = layer('cam', 'camera', n, {'zoom': 1024, 'target': [960, 540, 0]}, transform={'position': [960, 540, -1024]})
    return doc('再現 B02 螺旋線路', n, [cam, boards, spiral])


# ---------------------------------------------------------------- B06 桜吹雪トランジション
# 完成版: 破片(花びら)が左下から飛んできて画面を埋めつくし(単色化で桃色)、しばらく覆ったあと散っていく。
# mesh の shards(割れる板)を逆向きに使う: progress 1(散った)→ 0(1 枚の板 = 全面)→ 1。
def _shards_doc(name, n, seed, t_in0, t_full, t_out0, t_out1, count=240):
    def sh(sd, cnt, dirn, lag):
        if t_full <= 0:      # 頭から全面(散るだけ)
            prog = kf((0, 0), (t_out0 + lag, 0, 'inQuad'), (t_out1, 1), (n, 1))
        else:
            prog = kf((0, 1), (t_in0 + lag, 1, 'outQuad'), (t_full + lag, 0), (t_out0, 0, 'inQuad'), (t_out1, 1), (n, 1))
        return {'geometry': 'shards', 'size': [1940, 1100], 'count': cnt, 'seed': sd, 'depth': 0, 'progress': prog, 'stagger': 'left_to_right', 'stagger_amount': 0.55,
                'spread': 1500, 'spread_z': 500, 'direction': dirn, 'spin': 420, 'material': {'type': 'basic', 'color': '#ffffff', 'side': 'double'}}
    cam = layer('cam', 'camera', n, {'zoom': 1024, 'target': [960, 540, 0]}, transform={'position': [960, 540, -1024]})
    return doc(name, n, [cam, _mesh('shards', n, [sh(seed, count, [-1700, 900, -200], 0), sh(seed + 50, count // 2, [-1500, 1300, -300], 4)], light={'ambient': 3, 'intensity': 0})])


@reg(S4 + '08_桜吹雪トランジション/1.01', 'B06', 'mesh shards(逆再生で集まる → 散る)')
def b06(ctx):
    return _shards_doc('再現 B06 桜吹雪トランジション 1.01', 100, 11, 6, 30, 86, 100)


@reg(S4 + '08_桜吹雪トランジション/1.01/seed1', 'B06', 'mesh shards')
def b06_s1(ctx):
    return _shards_doc('再現 B06 桜吹雪トランジション seed1', 100, 21, 8, 44, 84, 100)


@reg(S4 + '08_桜吹雪トランジション/1.01/seed2', 'B06', 'mesh shards')
def b06_s2(ctx):
    return _shards_doc('再現 B06 桜吹雪トランジション seed2', 100, 31, 4, 34, 86, 100)


@reg(S4 + '08_桜吹雪トランジション/1.01/seed3', 'B06', 'mesh shards')
def b06_s3(ctx):
    return _shards_doc('再現 B06 桜吹雪トランジション seed3', 150, 41, 0, 0, 46, 124, count=420)



# ---------------------------------------------------------------- B07 タイトルパート背景(舞う箱・紙片)/ B08 線路 / B09 桜吹雪ノイズ
# 完成版(1166〜1365): 赤と緑の箱・紙片がまばらに舞う(B07)。白い波縞の道が右下から入り、画面の下で三角に落ち着く(B08。1216〜1256 は桃色の線だけ = ワイヤー)。
def _title_confetti(name, n, seed):
    red, green = '#c8283f', '#4aa862'
    tex_r = {'type': 'standard', 'color': '#ffffff', 'roughness': 0.7, 'texture': {'comp_id': PKG_COMP, 'frame': 105}, 'texture_repeat': [0.42, 0.62], 'texture_offset': [0.0, 0.0]}
    tex_g = {'type': 'standard', 'color': '#d8f0dc', 'roughness': 0.7, 'texture': {'comp_id': PKG_COMP, 'frame': 10}, 'texture_repeat': [0.5, 0.8], 'texture_offset': [0.0, 0.05]}

    def boxes(color, tex, sd, count, size, sc):
        m = {'color': color, 'roughness': 0.75}
        return {'geometry': 'box', 'size': size, 'position': [0, 0, 2200], 'material': m, 'faces': [m, m, m, m, tex or m, tex or m],
                'instances': {'count': count, 'seed': sd, 'layout': 'box', 'area': [5600, 3200, 5200], 'scale': sc, 'rotation_random': [180, 180, 180],
                              'spin': [30, 40, 20], 'spin_random': [70, 80, 50], 'velocity': [-60, 90, -120], 'velocity_random': [60, 60, 60]}}
    objs = [boxes(red, tex_r, seed, 16, [110, 172, 34], [0.6, 1.5]), boxes(green, tex_g, seed + 1, 12, [110, 172, 34], [0.6, 1.5]),
            boxes(red, None, seed + 2, 120, [60, 15, 9], [0.6, 1.5]), boxes(green, None, seed + 3, 80, [60, 15, 9], [0.6, 1.5])]
    cam = layer('cam', 'camera', n, {'zoom': 1100, 'target': kf((0, [960, 540, 2000]), (n, [1000, 520, 2600]))},
                transform={'position': kf((0, [900, 560, -1500], 'outCubic'), (60, [960, 540, -900]), (n, [1000, 520, -500]))})
    return doc(name, n, [cam, petals('pet', n, seed=seed + 9, rate=5, life=5, size=26, wind=(-70, 0, 0), gravity=(0, 70, 0), colors=('#f6c1d2', '#f4aac4')), _mesh('boxes', n, objs)])


@reg(S4 + '09_タイトルパート背景/1.02', 'B07', 'mesh(箱・紙片の instances)+ particles')
def b07(ctx):
    return _title_confetti('再現 B07 タイトルパート背景 1.02', 210, 7)


@reg(S4 + '09_タイトルパート背景/1.00', 'B07', 'mesh(箱・紙片の instances)+ particles')
def b07_100(ctx):
    return _title_confetti('再現 B07 タイトルパート背景 1.00', 210, 17)


def _track(name, n, fill, stroke=None):
    ap = layer('ap', 'null', n, transform={'position': kf((0, [1750, 880]), (24, [1500, 800]), (34, [1275, 735]), (49, [1010, 690], 'outQuad'), (74, [900, 645]), (n, [900, 640]))})
    src = {'kind': 'path', 'closed': True, 'points': [[0, 0], [-800, 450], [-800, 2400], [2600, 2400], [2600, 520]], 'fill': fill}
    if stroke:
        src.update({'stroke': stroke, 'stroke_width': 3})
    return doc(name, n, [layer('road', 'shape', n, src, parent='ap', transform={'position': [0, 0]}), ap])


@reg(S4 + '10_タイトルパート線路/1.00', 'B08', 'shape(path)+ 模様(waves)')
def b08(ctx):
    return _track('再現 B08 タイトルパート線路', 200, {'pattern': {'kind': 'stripes', 'colors': ['#ffffff', '#d2d2d6'], 'size': 46, 'angle': 90}})


@reg(S4 + '10_タイトルパート線路/1.00/ワイヤー', 'B08', 'shape(path)+ 模様(grid の線だけ)')
def b08_wire(ctx):
    return _track('再現 B08 タイトルパート線路(ワイヤー)', 200, {'pattern': {'kind': 'grid', 'colors': ['#ffffff00', '#ffffff'], 'size': 26, 'line_width': 2}}, stroke='#ffffff')


@reg(S4 + '11_タイトルパート線路の桜吹雪ノイズ/1.00', 'B09', 'particles(白い花びら = 線路に重ねる粒)')
def b09(ctx):
    n = 200
    return doc('再現 B09 線路の桜吹雪ノイズ', n, [petals('a', n, seed=71, rate=40, life=4, size=46, wind=(-120, 0, 0), gravity=(0, 150, 0), colors=('#ffffff',))])
