#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""作り直し G4: S23・S26・S34・S36・S38・S40・S43 の連番(花びら・ちり・金紙など)。"""
from recreate_lib import *   # noqa: F401,F403



@reg('scene/26_楽曲タイトル直後/舞い散る桜/1.01', 'B13', 'particles(petals)')
def b13(ctx):
    n = 166
    return doc('再現 B13 舞い散る桜', n, [
        petals('near', n, seed=11, rate=5, life=4, size=90, wind=(260, 0, 0), gravity=(0, 220, 0), colors=('#ffc4d6', '#ff9fbd', '#ffe3ec')),
        petals('far', n, seed=12, rate=16, life=5, size=34, wind=(160, 0, 0), gravity=(0, 140, 0), colors=('#ffd9e4', '#ffb7cd', '#ffffff')),
    ])


@reg('scene/40_キャラ相関図/Blender_桜吹雪/1.01', 'B28', 'particles(petals)')
def b28(ctx):
    # シーンでは 186% + 単色化(ffaaac)で、カメラの下に置かれる。カメラが相関図の上を大きく動いても花びらが画面を覆い続けるので、
    # 元の連番は 4K(3840×2160)だったと見積もる(1024×576 だと 5470 コマ以降に画面から外れた)
    n = 206
    w, h = 3840, 2160
    ar, ps = (w * 1.15, h * 1.3, 0), (w / 2 - 80, h / 2 - 200)
    return doc('再現 B28 桜吹雪(相関図)', n, [
        petals('a', n, seed=31, rate=380, life=6, size=27, wind=(30, 0, 0), gravity=(0, 45, 0), colors=('#ffffff',), flutter=260, area=ar, pos=ps),
        petals('b', n, seed=32, rate=90, life=6, size=52, wind=(50, 0, 0), gravity=(0, 60, 0), colors=('#ffffff',), flutter=200, area=ar, pos=ps),
        petals('c', n, seed=33, rate=10, life=5, size=120, wind=(70, 0, 0), gravity=(0, 80, 0), colors=('#ffffff',), flutter=160, area=ar, pos=ps),
    ], w=w, h=h)


@reg('scene/34_咲き誇れ/Blender_桜吹雪/1.04', 'B24', 'particles(petals)')
def b24(ctx):
    # シーンでは 64% + 左右反転 + ぼかし 3 で置かれる → 元の連番は 3000×1688 と見積もる
    n = 90
    w, h = 3000, 1688
    return doc('再現 B24 桜吹雪(咲き誇れ)', n, [
        petals('a', n, seed=41, rate=55, life=4, size=72, wind=(-260, 0, 0), gravity=(0, 220, 0), colors=('#fff3f6', '#ffdfe8', '#ffffff', '#ffd0dd'),
               area=(w * 1.2, h * 1.2, 0), pos=(w / 2, h / 2), flutter=300),
        petals('b', n, seed=42, rate=3, life=3, size=210, wind=(-420, 0, 0), gravity=(0, 380, 0), colors=('#ffd3df', '#ffe3ec'),
               area=(w * 1.2, h * 1.2, 0), pos=(w / 2, h / 2), flutter=200),
    ], w=w, h=h)


def _gold(name, seed):
    n = 94
    em = {'preset': 'confetti', 'sprite': 'rect', 'blend': 'normal', 'position': [0, 0, 0], 'emit': 'box', 'area': [2300, 1300, 0], 'rate': 9, 'life': 5,
          'size': [20, 20], 'size_random': 0.5, 'speed': 30, 'wind': [-40, 0, 0], 'gravity': [0, 90, 0], 'flutter': 420, 'spin': 160,
          'colors': ['#d9a520', '#f0c53a', '#c58f12', '#ffe07a'], 'opacity': [100, 100]}
    return doc(name, n, [layer('gold', 'particles', n, {'seed': seed, 'emitter': em}, pos=[960, 540], t0=-300)])


@reg('scene/34_咲き誇れ/Blender_金紙舞い散る/1.00-1', 'B23a', 'particles(confetti・金)')
def b23a(ctx):
    return _gold('再現 B23 金紙舞い散る 1', 71)


