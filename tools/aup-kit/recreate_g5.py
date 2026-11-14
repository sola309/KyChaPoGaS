#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""作り直し G5: 1 巡目では元の Blender 連番をそのまま使っていた 8 組(S01〜S08)を、mesh / particles / text で作り直す。

元の連番・完成版は「見ただけ」(形・色・動き・何コマ目に何が起きるかを言葉と数値にした)。絵は 1 画素も使っていない。
ソウルジェム = 卵形の本体(lathe)+ 金のうつわ・脚(lathe)+ 金の帯(lathe の arc)+ 窓の絵(lathe の arc に絵を貼る)+ 頭の飾り。
"""
from recreate_lib import *   # noqa: F401,F403

GOLD = '#f7c800'
RED = '#f21a00'


# ---------------------------------------------------------------- ソウルジェム(共通の形)
def _egg(t, k=1.0):
    """卵の断面: t = 0(頭)〜 1(底)→ [半径, y]。高さ ±100、いちばん太い所 ≈ 86(底寄り)。"""
    a = math.pi * t
    r = 86 * math.sin(a) ** 0.92 * (1 - 0.10 * math.cos(a))
    return [round(r * k, 2), round(-100 * math.cos(a) * k, 2)]


def _prof(t0, t1, k=1.0, steps=22):
    return [_egg(t0 + (t1 - t0) * i / steps, k) for i in range(steps + 1)]


def gold_mat(color=GOLD, **kw):
    m = {'type': 'standard', 'color': color, 'metalness': 0.12, 'roughness': 0.4, 'env_intensity': 0.9, 'emissive': color, 'emissive_intensity': 0.22}
    m.update(kw)
    return m


def gem(face=None, body=RED, gold=GOLD, face_arc=100, ribs=(118, 149, 180, 211, 242), beads=True, face_t=(0.11, 0.75), cup_t=0.56, side_w=52, finial='#ff2a00',
        body_mat=None, gold_kw=None, matte=False, face2=None, rib_w=13, **tr):
    """ソウルジェム 1 個(group)。原点 = 卵の中心、高さ ≈ 卵 200 + 脚 60 + 頭の飾り 60。正面(窓)= 手前(z 負)。
    face = 窓のマテリアル(色か絵)。None なら本体の色のまま。ribs = 金の帯の方位(度。0 = 正面、時計回りに上から見て)。"""
    g = gold_mat(gold, **(gold_kw or {}))
    bm = body_mat or {'type': 'standard', 'color': body, 'roughness': 0.55, 'emissive': body, 'emissive_intensity': 0.35}
    if matte:       # 窓だけ白・ほかは黒(luma のマット用。窓の中にだけ字を出す)
        g = bm = {'type': 'basic', 'color': '#000000'}
        face, finial, beads = '#ffffff', '#000000', False
    ch = [
        # 本体(卵)
        {'geometry': 'lathe', 'profile': _prof(0, 1), 'segments': 64, 'material': bm},
        # 金のうつわ(卵の下 44%)+ くびれ + 脚
        {'geometry': 'lathe', 'segments': 64, 'material': g,
         'profile': _prof(cup_t, 0.93, 1.035, 10) + [[30, 103], [22, 110], [21, 118], [30, 126], [52, 138], [58, 146], [54, 150], [0, 150]]},
        # うつわの縁の輪(窓の所は切れている)
        {'geometry': 'lathe', 'segments': 48, 'arc': 360 - face_arc, 'rotation': [0, face_arc / 2, 0], 'material': g,
         'profile': [[_egg(cup_t - 0.035, 1.035)[0], _egg(cup_t - 0.035)[1]], [_egg(cup_t - 0.02, 1.075)[0], _egg(cup_t - 0.02)[1]], [_egg(cup_t + 0.01, 1.075)[0], _egg(cup_t + 0.01)[1]], [_egg(cup_t + 0.03, 1.035)[0], _egg(cup_t + 0.03)[1]]]},
        # 頭のふた・角・赤い石
        {'geometry': 'lathe', 'segments': 32, 'material': g, 'profile': [[0, -128], [3, -122], [5, -112], [12, -106], [22, -102], [26, -97], [30, -90], [0, -90]]},
        {'geometry': 'sphere', 'radius': 6.5, 'scale': [1, 1.9, 1], 'position': [0, -136, 0], 'material': {'type': 'emissive', 'color': finial}},
        {'geometry': 'cone', 'radius': 2.4, 'height': 10, 'position': [0, -152, 0], 'material': g},
    ]
    # 金の帯(卵の表面に沿う細い扇)。窓の両わきの帯は太い
    half = face_arc / 2
    for a, w in [(half + side_w / 2 - 1, side_w), (-half - side_w / 2 + 1, side_w)] + [(a, rib_w) for a in ribs]:
        ch.append({'geometry': 'lathe', 'profile': _prof(0.03, cup_t + 0.02, 1.03, 16), 'segments': 6, 'arc': w, 'rotation': [0, a - w / 2, 0], 'material': g})
    if face is not None:
        fm = face if isinstance(face, dict) else {'type': 'basic', 'color': face}
        ch.append({'geometry': 'lathe', 'profile': _prof(face_t[0], face_t[1], 1.045, 24), 'segments': 24, 'arc': face_arc, 'rotation': [0, -face_arc / 2, 0], 'material': fm})
    if face2 is not None:      # 窓の絵の 2 枚目(1 枚目の上に重ねる。色 → 絵の切り替え用)
        ch.append({'geometry': 'lathe', 'profile': _prof(face_t[0], face_t[1], 1.052, 24), 'segments': 24, 'arc': face_arc, 'rotation': [0, -face_arc / 2, 0], 'material': face2})
    if beads:
        # 窓のふちの小さな玉(両わきの帯の上)と、うつわの縁の玉
        for s in (1, -1):
            for i in range(10):
                t = 0.12 + 0.07 * i
                r, y = _egg(t, 1.07)
                a = math.radians(s * (half + 3))
                ch.append({'geometry': 'sphere', 'radius': 4.6, 'segments': 12, 'position': [round(r * math.sin(a), 2), y, round(-r * math.cos(a), 2)], 'material': g})
        r, y = _egg(cup_t, 1.06)
        for i in range(14):
            if abs((i * 360 / 14 + 12 + 180) % 360 - 180) < half + 4:
                continue
            a = math.radians(i * 360 / 14 + 12)
            ch.append({'geometry': 'sphere', 'radius': 4.2, 'segments': 12, 'position': [round(r * math.sin(a), 2), y, round(-r * math.cos(a), 2)], 'material': g})
    o = {'geometry': 'group', 'children': ch}
    o.update(tr)
    return o


def _faces():
    """窓に貼る絵(新しく WAI で生成した杏子。ユーザー確認前 = 仮)。{名前: asset_id}。無ければ色だけ。"""
    p = os.path.join(SAKURA, 'rebuild', 'seq3d_assets.json')
    return {k: v['asset_id'] for k, v in json.load(open(p, encoding='utf-8')).items() if v.get('asset_id')} if os.path.exists(p) else {}


def pic(name, color='#ffffff', flip=False, **kw):
    """窓の絵のマテリアル。絵がまだ無ければ None。flip = 上下左右を逆さに貼る。"""
    a = _faces().get(name)
    if not a:
        return None
    m = {'type': 'basic', 'color': color, 'texture': {'asset_id': a}}
    if flip:
        m.update(texture_repeat=[-1, -1], texture_offset=[1, 1])
    m.update(kw)
    return m


GEM_LIGHT = {'ambient': 2.1, 'intensity': 1.1, 'direction': [-0.5, -1, -1]}


def gem_layer(id, n, objects, unlit=False, **kw):
    return layer(id, 'mesh', n, {'env': 'soft', 'env_intensity': 0.8, 'unlit': unlit, 'light': dict(GEM_LIGHT), 'objects': objects}, pos=[960, 540, 0], **kw)


# ---------------------------------------------------------------- S01 ソウルジェム飛んでくる(105 コマ。完成版 3〜107)
# 見た動き(連番のコマ): 4 で奥から現れ(560,540)、14 で高さ 500px。面を 1 回転と少し(頭が 14 上 → 21 右 → 28 下 → 35 左 → 49 で左へ 20° 傾いて止まる)。
# 窓の色は 赤(〜14)→ 桃(28)→ 白(46)。49 から右へ加速して流れ(63: x640 → 77: x960 → 84: x1300)、窓の中にだけ「2021/11/11 POCKY & PRETZ DAY」
# (画面に固定。x 480〜1440・y 540)が見える。88 から縮んで 95 で消える。
@reg('scene/01_冒頭長いカット/01_Blender_ソウルジェム飛んでくる/1.08', 'S01', 'mesh(ソウルジェム = lathe の卵・うつわ・帯)+ text を窓の luma マットで切る')
def s01(ctx):
    n = 105
    pos = kf((4, [-400, -10, 0]), (7, [-400, 0, 0]), (21, [-420, 0, 0]), (28, [-380, -10, 0]), (42, [-370, 20, 0]), (46, [-375, 20, 0]), (54, [-375, 20, 0]), (58, [-365, 20, 0]),
             (62, [-335, 20, 0]), (66, [-295, 20, 0]), (70, [-215, 20, 0]), (74, [-115, 20, 0]), (78, [35, 22, 0]), (82, [225, 25, 0]), (86, [470, 28, 0]), (90, [520, 30, 0]), (96, [540, 30, 0]))
    rot = kf((4, [0, -16, -25]), (14, [0, -16, -10]), (21, [0, 0, 90]), (28, [0, 20, 190]), (35, [0, 8, 270]), (42, [0, -12, 300]), (49, [0, -14, 334], 'outQuad'), (56, [0, -15, 336]),
             (86, [0, -15, 338]), (90, [0, -150, 350]))
    sc = kf(*[(f, [v, v, v]) for f, v in [(3, 0.001), (4, 0.15), (7, 0.72), (14, 1.64), (21, 1.7), (28, 1.75), (49, 1.62), (56, 1.64), (86, 1.7), (90, 0.4), (95, 0.001)]])
    face = kf((0, '#f21a00'), (14, '#f21a00'), (21, '#ff5648'), (28, '#ff8a8a'), (35, '#ffbcbc'), (42, '#f6dede'), (47, '#ececec'), (86, '#ececec'), (90, '#ff9a9a'))
    # 窓の中の字は、完成版の字(x 480〜1440)より 1.18 倍大きく、左へずれながら流れる(見て測った: 50 コマ +35px → 70 コマ −134px → 86 コマ −84px)
    tx = kf((46, [1010, 540]), (50, [995, 540]), (54, [915, 540]), (58, [875, 540]), (62, [855, 540]), (70, [826, 540]), (78, [836, 540]), (86, [876, 540]))
    return doc('再現 S01 ソウルジェム飛んでくる', n, [
        layer('txt', 'text', n, {'text': '2021/11/11 POCKY & PRETZ DAY', 'font': 'APJapanesefont', 'size': 72, 'fill': '#030303'}, t0=46, t1=89,
              transform={'position': tx, 'scale': [118, 118]},
              matte={'layer': 'facem', 'mode': 'luma'}),
        gem_layer('facem', n, [gem(matte=True, position=pos, rotation=rot, scale=sc)], unlit=True, t0=3, t1=96),
        gem_layer('gem', n, [gem(face={'type': 'basic', 'color': face}, position=pos, rotation=rot, scale=sc)], t0=3, t1=96),
    ])


# ---------------------------------------------------------------- S02 ソウルジェム 4 つで横並び(40 コマ。完成版 358〜397)
# 見た形: 4 個が左から(420,500)(920,420)(1215,760)(1600,590)。傾きは −20°・+9°・213°(逆さ)・−64°(横倒し)。窓に杏子の場面写ふうの絵。
# 0〜12 はほぼ止まり、20 までに 7 割へ遠ざかり、20〜28 で回りながら画面の外へ散る(窓は白へ)。
@reg('scene/01_冒頭長いカット/03_ソウルジェム4つで横並び/1.05', 'S02', 'mesh(ソウルジェム 4 個)。窓の絵は新しく生成した杏子(仮)')
def s02(ctx):
    n = 40
    G = [  # (名前, 位置, 大きさ, 傾き, 首ふり, 逆さに貼る, 散る先, 散るときの回転)
        ('a1', (420, 500), 2.8, -20, -14, False, (-420, 60), -140),
        ('a2', (920, 420), 2.25, 9, 0, True, (1700, -260), 200),
        ('a4', (1215, 760), 2.1, 213, 8, True, (420, 1500), 120),
        ('a3', (1600, 590), 1.9, -64, 16, False, (2400, 1000), 260),
    ]
    objs = []
    for nm, (x, y), sc, rz, ry, flip, (ox, oy), spin in G:
        cx, cy = 960 + (x - 960) * 0.93, 540 + (y - 540) * 0.9
        pos = kf((0, [x - 960, y - 540, 0]), (12, [x - 960, y - 540, 0], 'inQuad'), (20, [cx - 960, cy - 540, 0], 'inQuad'), (29, [ox - 960, oy - 540, 0]))
        s_ = kf(*[(f, [sc * v] * 3) for f, v in [(0, 1), (10, 0.96), (16, 0.78), (20, 0.68), (29, 0.55)]])
        rot = kf((0, [0, ry, rz]), (20, [0, ry, rz + 4], 'inQuad'), (29, [40, ry + 60, rz + spin]))
        p = pic(nm, flip=flip, opacity=kf((20, 1), (24, 0)))
        objs.append(gem(face='#f1eeee', face2=p, position=pos, rotation=rot, scale=s_))
    return doc('再現 S02 ソウルジェム 4 つで横並び', n, [gem_layer('gems', n, objs, t1=30)])


# ---------------------------------------------------------------- S03 ソウルジェム 5 つで桜(147 コマ。完成版 211〜357)
# 見た形: 5 個が桜の花びらのように並ぶ(頭の飾りが中心・脚が外。中心 ≈ (960,520)、脚の先まで 660px)。
# 4〜20 手前から引いてくる(裏 = 赤に金の帯)。25〜40 で各自が軸まわりに回って窓が手前へ、窓の色は 赤 → 桃 →(50)赤・紫・桃・水色・白。
# 60〜76 で輪が 72° 回り、64〜74 で窓にちびキャラの杏子の絵が出る。110〜 絵が赤く染まり、118〜130 で裏返り、134〜146 で手前へ飛んで来る。
@reg('scene/01_冒頭長いカット/02_ソウルジェム5つで桜/1.09', 'S03', 'mesh(ソウルジェム 5 個を group で花びらの並びに)。窓の絵は新しく生成した杏子(仮)')
def s03(ctx):
    n = 147
    cols = ['#8f86c0', '#ff8f8f', '#6fb0c4', '#eeeae4', '#e03a3a']
    pics = ['c2', 'c3', 'c4', 'c5', 'c1']
    R, S = 186, 1.95
    petals_ = []
    for i in range(5):
        fc = kf((0, '#f21a00'), (30, '#f21a00'), (40, ['#ff5a8a', '#ff7070', '#ff8a8a', '#ff9a9a', '#ff3030'][i]), (50, cols[i]))
        p = pic(pics[i], color=kf((106, '#ffffff'), (118, '#ff5a5a')), opacity=kf((64, 0), (74, 1)), transparent=True)
        own = kf((0, [0, 180, 0]), (24, [0, 180, 0], 'inOutCubic'), (40, [0, 32, 0]), (119, [0, 32, 0], 'inOutCubic'), (133, [-62, 190, 0]), (146, [-75, 200, 0]))
        petals_.append({'geometry': 'group', 'rotation': [0, 0, i * 72], 'children': [
            {'geometry': 'group', 'position': [0, -R, 0], 'rotation': [0, 0, 180], 'children': [gem(face={'type': 'basic', 'color': fc}, face2=p, rotation=own)]}]})
    ring = {'geometry': 'group', 'position': [0, -20, 0], 'children': petals_,
            'rotation': [0, 0, kf((4, -60), (20, -30, 'outCubic'), (44, 0), (60, 0, 'inOutCubic'), (76, 72), (100, 72, 'inOutCubic'), (126, 144), (146, 190))],
            'scale': kf(*[(f, [S * v] * 3) + tuple(e) for f, v, *e in [(3, 5.5), (10, 3.2), (20, 1.7, 'outCubic'), (30, 1.25), (40, 1.0), (122, 1.0), (134, 1.35, 'inCubic'), (140, 2.0), (146, 3.4)]])}
    return doc('再現 S03 ソウルジェム 5 つで桜', n, [gem_layer('gems', n, [ring], t0=3)])


# ---------------------------------------------------------------- S06 ソウルジェムちょい飛び(166 コマ。S12 で 9 回使う)
# 見た動き: 小さなソウルジェム(長さ 240px。くすんだ金・細い帯・窓は赤)が下の縁(1180,1040)から跳ね上がり、回りながら 77〜88 で頂点(1300,340)、
# 110 から落ち始め、130(1284,620)のあと 132 で消える。136 から白い線路(レール 2 本 + 枕木。y 937〜1000)が右から 1 コマ 145px で入ってくる。
@reg('scene/12_キャラ紹介1前後/Blender/ソウルジェムちょい飛び/1.01', 'S06', 'mesh(ソウルジェム 1 個の放物線 + 線路 = 箱の along 複製)')
def s06(ctx):
    n = 166
    P = [(0, 1180, 1040), (11, 1180, 700), (22, 1208, 560), (33, 1240, 480), (44, 1272, 408), (55, 1280, 380), (66, 1288, 360), (77, 1300, 340), (88, 1292, 340), (99, 1300, 360),
         (110, 1288, 400), (118, 1288, 460), (121, 1284, 490), (124, 1284, 520), (127, 1284, 560), (130, 1284, 620), (132, 1284, 670)]
    pos = kf(*[(f, [x - 960, y - 540, 0]) for f, x, y in P])
    rot = kf((0, [0, 180, 0]), (11, [0, 170, 95]), (22, [-65, 190, 60]), (33, [-60, 200, 0]), (44, [-20, 330, -60]), (55, [0, 350, -40]), (77, [0, 345, -38]), (99, [0, 355, -20]),
             (110, [0, 360, -5]), (118, [-30, 420, 0]), (130, [-65, 540, 0]))
    g = gem(face='#d01a14', body='#cc1410', gold='#cdbc4e', side_w=12, ribs=(80, 105, 130, 155, 180, 205, 230, 255, 280), rib_w=6, finial='#d01a14',
            position=pos, rotation=rot, scale=0.8)
    white = {'type': 'standard', 'color': '#f4f4f4', 'roughness': 0.9}
    path = {'type': 'line', 'from': [-3000, 0, 0], 'to': [3000, 0, 0]}
    rail = {'geometry': 'group', 'position': [kf((135, 1945 + 3000 - 960), (165, 1945 + 3000 - 960 - 145 * 30)), 968 - 540, 0], 'rotation': [-28, 0, 0], 'children': [
        {'geometry': 'box', 'size': [6000, 7, 7], 'position': [0, -6, -32], 'material': white},
        {'geometry': 'box', 'size': [6000, 7, 7], 'position': [0, -6, 32], 'material': white},
        {'geometry': 'box', 'size': [22, 9, 96], 'material': white, 'instances': {'count': 89, 'layout': 'along', 'path': path, 'align': False}},
    ]}
    return doc('再現 S06 ソウルジェムちょい飛び', n, [
        gem_layer('rail', n, [rail], t0=135),
        gem_layer('gem', n, [g], t1=132),
    ])


# ---------------------------------------------------------------- S07 タイトルロゴのソウルジェム(334 コマ。S12 の 1184〜1517 に 2 枚重ね)
# 見た形: 陰のない紫(#4b2857)一色のソウルジェム。窓は明るい灰色で、中に縦書きの題字「さくらの空 / アプリコットの愛」+ 小さな英字 + 桃色の桜(題字は画面に固定)。
# 0〜30 大写しから引く(窓の上に 3 本の帯がかかっていて、わきへ回って消える)→ 44〜140 右へ 20° 傾いて止まる(中心 (940,520)・全高 1010px)。
# 148〜158 紫 → くすんだ桃色・帯が戻る → 156〜172 正面を向いて寄る → 172〜 窓の大写し(灰白の面に紙吹雪がうすく映り、右の縁に桃色の玉の列)。
@reg('aux:S07_logo', 'S07a', 'text(縦書きの題字)+ shape(桜)')
def s07_logo(ctx):
    n = 1
    ink = '#2b2224'

    def col(id, text, size, x, y, **kw):
        return layer(id, 'text', n, dict({'text': text, 'font': 'APJapanesefont', 'size': size, 'fill': ink, 'writing': 'vertical', 'stroke': ink, 'stroke_width': 1.8}, **kw), pos=[x, y])
    return doc('部品 S07 題字', n, [
        col('t1', 'さくらの空', 80, 1034, 385),
        col('t2', 'アプリコットの愛', 64, 914, 462),
        layer('en', 'text', n, {'text': 'A love for Sakura Kyoko', 'font': 'Noto Sans JP', 'weight': 400, 'size': 17, 'fill': ink, 'tracking': 1.5}, transform={'position': [960, 410], 'rotation': [0, 0, 90]}),
        layer('sakura', 'shape', n, {'kind': 'flower', 'width': 132, 'height': 132, 'fill': '#f1b9c2', 'sides': 5}, transform={'position': [1024, 622], 'rotation': [0, 0, 12]}),
    ])


@reg('scene/13_タイトルロゴ/03_Blender_ソウルジェム/1.03', 'S07', 'mesh(陰なしのソウルジェム + かごの帯)+ 窓の中はシーン 13 の comp を luma マットで切る + shape(窓の大写し)')
def s07(ctx):
    n = 334
    col = kf((0, '#4b2857'), (148, '#4b2857'), (158, '#b98593'), (168, '#d3a0a8'))
    gray = '#d4d4d2'
    pos = kf((0, [-60, 260, 0]), (8, [0, 330, 0]), (16, [40, 200, 0]), (30, [15, 30, 0]), (44, [-31, -17, 0]), (148, [-31, -17, 0]), (156, [-105, 7, 0]), (162, [-225, -40, 0]),
             (166, [-360, -20, 0]), (172, [-1000, 100, 0]))
    rot = kf((0, [0, 14, 38]), (8, [0, 14, 34]), (16, [0, 14, 30]), (30, [0, 6, 2]), (44, [0, 14, 20]), (140, [0, 14, 20]), (148, [0, 10, 14]), (156, [0, 0, 0]))
    # 大きさ: 44〜148 は卵の高さ 700px(= 3.5 倍。全高 1057px)
    sc = kf(*[(f, [v] * 3) for f, v in [(0, 8.5), (8, 6.5), (16, 5.0), (30, 3.5), (44, 3.5), (148, 3.5), (156, 4.3), (162, 5.3), (166, 6.5), (172, 13)]])

    def one(matte):
        c = '#000000' if matte else col
        m = {'type': 'basic', 'color': c}
        g = gem(face=gray, body=c, gold=c, body_mat=m, finial='#000000' if matte else '#cf2050', matte=matte, position=pos, rotation=rot, scale=sc, ribs=(), side_w=136, beads=not matte, face_t=(0.11, 0.69))
        if not matte:
            for o in g['children']:
                if o.get('material', {}).get('type') == 'standard':
                    o['material'] = m
        for i, a in enumerate((-26, 0, 26)):       # かごの帯: 窓の上 → わきへ回って隠れる → 戻る
            ry = kf((0, a - 4.5), (14, a - 4.5, 'inOutQuad'), (40, a - 150), (144, a - 150, 'inOutQuad'), (156, a * 1.3 - 4.5))
            g['children'].append({'geometry': 'lathe', 'profile': _prof(0.03, 0.6, 1.075, 16), 'segments': 4, 'arc': 9, 'rotation': [0, ry, 0], 'material': m})
        # 148〜: うつわの前が高くなる(窓の下半分を隠す)
        g['children'].append({'geometry': 'lathe', 'profile': _prof(0.47, 0.8, 1.062, 10), 'segments': 24, 'arc': 110, 'rotation': [0, -55, 0], 'material': m,
                              'scale': kf((149, 0.001), (150, 1))})
        return g
    s13 = scene_comps().get('13')
    L = [
        # 窓の大写し(172〜): 灰白の面 + うすい紙吹雪 + 右の縁の桃色の玉
        layer('in_13', 'comp', n, {'comp_id': s13 or ctx.comp('aux:S07_logo')}, t0=172, start=1184 + 172 if s13 else 0, blend='multiply', pos=[960, 540],
              masks=[{'shape': 'ellipse', 'x': 353 - 727, 'y': 510 - 727, 'w': 1454, 'h': 1454}]),
        layer('in_face', 'shape', n, {'kind': 'ellipse', 'width': 1454, 'height': 1454, 'fill': '#cfd0cb'}, pos=[353, 510], t0=172),
    ]
    for i in range(15):
        a = math.radians(-49 + i * 7)
        L.append(layer(f'in_b{i}', 'shape', n, {'kind': 'ellipse', 'width': 62, 'height': 62, 'fill': '#dba9ae'}, pos=[353 + 772 * math.cos(a), 510 + 772 * math.sin(a)], t0=172))
    L += [
        layer('in_rim', 'shape', n, {'kind': 'ellipse', 'width': 1540, 'height': 1540, 'fill': '#dba9ae'}, pos=[353, 510], t0=172),
        # 窓の中 = シーン 13(題字の場面)そのもの。元の連番も窓にシーン 13 の絵が映っていた(画面に固定・等倍。連番の n コマ目 = シーン 13 の 1184+n コマ目)。
        # (mesh の texture に mesh 入りの comp を貼ると親のカメラが狂うので、2D で重ねて窓の luma マットで切る。灰色の窓に乗算)
        (layer('face13', 'comp', n, {'comp_id': s13}, t1=172, start=1184, blend='multiply', matte={'layer': 'facem', 'mode': 'luma'}, pos=[960, 540]) if s13 else
         layer('logo', 'comp', n, {'comp_id': ctx.comp('aux:S07_logo'), 'transparent': True}, t1=160, start=0, speed=0, matte={'layer': 'facem', 'mode': 'luma'}, pos=[960, 540])),
        # 73〜160(完成版 1257〜1344): シーン 13 の題字(シーン 14 の動画)が素材なしで出ないので、自前の題字(aux:S07_logo。フリーフォント)を窓の中に重ねる。
        # 位置は完成版 1258〜1330 を見て合わせた(右の列 x1035・y180〜600、左の列 x915・y210〜705、桜 (1035,615))。画面に固定
        *([layer('logo2', 'comp', n, {'comp_id': ctx.comp('aux:S07_logo'), 'transparent': True}, t0=73, t1=160, start=0, speed=0, matte={'layer': 'facem', 'mode': 'luma'}, pos=[960, 540])]
          if s13 and ctx.comp('aux:S07_logo') else []),
        layer('facem', 'mesh', n, {'unlit': True, 'objects': [one(True)]}, pos=[960, 540, 0], t1=172),
        layer('gem', 'mesh', n, {'unlit': True, 'objects': [one(False)]}, pos=[960, 540, 0], t1=172),
    ]
    return doc('再現 S07 タイトルロゴのソウルジェム', n, L)


# ---------------------------------------------------------------- S08 タイトルロゴ花びら舞(162 コマ。S13 の 1184〜1345)
# 見た形: 画面いっぱいに桃色のごく小さな花びら(4〜10px が 350 枚ほど)+ 30〜60px が数枚。頭のコマからもう舞っていて、ゆっくり流れる。
@reg('scene/13_タイトルロゴ/02_タイトルロゴ花びら舞/1.01', 'S08', 'particles(petals。ごく小さい粒 + 大きめ数枚)')
def s08(ctx):
    n = 162
    c = ('#f4b6cb', '#f7c3d4', '#efa9c1')
    return doc('再現 S08 タイトルロゴ花びら舞', n, [
        petals('big', n, seed=82, rate=1.6, life=5, size=44, wind=(40, 0, 0), gravity=(0, 50, 0), colors=c),
        petals('mid', n, seed=83, rate=10, life=5, size=16, wind=(30, 0, 0), gravity=(0, 36, 0), colors=c),
        petals('tiny', n, seed=81, rate=62, life=5, size=7.5, wind=(22, 0, 0), gravity=(0, 26, 0), colors=c, speed=30),
    ])


# ---------------------------------------------------------------- S04 曲名背景の桜吹雪(184 コマ。S23 の 3022〜3205)
# 見た形: 0 は空 → 16 でもう画面じゅうに出ている(一斉に現れる)。小さい花びら(8〜20px)が 400 枚ほど + 60〜100px が 10 枚ほど。桃色 #f6b7cf。
@reg('scene/23_10年愛/Blender/曲名背景の桜吹雪/1.00', 'S04', 'particles(petals の一斉放出 bursts)')
def s04(ctx):
    n = 184
    c = ('#f6b7cf', '#f9c6d8', '#f1a8c3')

    def burst(id, seed, cnt, size, g):
        em = {'preset': 'petals', 'sprite': 'petal', 'position': [0, 0, 0], 'emit': 'box', 'area': [2300, 1300, 0], 'rate': 0, 'bursts': [{'f': 2, 'count': cnt // 3}, {'f': 6, 'count': cnt // 3}, {'f': 11, 'count': cnt // 3}],
              'life': 9, 'life_random': 0.2, 'size': [size, size], 'size_random': 0.75, 'wind': [30, 0, 0], 'gravity': [0, g, 0], 'colors': list(c), 'opacity': [100, 100], 'fade_in': 0.02, 'speed': 40}
        return layer(id, 'particles', n, {'seed': seed, 'emitter': em}, pos=[960, 540])
    return doc('再現 S04 曲名背景の桜吹雪', n, [burst('big', 42, 15, 85, 70), burst('mid', 43, 90, 30, 50), burst('small', 41, 390, 15, 34)])


# ---------------------------------------------------------------- S05 10 年愛の花びらの渦(170 コマ。S23 の 2933〜3102。白一色から色が戻る)
# 見た形: 花びらが帯になって流れ込み(11: 短い帯 3 本)、渦を巻いて太り(22〜77)、88 で画面いっぱいの大写し(一面の桃色)、
# 99〜154 は大きな花びら(40〜100px)がまばらに落ちて、165 で空になる。色は桃色 #e8b0c6。
@reg('scene/23_10年愛/Blender/1.00', 'S05', 'mesh(花びら = extrude の along 複製を渦の道 3 本に)+ particles(あとに残る花びら)')
def s05(ctx):
    n = 170
    arms = []
    for i in range(3):
        path = {'type': 'helix', 'axis': 'z', 'radius': 170, 'radius_end': 1500, 'turns': 0.9, 'height': 500, 'start': i * 120 + 20}
        for j, (cnt, sz, sw) in enumerate([(170, [70, 104], 50), (90, [120, 170], 95)]):
            arms.append({'geometry': 'extrude', 'shape': 'petal', 'size': sz, 'depth': 0, 'material': {'type': 'standard', 'color': '#ffffff', 'roughness': 0.9, 'side': 'double'},
                         'instances': {'count': cnt, 'seed': 500 + i * 10 + j, 'layout': 'along', 'path': path, 'align': True, 'offset': kf((0, 0.85), (44, 0.0, 'outQuad')),
                                       'rotation_random': [180, 180, 180], 'scale': [0.45, 1.5], 'spin': [30, 40, 20], 'spin_random': [60, 60, 60], 'sway': {'amp': [sw, sw, sw], 'freq': 0.12},
                                       'colors': ['#e9b3c8', '#f0c4d4', '#dfa5bd', '#e6adc3']}})
    swirl = {'geometry': 'group', 'position': [90, -60, 0], 'children': arms,
             'rotation': [kf((0, 22), (88, 8)), kf((0, -14), (88, 0)), kf((0, 0), (92, 120))],
             'scale': kf(*[(f, [v] * 3) + tuple(e) for f, v, *e in [(0, 0.8), (60, 1.0, 'inCubic'), (78, 1.6), (85, 4), (90, 9), (94, 16)]])}

    def fall(id, seed, cnt, size):
        em = {'preset': 'petals', 'sprite': 'petal', 'position': [0, 0, 0], 'emit': 'box', 'area': [2300, 1400, 0], 'rate': 0, 'bursts': [{'f': 0, 'count': cnt}], 'life': 1.25, 'life_random': 0.6,
              'size': [size, size * 0.8], 'size_random': 0.6, 'wind': [-60, 0, 0], 'gravity': [0, 260, 0], 'speed': 120, 'colors': ['#e9b3c8', '#f0c4d4', '#dfa5bd'], 'opacity': [100, 100, 100, 0], 'fade_in': 0}
        return layer(id, 'particles', n, {'seed': seed, 'emitter': em}, pos=[960, 480], t0=89)
    return doc('再現 S05 花びらの渦', n, [
        fall('after', 55, 90, 120),
        # 86〜92: 大写しの花びらが画面をおおう(一面の桃色)
        layer('cover', 'solid', n, {'color': '#f1bfcd', 'width': W, 'height': H}, pos=[W / 2, H / 2], t0=82, t1=97, transform={'position': [W / 2, H / 2], 'opacity': kf((82, 0), (87, 100), (92, 100), (97, 0))}),
        layer('swirl', 'mesh', n, {'env': 'soft', 'light': {'ambient': 2.3, 'intensity': 0.9, 'direction': [-0.4, -1, -0.8]}, 'objects': [swirl]}, pos=[960, 540, 0], t1=95),
    ])
