#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""作り直し G4: S23・S26・S34・S36・S38・S40・S43 の連番(花びら・ちり・金紙など)。"""
import os
from recreate_lib import *   # noqa: F401,F403
from recreate_lib import kfa as kf   # noqa: F811  この組のキーは「着くまでの加減速を着地のキーに書く」流儀(v4 まで 1 区間ずれて直線で動いていた)



@reg('scene/26_楽曲タイトル直後/舞い散る桜/1.01', 'B13', 'particles(petals)')
def b13(ctx):
    n = 166
    return doc('再現 B13 舞い散る桜', n, [
        petals('near', n, seed=11, rate=5, life=4, size=90, wind=(260, 0, 0), gravity=(0, 220, 0), colors=('#ffc4d6', '#ff9fbd', '#ffe3ec')),
        petals('far', n, seed=12, rate=16, life=5, size=34, wind=(160, 0, 0), gravity=(0, 140, 0), colors=('#ffd9e4', '#ffb7cd', '#ffffff')),
    ])


B28_GUST = (650, 1250, 1800)      # 頭の突風で流す量(小・中・大の花びらの層。comp の px。シーンでは 186% で置かれる)


@reg('scene/40_キャラ相関図/Blender_桜吹雪/1.01', 'B28', 'particles(petals)')
def b28(ctx):
    # シーンでは 186% + 単色化(ffaaac)で、カメラの下に置かれる。カメラが相関図の上を大きく動いても花びらが画面を覆い続けるので、
    # 元の連番は 4K(3840×2160)だったと見積もる(1024×576 だと 5470 コマ以降に画面から外れた)
    n = 206
    w, h = 3840, 2160
    ar, ps = (w * 1.15, h * 1.3, 0), (w / 2 - 80, h / 2 - 200)
    L = [
        petals('a', n, seed=31, rate=380, life=6, size=27, wind=(30, 0, 0), gravity=(0, 45, 0), colors=('#ffffff',), flutter=260, area=ar, pos=ps),
        petals('b', n, seed=32, rate=90, life=6, size=52, wind=(50, 0, 0), gravity=(0, 60, 0), colors=('#ffffff',), flutter=200, area=ar, pos=ps),
        petals('c', n, seed=33, rate=10, life=5, size=120, wind=(70, 0, 0), gravity=(0, 80, 0), colors=('#ffffff',), flutter=160, area=ar, pos=ps),
    ]
    # FEEL2: 完成版の 5372〜5430 は花びらが速く左へ流れ(速い画素で 46 → 34 → 18 px/コマ)、60 コマほどで落ち着く。v5 は頭から同じ速さ(11 px/コマ)だった
    #   → 層ごと右から左へ流して減速させる(大きい花びらほど大きく = 手前ほど速い)
    for lay, dx in zip(L, B28_GUST):
        lay['transform']['position'] = kf((0, [ps[0] + dx, ps[1] - dx * 0.2, 0]), (95, [ps[0], ps[1], 0], 'outCubic'))
    return doc('再現 B28 桜吹雪(相関図)', n, L, w=w, h=h)