@reg('scene/34_咲き誇れ/Blender_金紙舞い散る/1.00-2', 'B23b', 'particles(confetti・金)')
def b23b(ctx):
    return _gold('再現 B23 金紙舞い散る 2', 72)


@reg('still:_ext/D/CloudData/GoogleDrive/MAD/魔法少女まどか☆マギカ/杏子整理/背景/bg.jpg', 'P04a', '仮の板(白地に淡い色の水玉)', placeholder=True)
def p04a(ctx):
    # 元絵が要る: 白地にパステルの水玉がちらばる背景(S34 4580-4667。124% + 左右反転 + ぼかし 5)
    w, h = 1920, 1080
    L = []
    for i, (col, cnt, sz, sd) in enumerate([('#f29cc2', 40, 120, 81), ('#b5d640', 26, 130, 82), ('#7fb6de', 32, 120, 83), ('#f0e070', 32, 110, 84), ('#f7c9dc', 40, 70, 85), ('#c9d3de', 14, 160, 86)]):
        em = {'sprite': 'circle', 'blend': 'normal', 'position': [0, 0, 0], 'emit': 'box', 'area': [w, h, 0], 'rate': 0, 'burst': cnt, 'life': 60,
              'speed': 0, 'size': [sz, sz], 'size_random': 0.75, 'color': col, 'opacity': [88, 88], 'fade_in': 0}
        L.append(layer(f'd{i}', 'particles', 1, {'seed': sd, 'emitter': em}, pos=[w / 2, h / 2], t0=-2))
    L.append(layer('white', 'solid', 1, {'color': '#ffffff', 'width': w, 'height': h}, pos=[w / 2, h / 2]))
    return doc('仮の板 P04 bg.jpg(水玉の背景)', 1, L, w=w, h=h)


@reg('scene/38_えちえち杏子ちゃん/Blender_空気中チリ/1.02', 'B26', 'particles(dust・ぼけた光の粒)')
def b26(ctx):
    n = 103
    em = {'preset': 'dust', 'blend': 'normal', 'emit': 'box', 'area': [2200, 1200, 0], 'rate': 14, 'life': 4, 'size': [70, 70], 'size_random': 0.8,
          'speed': 24, 'turbulence': {'amp': 60, 'freq': 0.25}, 'color': '#ffffff', 'opacity': [0, 55, 55, 0]}
    return doc('再現 B26 空気中のちり', n, [layer('dust', 'particles', n, {'seed': 51, 'emitter': em}, pos=[960, 540], t0=-240)])


@reg('scene/39_筆記後エフェクト/Blender_筆記エフェクト/1.00', 'B27', 'particles(筆の跡を追うきらめき)')
def b27(ctx):
    # S38 では 10 倍速(5097-5152 = 連番の 1〜560 番)。「杏子ちゃんとポッキーゲームしたい」(-5° 傾き・x 190→1570)を書く筆先を追って赤いきらめきが尾を引く
    n = 560
    pts = []
    for i in range(0, 38):
        f = i * 15
        x = 160 + 2.6 * f + 90 * math.cos(i * 1.6)
        y = 830 + (804 - x) * 0.0875 + 75 * math.sin(i * 1.6)
        pts.append((f, [round(x), round(y), 0]))
    em = {'preset': 'sparks', 'sprite': 'soft', 'blend': 'normal', 'emit': 'box', 'area': [40, 40, 0], 'position': kf(*pts), 'rate': 420, 'life': 1.8, 'life_random': 0.5,
          'size': [15, 5], 'size_random': 0.8, 'speed': 22, 'spread': 360, 'gravity': [0, 6, 0], 'drag': 0.5, 'colors': ['#e8324a', '#ff6f86', '#ffb3c0', '#d81e3a'], 'opacity': [100, 80, 0]}
    return doc('再現 B27 筆記エフェクト', n, [layer('sp', 'particles', n, {'seed': 61, 'emitter': em}, pos=[0, 0])])


# ---- V06: scene27 網目模様(麻の葉)の書き出し AVI。いまのシーン 27 は別物(0-36 コマの円の模様)なので模様で作る ----
def _asanoha(name, bg, line):
    n = 163
    return doc(name, n, [
        layer('asa', 'pattern', n, {'kind': 'asanoha', 'colors': [bg, line], 'size': 118, 'angle': 90, 'line_width': 2.2,
                                    'width': W, 'height': H}, pos=[W / 2, H / 2]),
    ], bg=bg)


