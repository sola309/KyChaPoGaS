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
                   parent=hid, transform={'position': dict(kf(*[(f, [0, -v + head[1]]) for f, v in length]), interp='spline')}))
    L.append(layer(hid + '_shaft', 'shape', n, {'kind': 'rect', 'width': shaft_w, 'height': 1000, 'fill': GOLD}, parent=hid,
                   transform={'anchor': [0, 500], 'position': [0, 0], 'scale': dict(kf(*[(f, [100, v / 10]) for f, v in length]), interp='spline')}))
    L.append(layer(hid, 'null', n, parent=parent, transform={'position': [0, 0], 'rotation': dict(kf(*ang), interp='spline')}))      # v13(POLISH5): 目で読んだ角度のキーの列(直線 10〜14 本)→ spline(キーのたびに回る速さが折れない)


def clock_layers(ctx, n, tree_scale):
    L = []
    pre = [(0, 765), (66, 765), (72, 615), (80, 510), (84, 450)]
    # 針(手前から 秒・分・時)
    _hand(L, n, 'sec', [(0, 0), (64, 0), (66, -3), (72, -12), (80, -30), (84, -70), (88, -128), (91, -189), (94, -255), (97, -295), (100, -324), (106, -355), (116, -372), (126, -380), (136, -386)],
          pre + [(88, 480), (94, 492), (97, 540), (100, 600), (106, 700), (116, 780), (136, 800)], (22, 80), 2.5, '#ffffff')
    _hand(L, n, 'min', [(0, 0), (64, 0), (72, -10), (80, -24), (84, -55), (88, -98), (91, -147), (94, -196), (97, -231), (100, -252), (106, -276), (116, -290), (126, -295), (136, -299)],
          pre + [(88, 470), (94, 497), (97, 543), (100, 567), (106, 618), (116, 653), (126, 666), (136, 678)], (48, 112), 3.5, '#d9344e')
    _hand(L, n, 'hour', [(0, 0), (64, 0), (80, -2), (88, -5), (91, -13), (94, -16), (97, -18), (100, -19), (106, -22), (116, -24), (136, -27)],
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
                       # v15(POLISH7): 止め(100〜132 = 884〜916)で手本は「数字が外へ広がりながら大きくなりつづけ、中心から輪が次々に広がる」(連続コマで見た)。
                       #   v14 までは数字が 110 で止まり、輪は 2 本だけで 126 に消えていた → 数字の大きさ・半径を 128 まで長い減速で動かし、輪を 6 本に(104〜122 に 6 コマおき・30 コマかけて広がる)
                       transform={'position': kf((92, [math.sin(a) * 500, -math.cos(a) * 500], 'outCubic'), (128, [math.sin(a) * 590, -math.cos(a) * 590])), 'rotation': i * 30,
                                  'scale': kf((92, [6, 8], 'inQuad'), (99, [22, 30], 'outCubic'), (128, [66, 100])), 'opacity': kf((92, 0), (96, 100))}))
    for j, (r, f0) in enumerate([(120, 98), (240, 100), (200, 104), (280, 110), (230, 116), (300, 122)]):          # 出てすぐ広がって消える輪(v15: 2 → 6 本)
        L.append(layer(f'pulse{j}', 'shape', f0 + (26 if j < 2 else 32), {'kind': 'ellipse', 'width': r * 2, 'height': r * 2, 'fill': None, 'stroke': '#ffffff', 'stroke_width': 22}, parent='face', t0=f0,
                       transform={'position': [0, 0], 'scale': kf((f0, [40, 40], 'outQuad'), (f0 + (26 if j < 2 else 32), [150, 150] if j < 2 else [190, 190])), 'opacity': kf((f0, 0), (f0 + 5, 40), (f0 + (26 if j < 2 else 32), 0))}))
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
    L.append(layer('face', 'null', n, parent='piv', transform={'position': [0, 0], 'scale': fs, 'rotation': dict(kf((88, 0), (100, -1.2), (116, -4.4), (136, -8.4), (n, -8.4)), interp='spline')}))
    # piv = 針の根元 = 文字盤の中心。zoom = 針の先(大写しの拡大の中心)
    L.append(layer('piv', 'null', n, parent='zoom', transform={'position': kf((0, [0, 765]), (66, [0, 765]), (72, [0, 615]), (80, [0, 495]), (84, [0, 420]), (88, [0, 405]),
                                                                           (132, [0, 405]), (136, [0, 435]), (146, [0, 630]), (148, [0, 735]), (152, [0, 1050]), (156, [0, 1245]), (161, [0, 1320]), (176, [0, 1365]), (216, [0, 1380]), (n, [0, 1395]))}))
    L.append(layer('zoom', 'null', n, transform={
        'position': dict(kf((0, [960, -600]), (2, [960, -100]), (4, [960, 0]), (6, [960, 30]), (8, [960, 75]), (12, [960, 90]), (20, [960, 120]), (28, [960, 135])), interp='spline'),
        # v13(POLISH5): 目で読んだ直線のキーの列 → spline(2・4・6・8 で折れない)。止め(100〜132 = 884〜916)は完全な静止だった(手本は 50 前後で動きつづける)→ ごくゆっくり引きつづける(100 → 98%)。文字盤はゆっくり左へ回りつづけ(face の rotation。完成版 905→915 で数字が約 2° 左へ回っている)、針も止めずに進める
        'scale': dict(kf((0, [1400, 1400]), (2, [470, 470]), (4, [360, 360]), (6, [220, 220]), (8, [200, 200]), (12, [160, 160]), (20, [130, 130]), (28, [100, 100]), (96, [100, 100]), (132, [106, 106]), (n, [106, 106])), interp='spline')}))      # v14(POLISH6): 止めのあいだは引き(98%)でなく寄り(106%)。手本の 886→906 は数字が大きくなっていく(引きは見まちがい)。動きの量も 5〜24 と小さかった(手本 50〜95)
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
    # v5(測った): 完成版 600〜719 は 1 コマ 8.9px の一定の流れ(v4 は 3.6px)。直線のまま、進む量を 2 倍に
    #     v5 の動画(進む量 2 倍)を測ると 1.35 倍で行き過ぎ → v4(0.49 倍)との間を取って 1.6 倍に(この値は描き出して確かめていない)
    # POLISH2 11/16: 一定の速さの流れ → 半拍ごとに「加速して、拍で抜ける」脈に。完成版 596〜724 の流れは 11 コマ周期で 6 → 18px/コマ まで上がっては落ちる(feel-kit の実測。拍とは合っていない)。
    #     形(1 周期で速さが約 3 倍まで上がって落ちる)は完成版にならい、周期は曲の半拍(12.15 コマ。拍 = ルートの 614.4 + 24.3k = この comp の 30.4)に合わせた。進む量の合計は前と同じ
    import math as _m
    # POLISH3 11/16: 脈の向きを逆に(out 型)。POLISH2 の脈は「加速しきった所が拍、拍の直後がいちばん遅い」形で、v10 を測ると速さが落ちるコマが拍の 1.6〜2.6 コマあと
    #     (拍 614.4 / 626.6 / 638.4 … に対し 616 / 629 / 641 …)= 拍で流れが止まって見える。「拍でいちばん速く、次の半拍へ向けて減速」に替えた(motion-feel 1-1・1-5: 出だしが最速、合わせるのは動き出し)。
    #     表の拍(24.3 コマ)は約 2.7 倍、裏(半拍)は約 1.8 倍の蹴り。進む量の合計は同じ。動画のコマ = ルートのコマ + 1(つなぎで頭に 1 コマ足す)なので、拍 614.4(動画)= この comp の 29.4
    P_, B0_ = 12.15, 29.4

    def _sp(f):
        u = (f + 1 - B0_) / P_
        k = int(_m.floor(u))
        return _m.exp((1.0 if k % 2 == 0 else 0.6) * (1.0 - (u - k)) ** 1.6)
    sp = [_sp(f) for f in range(n)]
    tot, acc, us = sum(sp), 0.0, [0.0]
    for v in sp:
        acc += v
        us.append(acc / tot)
    mix = lambda a, b, u: [round(x + (y - x) * u, 2) for x, y in zip(a, b)]      # noqa: E731
    cam = layer('cam', 'camera', n, {'zoom': 1100, 'target': kf(*[(f, mix([960, 540, 2400], [1023, 508, 5270], us[f])) for f in range(n + 1)])},
                transform={'position': kf(*[(f, mix([900, 560, -1500], [1123, 464, 2320], us[f])) for f in range(n + 1)])})
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