@reg('scene/34_咲き誇れ/Blender_桜吹雪/1.04', 'B24', 'particles(petals)')
def b24(ctx):
    # シーンでは 64% + 左右反転 + ぼかし 3 で置かれる → 元の連番は 3000×1688 と見積もる
    n = 90
    w, h = 3000, 1688
    return doc('再現 B24 桜吹雪(咲き誇れ)', n, [
        # v16(POLISH7): 花びらが白〜ごくうすい桃色で、白っぽい背景の上では見えず、止め(4634〜4652)が静止に見えた(動きの量 2〜10・手本 25〜40)→ 桃色を濃く
        petals('a', n, seed=41, rate=55, life=4, size=72, wind=(-260, 0, 0), gravity=(0, 220, 0), colors=('#ffc2d2', '#ffa9c0', '#ffd9e3', '#ff96b2'),
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


_B25_SIDE = find_puppet('A', 'side')      # 横顔のパペット(担当 KEY が作れば表に入る)。無ければマネキン


def _b25c_puppet():
    """横顔の 2D の立ち絵 + パーツ分解。目印(1 巡目と同じ): 頭の中心 ≈ (560, 380)・頭の高さ ≈ 450・口 = (760, 520)。髪は風で後ろ(左)へなびく。
    出せない物: ポッキーを持つ手の動き・顔の向きの変化(絵のまま)。"""
    n, w, h = 170, 1400, 1800
    g = _B25_SIDE
    hc = [560, 380]
    if g['puppet_id'] == 'sakura_A_profile2':      # v4: 腰までの横顔(顔の層が無い 2 層のパペット)。頭の中心・高さは絵から測った値。口が目印 (760, 520) に来るように置く
        g = dict(g, head=[1040, 395], head_h=230)
        # v14(POLISH6): 寄りの大写し(5364〜5428)でパペットの絵 1 画素が画面の 3.7 画素に伸びて粗かった → 2.5 倍(3200 角)に拡大した版 sakura_A_profile2_hr
        #   (POLISH6/mk_puppet_hr.py。座標は全部 2.5 倍なので、頭の位置・高さも 2.5 倍で渡すと同じ置き方になる)
        if os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../backend/data/puppets/sakura_A_profile2_hr/manifest.json')):
            g = dict(g, puppet_id='sakura_A_profile2_hr', head=[1040 * 2.5, 395 * 2.5], head_h=230 * 2.5, canvas=[3200, 3200])
        hc = [672 + 800, 334]
        w = 3000                                    # 左へ長くなびくポニーテールが切れないように comp を左右に 800 ずつ広げる(中心からの位置は同じ)
    L = [puppet_layer('fig', n, g, hc, 450, seed=2, wind=-0.9, sway=3.2, turn=0.08)]      # v17: 髪のゆれ 1.5 → 3.2(手本の余韻 5302〜5325 は 2 コマの差の絵でポニーテール全体が大きく動いている。こちらは人物がほぼ止まっていた)
    return doc(f'仮: 2D 立ち絵 + 分解 B25 杏子の横顔({g["puppet_id"]})', n, L, w=w, h=h)


@reg('aux:B25_chara', 'B25c', (f'仮: 2D の横顔の立ち絵 + パーツ分解(puppet {_B25_SIDE["puppet_id"]}。新しく生成した絵・ユーザー未確認)。髪が風で後ろへなびく・呼吸・まばたき。手の動き・顔の向きは絵のまま' if _B25_SIDE else
     '仮: マネキン(mesh の mannequin。パーカー姿の横顔・右手を口もとへ・ポニーテールが後ろへなびく)。元絵 = 3D モデルの杏子' + ('' if PEOPLE == 'mannequin' else '。横顔のパペットがまだ無いのでマネキンのまま')), placeholder=True)
def b25c(ctx):
    if _B25_SIDE:
        return _b25c_puppet()
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
           'face': False, 'outline': {'width': 5, 'color': '#4a2a34'}, 'material': {'type': 'toon', 'toon_steps': 3}, 'preset': 'stand',
           'pose': {'shoulder_r': [70, 20, 6], 'elbow_r': [95, 0], 'hand_r': 'fist', 'head': [sw(1.5, 0.2, -4), sw(2, 0.0), 0], 'chest': [sw(1.0, 0.3, 2), 0, 0],
                    'pony_1': [sw(5, 0.0, 14), sw(4, 0.3), 0], 'pony_2': [sw(7, 0.15, 22), sw(5, 0.45), 0], 'pony_3': [sw(9, 0.3, 14), sw(6, 0.6), 0]}}   # 髪は風で後ろへなびく
    L = [
        layer('stick', 'shape', n, {'kind': 'line', 'points': [[0, 0], [150, 30]], 'stroke': '#5a3327', 'stroke_width': 7, 'cap': 'round', 'fill': None}, pos=[736, 500]),
        layer('fig', 'mesh', n, {'light': {'ambient': 1.5, 'intensity': 1.3, 'direction': [-0.4, -0.8, -1]}, 'objects': [fig]}, pos=[560, 380 - HH / 2 + Hh, 0]),
    ]
    return doc('仮: マネキン B25 杏子(3D モデルの代わり)', n, L, w=w, h=h)


# FEEL2: B25 の動きの実測(完成版のコマを目で見て測った数だけ。絵は使っていない)。コマ = comp の中のコマ(ルートのコマ − 5183)
B25_PUSH = (40, 64, 0.25)                                            # 寄りの始まり・終わり・道の折れ目(A→B が全体のどこまでか)
B25_PACK = ([430, 110, 0], ([800, -520, 0], [24, -21, -105], 2.9), ([-1500, -2650, 0], [16, -15, -195], 5.0))   # 寄りの途中(B)と終わり(C)の 位置・回転・拡大
# v13(POLISH5): C を [-750, -1950] → [-1500, -2650]。v12 は寄りの終わり(5240〜5249)に銀の袋の白い面が画面のまん中を覆ったまま 5250 で箱ごと 1 コマで消えていた
#   (手本は 5246 で箱が左上へ抜け、棒だけが残る)。箱が左上の外へ抜けきるまで寄る
B25_CHARA = [(81, 900, 60, 170), (82, 690, 192, 230), (84, 490, 422, 361), (87, 300, 634, 453), (91, 239, 768, 484), (95, 151, 852, 499), (99, 106, 883, 518),
             (102, 86, 891, 526), (106, 70, 914, 522), (110, 61, 922, 530), (117, 45, 925, 548)]      # (コマ, 拡大 %, 口の x, 口の y)。コマ = ルート − 5183
# 終わりの寄り(完成版 5330〜5367 の頭の大きさと口の位置を 10 コマおきに見て測った): 145 から動きだし、10 コマで約 1.7 倍の調子で加速しつづけ、
#   止まる前に 5367(184)で次のシーンに覆われる。v5 は 152〜187 で 37 → 104%(手本は 177 で 105%・184 で 150%)と遅かった
B25_CLOSE = [(145, 37, 959, 554), (157, 43, 935, 595), (167, 62, 1037, 670), (177, 105, 1075, 734), (184, 150, 1130, 770), (190, 185, 1150, 780), (246, 200, 1160, 785)]      # v12 まで(位置はこのまま使う)
# v13(POLISH5): 拡大だけ測り直した(連続コマで頭の大きさを手本と並べた)。v12 は横顔のパペットの頭が手本の 0.7〜0.9 倍で、切り替わり(5371)まで加速しつづけていた。
#   手本は 5355〜5362 が最速で、5364 からは頭の大きさがほぼ変わらない(速さ 136 → 41 と減速して次のシーンに覆われる)→ 寄りを 1.1〜1.35 倍にし、181 から減速して止まりかける形に。
#   引き(〜145)から寄りへの折り返しは、位置(145)と拡大(150)で 5 コマずらした(同じコマで両方が止まると 5328 前後が完全な静止になる)
B25_CLOSE_S = [(150, 38), (158, 52), (167, 84), (174, 122), (179, 150), (183, 168), (187, 178), (192, 184), (246, 192)]
B25_MACRO_S = [(64, 38), (67, 53), (70, 80), (74, 140), (76, 200), (77, 198), (78, 185), (79, 130), (80, 74)]      # v17: 引きを 1 コマ早く(77〜81 → 76〜80)。山が手本(5263〜5264)より 1 コマ遅かった
B25_MACRO_POS = [(64, 860, 450), (70, 925, 505), (76, 985, 548), (77, 800, 480), (78, 417, 373), (79, 107, 279), (80, -23, 183)]


@reg('scene/38_えちえち杏子ちゃん/Blender_ポッキーゲーム/1.11', 'B25', 'mesh(箱・袋・棒)+ 仮: マネキン(杏子)+ particles')
def b25(ctx):
    n = 247
    red, silver, choco, bisc = '#d8141f', '#b9b9b9', '#55301f', '#c98d4d'
    tex = {'comp_id': scene_comps().get('48', 55), 'frame': 130}     # S48 のパッケージの展開図(130 コマ目 = 赤いロッキー)
    front = {'color': '#ffffff', 'roughness': 0.6, 'texture': dict(tex), 'texture_repeat': [0.235, 0.66], 'texture_offset': [0.0, 0.0]}
    back = {'color': '#ffffff', 'roughness': 0.6, 'texture': dict(tex), 'texture_repeat': [0.235, 0.66], 'texture_offset': [0.235, 0.0]}
    plain = {'color': red, 'roughness': 0.6}
    # FEEL2(完成版 5184〜5300 を 1 コマずつ測り直した。数だけ): 元は Blender のカメラ 1 本の動き = 箱が飛び込む(2〜21。3 コマ目がいちばん速く、長く尾を引く)→
    #   ふた・袋・棒が 20〜25 で一気に出る → 40 から寄りはじめ、52〜74 は同じ速さで寄りつづけ(止まらない)→ 77〜81 で棒に沿って一気に引き(79 が山)→
    #   そのまま 81〜116 を 1 コマあたり約 0.93〜0.95 倍の同じ調子で引きつづける(指数の減衰)。v5 は 13・23・55・66・93・101 で止まる階段だった。
    stick = {'geometry': 'group', 'position': [40, kf((20, -120), (25, -560, 'outCubic'), (40, -575)), 0], 'rotation': [0, 0, kf((20, 0), (25, 6, 'outCubic'))], 'children': [
        {'geometry': 'cylinder', 'radius': 9, 'height': 430, 'position': [0, -30, 0], 'material': {'color': choco, 'roughness': 0.45}},
        {'geometry': 'cylinder', 'radius': 8, 'height': 90, 'position': [0, 230, 0], 'material': {'color': bisc, 'roughness': 0.8}},
    ]}
    inner = [{'geometry': 'cylinder', 'radius': 8, 'height': 300, 'position': [-70 + i * 28, -150, (i % 2) * 14 - 7], 'material': {'color': choco, 'roughness': 0.5}} for i in range(6)]

    def push(A, B, C, f0=B25_PUSH[0], f1=B25_PUSH[1], brk=B25_PUSH[2]):
        """寄り: 前半で速さが 0 から上がり、後半は同じ速さ(完成版の速さの曲線の形)。道は A → B → C。2 コマおきの密なキー"""
        out = []
        for f in range(f0, f1 + 1, 2):
            t = (f - f0) / (f1 - f0)
            u = 1.3333 * t * t if t < 0.5 else 0.3333 + 1.3333 * (t - 0.5)
            a, b, w = (A, B, u / brk) if u < brk else (B, C, (u - brk) / (1 - brk))
            out.append((f, [round(x + (y - x) * w, 3) for x, y in zip(a, b)]))
        return out
    PA, PB, PC = B25_PACK

    def land(A, B, f0=1, f1=14, f2=30):
        """飛びこみ(v16・2 回目): 頭が最速で 14 コマまでにほぼ着く速い成分(outQuint・6 割)+ 30 コマ目まで尾を引く遅い成分(outQuad・4 割)を 1 コマごとに焼く。
        1 回目(着地を 21 → 26 に延ばした outQuint 1 本)は尾は付いたが頭の山が 422 → 342 に下がった(手本 557)。v15 の outQuint(21)は 5200〜5204 が 2〜10 で死んでいた(手本 26〜54)"""
        out = []
        for f in range(f0, f2 + 1):
            a = min(1.0, (f - f0) / (f1 - f0)); b = (f - f0) / (f2 - f0)
            u = 0.6 * (1 - (1 - a) ** 5) + 0.4 * (1 - (1 - b) ** 2)
            out.append((f, [round(x + (y - x) * u, 3) for x, y in zip(A, B)]))
        return out
    pack = {'geometry': 'group',
            # v13(POLISH5): 飛びこみを 1 コマ早く・出だしを少し上から。v12 は箱が見えはじめるのが 5187、動きの山が 5189 で、拍(5187〜5188。手本の山 5187)に 2 コマ遅れていた
            #   (この組の kf は kfa = 着地のキーに加減速を書く流儀。outQuart → outQuint で頭の 2 コマをさらに速く)
            # v16: 着地を 21 → 26 コマ目に(同じ outQuint。v15 は 5200〜5204 で動きの量 10 → 3 と早く死んでいた。手本は 54 → 26 と尾を引く)
            'position': kf(*land([280, 690, 0], [430, 110, 0]), *push([430, 110, 0], PB[0], PC[0])),
            'rotation': kf(*land([55, -10, -125], [28, -18, -68]), *push([28, -18, -68], PB[1], PC[1])),
            'scale': kf(*land([1.7] * 3, [2.2] * 3), *push([2.2] * 3, [PB[2]] * 3, [PC[2]] * 3)),
            'children': [
                {'geometry': 'box', 'size': [300, 540, 90], 'material': plain, 'faces': [plain, plain, {'color': '#8d8d8d', 'roughness': 0.9}, plain, front, back]},
                {'geometry': 'box', 'size': [262, 300, 62], 'position': [0, kf((20, -130), (24, -300, 'outCubic')), 0], 'material': {'color': silver, 'metalness': 0.5, 'roughness': 0.45}},
                {'geometry': 'box', 'size': [262, 150, 60], 'position': [0, kf((20, -130), (24, -240, 'outCubic')), 2], 'material': {'color': '#c5141c', 'roughness': 0.5}},
                {'geometry': 'box', 'size': [300, 170, 5], 'position': [0, kf((19, -272), (23, -330, 'outCubic')), kf((19, 44), (23, 120, 'outCubic'))],
                 'rotation': [kf((19, 0), (23, -58, 'outCubic')), 0, 0], 'material': {'color': '#f1ece3', 'roughness': 0.9}},
                stick] + inner}
    # 人物: 口(= anchor)の画面上の位置と頭の大きさを完成版の 5265〜5300 の 11 コマで測った値。81 から最後まで 1 枚(v5 は 101 で別の層に替わり、大きさが 147% → 60% に飛んでいた)
    CH = B25_CHARA
    L = [
        petals('pt', n, seed=91, rate=16, life=5, size=34, wind=(-90, 0, 0), gravity=(0, 90, 0), colors=('#ffc3d2', '#ffd9e2', '#ffb1c6'), flutter=300, pre=-80),
        # v15(POLISH7): 寄りの余韻(5302〜5325 = 118〜141)で手本は花びらと雲が流れつづける(動きの量 17〜46)。こちらは小さい花びら(34px・1 コマ 1.5px)だけで 0〜9、止まって見えた。
        #   手前を大きな花びらが速く横切る層を足す(95px・1 コマ 約 5px。30 コマ目から出しはじめる。出しはじめを 100・84 コマ目にした 1・2 回目は、粒が育つ前で 1 枚も映らなかった)。寿命 2.5 秒・1 秒 8 枚 = 同時に 20 枚まで
        # v16(POLISH7): v15 の「大きい花びら 20 枚」では数が変わらなかった。手本を等倍で見ると、動いているのは「数百枚のごく小さい花びら(6〜12px)の群れ」(人物のまわりを左へ流れながら舞う)。
        #   小さい花びらを同時に約 400 枚(13px・1 コマ 3〜4px・ゆらぎ大)。大きい層は v15 の半分に
        petals('pt2', n, seed=93, rate=4, life=2.5, size=80, wind=(-300, 0, 0), gravity=(0, 130, 0), colors=('#ffc3d2', '#ffd9e2', '#ffb1c6'), flutter=260, pre=-30, area=(2800, 1300, 0)),
        petals('pt3', n, seed=95, rate=520, life=3.0, size=20, wind=(-210, 0, 0), gravity=(0, 40, 0), colors=('#ff9db8', '#ffb4c8', '#ff86a8', '#ffc6d4'), flutter=0, spin=200, opacity=[100, 100, 100, 100], turbulence={'amp': 90, 'freq': 0.6}, pre=-60, area=(2900, 1500, 0)),      # v17: 170 → 520 枚/秒・60 コマ目から(手本は数百枚の群れ。v16 は画面に 40 枚ほどだった)/ 1 回目(13px・うすい桃色・110 枚/秒)は地に溶けて見えなかった → 24px・濃い桃色・170 枚/秒
        layer('chara', 'comp', n, {'comp_id': ctx.comp('aux:B25_chara'), 'transparent': True}, t0=81,
              # 152 から先は v5 のまま: 5337〜5369(154〜186)の寄りは加速しつづけ(inSine)、止まらずに 189 から 100 コマ以上かけて減速(outCirc)
              transform={'anchor': [60, -380, 0],
                         'position': {'k': [dict(f=f, v=[x, y, 0]) for f, s, x, y in CH] + [dict(f=f, v=[x, y, 0]) for f, s, x, y in B25_CLOSE], 'interp': 'spline'},
                         'scale': {'k': [dict(f=f, v=[s, s]) for f, s, x, y in CH] + [dict(f=f, v=[s, s]) for f, s in B25_CLOSE_S], 'interp': 'spline'},
                         'rotation': kf((81, [0, 0, 3]), (94, [0, 0, 0], 'outQuad'))}),
        # v13(POLISH5): 棒の大写し(macro。〜81)から人物(82〜)へ替わるコマで棒が消え、ぼやけた大きな手だけが映っていた(5265〜5268)。
        #   口から右下へのびる棒(口 = 人物の anchor と同じ位置・拡大のキー。太さ 9.3 × 900% = 84px で macro の終わりの太さにつながる)を人物の上に重ね、棒が画面に残ったまま引く
        *[layer(nm, 'shape', n, {'kind': 'line', 'points': pts, 'stroke': col, 'stroke_width': 9.3, 'cap': 'round', 'fill': None}, t0=81,
                transform={'position': {'k': [dict(f=f, v=[x, y, 0]) for f, s, x, y in CH] + [dict(f=f, v=[x, y, 0]) for f, s, x, y in B25_CLOSE], 'interp': 'spline'},
                           'scale': {'k': [dict(f=f, v=[s, s]) for f, s, x, y in CH] + [dict(f=f, v=[s, s]) for f, s in B25_CLOSE_S], 'interp': 'spline'},
                           'rotation': kf((81, [0, 0, 21]), (94, [0, 0, 14], 'outQuad'))})
          for nm, pts, col in (('pocky_b', [[128, 0], [150, 0]], '#c98d4d'), ('pocky', [[6, 0], [132, 0]], '#55301f'))],
        layer('macro', 'shape', n, {'kind': 'rect', 'width': 3200, 'height': 180, 'radius': 90,
                                    'fill': {'gradient': {'angle': 90, 'stops': [[0, '#6b3f2c'], [0.45, '#55301f'], [1, '#2e1810']]}}}, t0=64, t1=81,
              # 棒の太さ(完成版の 5250〜5265 で測った。1920 幅で 96 → 307 → 365 → 134 → 84px)= 縦の拡大。77〜80 は棒に沿って左上へ引く(右の端が見えてくる)
              transform={'position': {'k': [dict(f=f, v=[x, y, 0]) for f, x, y in B25_MACRO_POS]},
                         'rotation': {'k': [dict(f=64, v=[0, 0, 44]), dict(f=70, v=[0, 0, 30]), dict(f=76, v=[0, 0, 25]), dict(f=80, v=[0, 0, 21])], 'interp': 'spline'},
                         'scale': {'k': [dict(f=f, v=[100, s]) for f, s in B25_MACRO_S]}}),
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