@reg('scene/27_網目模様背景動画/scene27_0.14_朱色.avi', 'V06a', 'pattern(asanoha)')
def v06a(ctx):
    return _asanoha('再現 V06 網目模様 朱色', '#fda092', '#ffd5c3')


@reg('scene/27_網目模様背景動画/scene27_0.14_黄色.avi', 'V06b', 'pattern(asanoha)')
def v06b(ctx):
    return _asanoha('再現 V06 網目模様 黄色', '#f2d778', '#fbeeb4')


# ---- B25: ポッキーゲーム 1.11(247 コマ = ルートの 5183〜5429)。箱が飛び込み、開いて銀の袋から 1 本出て、
#      カメラが棒に寄り、後半は 3D モデルの杏子(パーカー)がくわえる。箱・袋・棒は mesh、杏子は仮: マネキン(mesh の mannequin)----
def sh(id, n, kind, w, h, fill, pos, rot=0, **src):
    s = {'kind': kind, 'width': w, 'height': h, 'fill': fill}
    s.update(src)
    return layer(id, 'shape', n, s, transform={'position': list(pos), 'rotation': [0, 0, rot]})


@reg('aux:B25_chara', 'B25c', '仮: マネキン(mesh の mannequin。パーカー姿の横顔・右手を口もとへ・ポニーテールが後ろへなびく)。元絵 = 3D モデルの杏子', placeholder=True)
def b25c(ctx):
    # 元は パーカー姿の杏子の 3D モデル(横顔〜斜め。ポッキーをくわえ、右手を添える)。口 = (760, 520)・頭の中心 ≈ (560, 380)・頭の高さ ≈ 450(1 巡目の影絵と同じ目印)
    n = 170
    w, h = 1400, 1800
    HH, HEADS = 450, 5.6
    Hh = HH * HEADS

    def sw(amp, ph=0.0, base=0.0, per=64):
        return {'k': [dict(f=f, v=round(base + amp * math.sin(2 * math.pi * (f / per + ph)), 3)) for f in range(0, n + 8, 8)]}
    fig = {'geometry': 'mannequin', 'position': [0, 0, 0], 'rotation': [0, 60, 0], 'body': {'height': Hh, 'heads': HEADS, 'thickness': 0.95, 'shoulder': 0.95},
           'colors': {'skin': '#f7dcc8', 'hair': '#a5324c', 'ribbon': '#2a2226', 'eyes': '#8a2030', 'top': '#8fa695', 'bottom': '#55698f'},
           'hair': {'style': 'ponytail', 'length': 0.5, 'thickness': 1.1}, 'outfit': {'sleeves': 1, 'pants': 0.1},
           'outline': {'width': 5, 'color': '#4a2a34'}, 'material': {'type': 'toon', 'toon_steps': 3}, 'preset': 'stand',
           'pose': {'shoulder_r': [70, 20, 6], 'elbow_r': [95, 0], 'hand_r': 'fist', 'head': [sw(1.5, 0.2, -4), sw(2, 0.0), 0], 'chest': [sw(1.0, 0.3, 2), 0, 0],
                    'pony_1': [sw(5, 0.0, 14), sw(4, 0.3), 0], 'pony_2': [sw(7, 0.15, 22), sw(5, 0.45), 0], 'pony_3': [sw(9, 0.3, 14), sw(6, 0.6), 0]}}   # 髪は風で後ろへなびく
    L = [
        layer('stick', 'shape', n, {'kind': 'line', 'points': [[0, 0], [150, 30]], 'stroke': '#5a3327', 'stroke_width': 7, 'cap': 'round', 'fill': None}, pos=[736, 500]),
        layer('fig', 'mesh', n, {'light': {'ambient': 1.5, 'intensity': 1.3, 'direction': [-0.4, -0.8, -1]}, 'objects': [fig]}, pos=[560, 380 - HH / 2 + Hh, 0]),
    ]
    return doc('仮: マネキン B25 杏子(3D モデルの代わり)', n, L, w=w, h=h)