def _b01_road_keys(n):
    """道のせり上がり(12〜26 で速く、26 からは同じ速さで上がりつづける)。v12 は outCubic(26 で速さ 0)+ 直線で、26 で一度止まっていた。
    v13: 12〜26 を「終わりの速さ = あとの直線の速さ」になる 3 次(エルミート)にして 2 コマおきに焼き、26 からは直線のまま(手本は 463 から動きの量が 56 前後で一定)。"""
    p0, p1, p2 = 4409.0, 2385.0, 1734.0
    v1 = (p2 - p1) / (n - 26) * 14          # 26 での速さ(区間 14 コマあたり)
    m0 = 3 * (p1 - p0)                      # 出だしは outCubic と同じ速さ
    out = []
    for f in range(12, 27, 2):
        t = (f - 12) / 14
        y = (2 * t ** 3 - 3 * t ** 2 + 1) * p0 + (t ** 3 - 2 * t ** 2 + t) * m0 + (-2 * t ** 3 + 3 * t ** 2) * p1 + (t ** 3 - t ** 2) * v1
        out.append((f, [0, round(y, 1), 2376]))
    return out + [(35, [0, round((p1 + p2) / 2, 1), 2376]), (n, [0, p2, 2376])]


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
            # v13(POLISH5): outCubic(12〜26)のあとに直線(26〜44)をつないでいて、26 で一度止まってから等速で動き直していた → 同じ 3 点を通る spline 1 本(減速しながら止まらずに上がりつづける)
            'position': dict(kf(*_b01_road_keys(n)), interp='spline'),
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