@reg('scene/38_えちえち杏子ちゃん/Blender_ポッキーゲーム/1.11', 'B25', 'mesh(箱・袋・棒)+ 仮: マネキン(杏子)+ particles')
def b25(ctx):
    n = 247
    red, silver, choco, bisc = '#d8141f', '#b9b9b9', '#55301f', '#c98d4d'
    tex = {'comp_id': scene_comps().get('48', 55), 'frame': 130}     # S48 のパッケージの展開図(130 コマ目 = 赤いロッキー)
    front = {'color': '#ffffff', 'roughness': 0.6, 'texture': dict(tex), 'texture_repeat': [0.235, 0.66], 'texture_offset': [0.0, 0.0]}
    back = {'color': '#ffffff', 'roughness': 0.6, 'texture': dict(tex), 'texture_repeat': [0.235, 0.66], 'texture_offset': [0.235, 0.0]}
    plain = {'color': red, 'roughness': 0.6}
    stick = {'geometry': 'group', 'position': [40, kf((20, -120), (48, -560, 'outCubic'), (70, -640)), 0], 'rotation': [0, 0, kf((20, 0), (48, 6))], 'children': [
        {'geometry': 'cylinder', 'radius': 9, 'height': 430, 'position': [0, -30, 0], 'material': {'color': choco, 'roughness': 0.45}},
        {'geometry': 'cylinder', 'radius': 8, 'height': 90, 'position': [0, 230, 0], 'material': {'color': bisc, 'roughness': 0.8}},
    ]}
    inner = [{'geometry': 'cylinder', 'radius': 8, 'height': 300, 'position': [-70 + i * 28, -150, (i % 2) * 14 - 7], 'material': {'color': choco, 'roughness': 0.5}} for i in range(6)]
    pack = {'geometry': 'group',
            'position': kf((0, [300, 430, 0]), (13, [450, 170, 0], 'outCubic'), (23, [430, 110, 0], 'outCubic'), (45, [430, 110, 0]), (55, [950, -780, 0], 'inOutCubic'),
                           (66, [-1500, -2700, 0], 'inOutCubic')),
            'rotation': kf((0, [55, -10, -125]), (13, [38, -12, -100], 'outCubic'), (23, [28, -18, -68], 'outCubic'), (45, [28, -18, -68]), (55, [22, -22, -122], 'inOutCubic'),
                           (66, [14, -14, -225], 'inOutCubic')),
            'scale': kf(*[(f, [v, v, v]) + tuple(e) for f, v, *e in [(0, 1.7), (13, 2.0, 'outCubic'), (23, 2.2, 'outCubic'), (45, 2.2), (55, 3.2, 'inOutCubic'), (66, 6.0, 'inOutCubic')]]),
            'children': [
                {'geometry': 'box', 'size': [300, 540, 90], 'material': plain, 'faces': [plain, plain, {'color': '#8d8d8d', 'roughness': 0.9}, plain, front, back]},
                {'geometry': 'box', 'size': [262, 300, 62], 'position': [0, kf((16, -130), (24, -300, 'outCubic')), 0], 'material': {'color': silver, 'metalness': 0.5, 'roughness': 0.45}},
                {'geometry': 'box', 'size': [262, 150, 60], 'position': [0, kf((16, -130), (24, -240, 'outCubic')), 2], 'material': {'color': '#c5141c', 'roughness': 0.5}},
                {'geometry': 'box', 'size': [300, 170, 5], 'position': [0, kf((14, -272), (22, -330, 'outCubic')), kf((14, 44), (22, 120, 'outCubic'))],
                 'rotation': [kf((14, 0), (22, -58, 'outCubic')), 0, 0], 'material': {'color': '#f1ece3', 'roughness': 0.9}},
                stick] + inner}
    L = [
        petals('pt', n, seed=91, rate=16, life=5, size=34, wind=(-90, 0, 0), gravity=(0, 90, 0), colors=('#ffc3d2', '#ffd9e2', '#ffb1c6'), flutter=300, pre=-80),
        layer('charaB', 'comp', n, {'comp_id': ctx.comp('aux:B25_chara'), 'transparent': True}, t0=101,
              transform={'anchor': [60, -380, 0], 'position': kf((101, [930, 470, 0]), (150, [975, 465, 0]), (177, [1100, 610, 0], 'inOutCubic'), (246, [1110, 600, 0])),
                         'scale': kf((101, [60, 60]), (150, [62, 62]), (177, [118, 118], 'inOutCubic'), (246, [120, 120]))}),
        layer('charaA', 'comp', n, {'comp_id': ctx.comp('aux:B25_chara'), 'transparent': True}, t0=81, t1=101,
              transform={'anchor': [60, -380, 0], 'position': kf((81, [380, 340, 0]), (85, [400, 350, 0]), (93, [880, 520, 0], 'inOutCubic'), (100, [875, 522, 0])),
                         'scale': kf((81, [715, 715]), (85, [690, 690]), (93, [150, 150], 'inOutCubic'), (100, [147, 147])),
                         'rotation': kf((81, [0, 0, 3]), (93, [0, 0, 0]))}),
        layer('macro', 'shape', n, {'kind': 'rect', 'width': 3200, 'height': 180, 'radius': 90,
                                    'fill': {'gradient': {'angle': 90, 'stops': [[0, '#6b3f2c'], [0.45, '#55301f'], [1, '#2e1810']]}}}, t0=64, t1=81,
              transform={'position': kf((64, [820, 420, 0]), (73, [960, 540, 0], 'outCubic'), (80, [990, 550, 0])),
                         'rotation': kf((64, [0, 0, 62]), (73, [0, 0, 26], 'outCubic'), (80, [0, 0, 20])),
                         'scale': kf((64, [100, 35]), (73, [100, 100], 'outCubic'), (80, [100, 28]))}),
        layer('pack', 'mesh', n, {'light': {'ambient': 1.1, 'intensity': 1.6, 'direction': [-0.4, -0.8, -1]}, 'env': 'soft', 'objects': [pack]}, pos=[960, 540], t1=66),
    ]
    return doc('再現 B25 ポッキーゲーム 1.11', n, L)


@reg('still:_ext/D/CloudData/GoogleDrive/MAD/魔法少女まどか☆マギカ/杏子整理/背景/bg[1] (4).jpg', 'P05a', '仮の板(桃色のグラデーション + 白い帯)', placeholder=True)
def p05a(ctx):
    # 元絵が要る: 桃色の空に白い街並みの影絵ときらめきの背景(S38 5149-5259。100%)
    w, h = 1920, 1080
    return doc('仮の板 P05 bg[1] (4).jpg(桃色の背景)', 1, [
        layer('band', 'solid', 1, {'color': '#ffffff', 'width': w, 'height': 150}, pos=[w / 2, 520], transform={'opacity': 70},
              effects=[{'type': 'blur', 'params': {'radius': 40}}]),
        layer('bg', 'solid', 1, {'width': w, 'height': h, 'fill': {'gradient': {'angle': 90, 'stops': [[0, '#f5b0be'], [0.45, '#fbd9df'], [0.62, '#f8c6d2'], [1, '#f2a3c0']]}}}, pos=[w / 2, h / 2]),
    ], w=w, h=h)


@reg('still:_ext/D/CloudData/GoogleDrive/MAD/魔法少女まどか☆マギカ/杏子整理/1111制作素材/08_祝聖_静止画素材/静画素材/75-1.png', 'P05b', '仮の板(立ち姿の影絵)', placeholder=True)
def p05b(ctx):
    # 元絵が要る: 障子に映る影になる立ち絵(S38 4984-5049。78% + 単色化(黒 62%) + ぼかし 30 + 透明度 100→50)
    w, h = 900, 1400
    c = '#6a5560'
    return doc('仮の板 P05 75-1.png(立ち姿)', 1, [
        sh('head', 1, 'ellipse', 330, 330, c, (450, 260)),
        sh('tail', 1, 'ellipse', 200, 620, c, (240, 520), 12),
        sh('body', 1, 'rect', 360, 620, c, (450, 720), 0, radius=120),
        sh('skirt', 1, 'pie', 620, 620, c, (450, 900), 0, start=110, end=250),
        sh('legs', 1, 'rect', 220, 420, c, (450, 1180), 0, radius=40),
    ], w=w, h=h)