B02_GAIN = [(9, 1.2), (41, 1.8), (42, 1.7), (47, 1.7), (48, 1.15), (53, 1.15), (54, 1.0), (62, 1.5), (70, 1.5), (84, 2.6), (101, 3.3)]      # FEEL2: 回る速さの倍率(コマ = ルート − 482)


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
    # v5(feel-kit で完成版を測った): 完成版は「10 コマごとの切り替え」ではない。切り替わりは 483・489・491・524・530・535 だけで、491〜523 と 536〜583 は切れ目のない長い 1 本。
    #     速さは 頭が速く(107px/コマ)→ 16 コマで 45 まで落ち → 終わりへ向けて 110 まで加速する(次のカットへ勢いを渡す)。
    #     → 切り替わりを実測の位置に置き、回る速さ・寄る速さを実測の速さの曲線(measured_feel.json の B02_speed)に比例させる。
    MF = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'measured_feel.json'), encoding='utf-8'))['B02_speed']
    sp = MF['v'] + [MF['v'][-1]] * 4
    cuts = [0] + MF['cuts'] + [n]
    look = [segs[0], segs[1], segs[2], segs[3], segs[5], segs[6], segs[8]]      # 1 本ごとの寄りと目の位置(v4 の 10 個から 7 個)
    # FEEL2: v5 のあとの区間描きで測ると、長い 1 本の中で再現の速さが手本より落ちていく(536〜583 で 手本比 1.0 → 0.4。終わりの加速が出ていなかった)。
    #     → 回る速さに、測った比の逆数(B02_GAIN: comp のコマ → 倍率。あいだは直線)を掛ける
    def gain(f):
        g = B02_GAIN
        for (fa, ga), (fb, gb) in zip(g, g[1:]):
            if fa <= f <= fb:
                return ga + (gb - ga) * (f - fa) / max(1, fb - fa)
        return g[-1][1] if f > g[-1][0] else g[0][1]
    sk, pk, rk = [], [], []
    ang = 0.0
    for i in range(len(cuts) - 1):
        f, f1 = cuts[i], cuts[i + 1]
        _, sc, p = look[i]
        tot = sum(sp[f:f1]) or 1.0
        grow = 1.0 + min(0.6, 0.0005 * tot)   # 寄り: 動いた量に比例(長い 1 本で 1.6 倍まで。それより寄ると、らせんの中心の穴が画面を占める = 試して戻した)
        acc = 0.0
        racc = 0.0
        ff = f
        while True:
            u = acc / tot
            last = ff >= f1 - 1
            fx = (f1 - 0.01) if last else ff
            sk.append((fx, [round(sc * 0.0062 * grow ** u, 5)] * 3))
            pk.append((fx, [round(p[0] - 960 + 60 * u, 2), round(p[1] - 540 + 40 * u, 2), 0]))
            rk.append((fx, round(ang - 0.165 * racc, 3)))
            if last:
                break
            step = min(2, f1 - 1 - ff)
            acc += sum(sp[ff:ff + step])
            racc += sum(sp[x] * gain(x) for x in range(ff, ff + step))
            ff += step
        ang -= 0.165 * racc + 47          # 切り替わりで向きも飛ぶ
    ribbons = [{'geometry': 'extrude', 'points': _spiral_band(j, turns=3.0, a0=320), 'depth': 0, 'position': [0, 0, j * 0.5], 'material': {'type': 'basic', 'color': cols[j], 'side': 'double'}} for j in range(4)]
    spiral = layer('spiral', 'mesh', n, {'unlit': True, 'objects': [
        {'geometry': 'group', 'position': kf(*pk), 'scale': kf(*sk), 'rotation': [24, -16, kf(*rk)], 'children': ribbons}]}, pos=[960, 540, 0])
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
def _shards_doc(name, n, seed, t_in0, t_full, t_out0, t_out1, count=240, out_e='inQuad', tail=0):
    def sh(sd, cnt, dirn, lag, col='#ffffff', z=0):
        if t_full <= 0:      # 頭から全面(散るだけ)
            prog = kf((0, 0), (t_out0 + lag, 0, 'inQuad'), (t_out1, 1), (n, 1))
        else:
            if False:
                pass
            else:
                prog = kf((0, 1), (t_in0 + lag, 1, 'inQuad'), (t_full + lag, 0), (t_out0, 0, out_e), (t_out1, 1), (n, 1))     # v5: 集まるのは加速しながら(完成版 1068〜1081 は inQuad。v4 は減速で、埋まるのが 8 コマ遅かった)
        return {'geometry': 'shards', 'size': [1940, 1100], 'count': cnt, 'seed': sd, 'depth': 0, 'progress': prog, 'stagger': 'left_to_right', 'stagger_amount': 0.55,
                'spread': 1500, 'spread_z': 500, 'direction': dirn, 'spin': 420, 'position': [0, 0, z], 'material': {'type': 'basic', 'color': col, 'side': 'double'}}
    cam = layer('cam', 'camera', n, {'zoom': 1024, 'target': [960, 540, 0]}, transform={'position': [960, 540, -1024]})
    # v5: 2 組目は 14 コマ遅れて集まる(完成版は 1082 で埋まったあとも 1100 まで破片が動きつづける。v4 は 4 コマ遅れで、埋まったあと止まっていた)
    objs = [sh(seed, count, [-1700, 900, -200], 0), sh(seed + 50, count // 2, [-1500, 1300, -300], 14 if t_full > 0 else 4, col='#f3f3f3' if t_full > 0 else '#ffffff', z=-30 if t_full > 0 else 0)]
    if tail:
        # v12(POLISH4): 埋まったあとの止め。完成版は 1082〜1108 のあいだも、桃色の上を薄い色の細かい破片が流れながら減っていく(動きの量 20〜100)。
        #   v11 は t_full で 1 枚の板に戻り、18 コマ完全に止まっていた。板を灰 #c4c4c4(輝度 0.767 = 単色化の桃色 #ffaaac と同じ)にし、明るい細かい破片の組を手前に流す。
        #   使う側(S04 の o484)の単色化を「輝度を保持する」にすると、板は前と同じ桃色・破片は一段明るい桃色になる(polish_align の表)。散るだけの使い方(o487)はベタ塗りのままなので変わらない
        for o in objs:
            o['material']['color'] = '#c4c4c4'
        # 2 組を半周期ずらして流す(1 組だと動きの量が手本の 1/10 だった)。どちらも左下へ 1 コマ 80px ほどで流れ、遠ざかるほど薄くなる
        for j, (t0_, sd) in enumerate(((t_full - 6, 90), (t_full + 6, 130))):
            d = sh(seed + sd, 800, [-2600, 1400, -300], 0, col='#e6e6e6', z=-70 - j * 10)
            d.update(progress=kf((0, 1), (t0_, 1, 'outQuad'), (t0_ + 5, 0.14), (t0_ + 33, 0.9), (max(t0_ + 34, t_out0), 1), (n, 1)), stagger='none', spread=1500, spin=320, scale_end=0.6, fade=0.5)
            objs.append(d)
    return doc(name, n, [cam, _mesh('shards', n, objs, light={'ambient': 3, 'intensity': 0})])


@reg(S4 + '08_桜吹雪トランジション/1.01', 'B06', 'mesh shards(逆再生で集まる → 散る)')
def b06(ctx):
    return _shards_doc('再現 B06 桜吹雪トランジション 1.01', 100, 11, 4, 20, 86, 100)


@reg(S4 + '08_桜吹雪トランジション/1.01/seed1', 'B06', 'mesh shards')
def b06_s1(ctx):
    # v5: seed1 の 85 コマ目からは 1108〜1123 で単独でも使われ、完成版ではその頭(1105〜1111)がいちばん速い(散りの途中から始まる)→ 散りを 4 コマ早く・頭を速く(outQuad)
    return _shards_doc('再現 B06 桜吹雪トランジション seed1', 100, 21, 6, 27, 80, 100, out_e='outQuad', tail=30)   # v12: 埋まるのを 1090 → 1083 に(完成版は 1081〜1082)


@reg(S4 + '08_桜吹雪トランジション/1.01/seed2', 'B06', 'mesh shards')
def b06_s2(ctx):
    return _shards_doc('再現 B06 桜吹雪トランジション seed2', 100, 31, 3, 24, 86, 100)


@reg(S4 + '08_桜吹雪トランジション/1.01/seed3', 'B06', 'mesh shards')
def b06_s3(ctx):
    return _shards_doc('再現 B06 桜吹雪トランジション seed3', 150, 41, 0, 0, 46, 124, count=420)



# ---------------------------------------------------------------- B07 タイトルパート背景(舞う箱・紙片)/ B08 線路 / B09 桜吹雪ノイズ
# 完成版(1166〜1365): 赤と緑の箱・紙片がまばらに舞う(B07)。白い波縞の道が右下から入り、画面の下で三角に落ち着く(B08。1216〜1256 は桃色の線だけ = ワイヤー)。
def _title_confetti(name, n, seed):
    red, green = '#c8283f', '#4aa862'
    tex_r = {'type': 'standard', 'color': '#ffffff', 'roughness': 0.7, 'texture': {'comp_id': PKG_COMP, 'frame': 105}, 'texture_repeat': [0.42, 0.62], 'texture_offset': [0.0, 0.0]}
    tex_g = {'type': 'standard', 'color': '#d8f0dc', 'roughness': 0.7, 'texture': {'comp_id': PKG_COMP, 'frame': 10}, 'texture_repeat': [0.5, 0.8], 'texture_offset': [0.0, 0.05]}

    def boxes(color, tex, sd, count, size, sc, zc, depth):
        m = {'color': color, 'roughness': 0.75}
        # v14(POLISH6): 流れを 2.5 倍にしても動きの量が 5 前後だった原因 = 箱・紙片が小さく遠くまばら → 手前へ浅く(奥行き 3000・中心 z 1300)・1.5 倍にした。
        # v15(POLISH7): v14 は手前(カメラから 500 以内)を通る箱が画面で 300〜500px になり、濃い赤の大きな面が六角形の飾り・白い麻の葉の線・題字のソウルジェムに重なってごちゃついた(1300 付近。ユーザー指摘)。
        #   手本は「細い紙片がたくさん + 左下を横切る淡い緑の箱 1 個」で、主役(題字・六角形)のまわりに大きな面は来ない。→ 流れ(速さ・向き)は同じまま、
        #   (1) 絵つきの箱は数を 28 → 11、奥へ(終わりのコマでもカメラから 1250 以上 = 画面で 180px 以下)、(2) 紙片は奥行きをそろえ(終わりでもカメラから 750 以上)、大きさは v13 の約 2 倍・数は 200 → 185(画面で 40〜200px。1 回目は v13 と同じ大きさで点にしか見えず流れが消えた)、
        #   (3) 手本と同じ「左下を横切る淡い緑の箱」を 1 個だけ別レイヤー(不透明度 80%)で足した(題字・六角形にはかからない道)。
        return {'geometry': 'box', 'size': size, 'position': [0, -200, zc], 'material': m, 'faces': [m, m, m, m, tex or m, tex or m],
                'instances': {'count': count, 'seed': sd, 'layout': 'box', 'area': [5600, 3200, depth], 'scale': sc, 'rotation_random': [180, 180, 180],
                              'spin': [45, 60, 30], 'spin_random': [70, 80, 50], 'velocity': [-150, 220, -300], 'velocity_random': [120, 120, 120]}}      # v13(POLISH5): 流れを 2.5 倍に。v12 は題字の止め(1244〜1254・1297〜1308)で背景の箱・紙片がほぼ動かず、動きの量 0〜1(手本は 30 前後で流れつづける)
    objs = [boxes(red, tex_r, seed, 6, [110, 172, 34], [0.8, 1.3], 2500, 1800), boxes(green, tex_g, seed + 1, 5, [110, 172, 34], [0.8, 1.3], 2500, 1800),
            boxes(red, None, seed + 2, 110, [60, 15, 9], [1.3, 2.6], 2700, 2800), boxes(green, None, seed + 3, 75, [60, 15, 9], [1.3, 2.6], 2700, 2800)]
    mg = {'color': '#8fd0a0', 'roughness': 0.8}
    hero = [{'geometry': 'box', 'size': [110, 172, 34], 'position': [-1198, 294, 2003], 'material': mg, 'faces': [mg, mg, mg, mg, tex_g, tex_g],
             'instances': {'count': 1, 'seed': seed + 5, 'layout': 'box', 'area': [0, 0, 0], 'scale': [1.5, 1.5], 'rotation': [25, 35, 15], 'spin': [22, 30, 8], 'velocity': [249, 10, -788]}}]
    # v16(POLISH7): v15 は主役のまわりは片づいたが、流れの量が v13 並み(2〜15。手本 28〜38)に戻った。大きい物を戻さずに量を上げる:
    #   (a) 手前の紙片の流れを 1.6 倍の速さに(数は同じ)、(b) 奥(カメラから 2800〜5200)にうすい紙片の層 420 枚(不透明度 45%・速さ 2 倍。遠いので画面では 15〜45px・主役より奥の地になじむ)
    for o in objs[2:]:
        o['instances']['velocity'] = [-240, 350, -480]
    far = [dict(boxes(c, None, seed + 20 + i, cnt, [60, 15, 9], [1.2, 2.2], 4300, 2600), ) for i, (c, cnt) in enumerate(((red, 250), (green, 170)))]
    for o in far:
        o['instances']['velocity'] = [-420, 520, -700]
        o['instances']['area'] = [9000, 5200, 2600]
    cam = layer('cam', 'camera', n, {'zoom': 1100, 'target': kf((0, [960, 540, 2000]), (n, [1000, 520, 2600]))},
                transform={'position': kf((0, [900, 560, -1500], 'outCubic'), (60, [960, 540, -900]), (n, [1000, 520, -500]))})
    return doc(name, n, [cam, petals('pet', n, seed=seed + 9, rate=5, life=5, size=26, wind=(-70, 0, 0), gravity=(0, 70, 0), colors=('#f6c1d2', '#f4aac4')),
                         _mesh('hero', n, hero, transform={'opacity': 80}), _mesh('boxes', n, objs), _mesh('far', n, far, transform={'opacity': 45})])


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
    # v16(POLISH7): 手本の題字の場面で大きく動いているのは「下の線路の縞が手前へ流れつづける」事だった(1290 と 1296 の差の絵で確認。麻の葉の地は動かない)。
    #   v15 までは縞が止まっていて、動きの量が 2〜15(手本 28〜38)。縞を 1 コマ 5px で手前(下)へ流す。題字・六角形には重ならない
    return _track('再現 B08 タイトルパート線路', 200, {'pattern': {'kind': 'stripes', 'colors': ['#ffffff', '#d2d2d6'], 'size': 46, 'angle': 90, 'offset': kf((0, [0, 0]), (200, [0, -1000]))}})


@reg(S4 + '10_タイトルパート線路/1.00/ワイヤー', 'B08', 'shape(path)+ 模様(grid の線だけ)')
def b08_wire(ctx):
    return _track('再現 B08 タイトルパート線路(ワイヤー)', 200, {'pattern': {'kind': 'grid', 'colors': ['#ffffff00', '#ffffff'], 'size': 26, 'line_width': 2}}, stroke='#ffffff')


@reg(S4 + '11_タイトルパート線路の桜吹雪ノイズ/1.00', 'B09', 'particles(白い花びら = 線路に重ねる粒)')
def b09(ctx):
    n = 200
    return doc('再現 B09 線路の桜吹雪ノイズ', n, [petals('a', n, seed=71, rate=40, life=4, size=46, wind=(-120, 0, 0), gravity=(0, 150, 0), colors=('#ffffff',))])
