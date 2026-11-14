#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""作り直し G2: キャラ紹介 1〜4(S12・S20・S22)の連番。

- B12 キャラ紹介説明書 01〜04: ポッキーの箱が回って倒れ、ふたが開いて説明カードが出てくる。
  箱の絵 = S48(パッケージの展開図の comp)、カードの絵 = S21(説明書の comp)をそのまま貼る。
  立体は板(2D の入れ子)で組んだ: 箱の回転は「長い軸まわりの回転 = 横幅 × cos」で表と裏の板を出し分ける。
- B10 ソウルジェムトランジション 01〜04: 紫のソウルジェムの影絵が下からせり上がり、卵形の窓の中に S22 が見える。
  そのあとカメラが台座へ寄って画面が紫で埋まり、右へ抜ける。
- B11 杏子立ち絵(3D モデルの書き出し)8 組: 元絵が要る → 同じ位置・大きさ・ポーズのマネキン(mesh の mannequin)で仮置き。
"""
import json
import math
import os

from recreate_lib import *   # noqa: F401,F403

_CM = scene_comps()
C_S21, C_S22, C_S48 = _CM.get('21'), _CM.get('22'), _CM.get('48')
PURPLE = '#673a73'


def kf(*pts):   # noqa: F811
    """kf((f, v), (f, v, 'outQuad'), ...): 3 つ目は「このキーへ着くまでの」加減速(エンジンは区間の頭のキーの e を使うので 1 個前へずらす)。"""
    ks = [dict(f=p[0], v=p[1]) for p in pts]
    for i in range(1, len(pts)):
        if len(pts[i]) > 2:
            ks[i - 1]['e'] = pts[i][2]
    return {'k': ks}


def _out_quad(t):
    t = min(1.0, max(0.0, t))
    return 1 - (1 - t) * (1 - t)


# ---------------------------------------------------------------- B12 説明書(箱 + カード)

# (台帳の枝番, 連番フォルダ, 枚数, S48 の展開図のコマ, S21 のカードの頭のコマ, 箱の色)
_B12 = [
    ('01', 'scene/21_キャラ紹介説明書/01/1.07', 224, 30, 1548, '#dc3a34'),
    ('02', 'scene/21_キャラ紹介説明書/02/1.07', 224, 40, 1929, '#d8b458'),
    ('03', 'scene/21_キャラ紹介説明書/03/1.07', 224, 50, 2255, '#6eacc4'),
    ('03b', 'scene/21_キャラ紹介説明書/03/1.06', 224, 50, 2255, '#6eacc4'),
    ('04', 'scene/21_キャラ紹介説明書/04/1.07', 224, 58, 2593, '#69436f'),
]
_T0, _T1 = 22, 41          # 箱が回りはじめる・倒れきるコマ
_BOX = 42.4                # 展開図の表(738×1331 px)→ 箱 313×564 px


def _b12_doc(tag, n, atlas_f, card0, color):
    rig = layer('rig', 'null', n, transform={
        'position': kf((0, [960, 540]), (_T0, [960, 540]), (_T1, [968, 568], 'outQuad'), (56, [968, 568]), (71, [937, 600], 'inOutQuad'), (91, [968, 641], 'outQuad'), (151, [973, 653])),
        'rotation': kf((0, -90), (_T0, -90), (32, -27, 'outQuad'), (_T1, -22, 'outQuad'), (56, -22), (71, -11, 'inOutQuad'), (111, -14, 'inOutQuad'), (151, -19), (224, -21)),
        'scale': kf((0, [100, 100]), (56, [100, 100]), (71, [105, 105], 'inQuad'), (91, [115, 115], 'outQuad'), (151, [126, 126]), (224, [130, 130])),
    })
    # 長い軸まわりに 1 回転(表 → 裏 → 表)。横幅 = cos
    fr, bk = [(0, [_BOX, _BOX])], [(0, [0, _BOX])]
    for k in range(_T0, _T1 + 1):
        c = math.cos(math.radians(360 * _out_quad((k - _T0) / (_T1 - _T0))))
        fr.append((k, [round(_BOX * max(c, 0), 3), _BOX]))
        bk.append((k, [round(_BOX * max(-c, 0), 3), _BOX]))

    def face(id, left, right, sc):
        return layer(id, 'comp', n, {'comp_id': C_S48, 'transparent': True}, parent='rig', start=atlas_f, speed=0,
                     transform={'position': [0, 0], 'rotation': 90, 'scale': kf(*sc)},
                     effects=[{'type': 'crop', 'params': {'left': left, 'right': right, 'top': 717, 'bottom': 0, 'recenter': True}}])
    front = face('front', 61, 1249, fr)
    back = face('back', 819, 492, bk)
    back['out'] = _T1
    # ふた(箱の口で立ち上がる)とカード(口から右へすべり出る)
    flap = layer('flap', 'shape', n, {'kind': 'rect', 'width': 64, 'height': 313, 'fill': color}, parent='rig', t0=57,
                 transform={'position': kf((57, [270, 0]), (66, [296, 0], 'outQuad')), 'scale': kf((57, [20, 100]), (66, [100, 100], 'outQuad'))})
    card = layer('card', 'comp', n, {'comp_id': C_S21}, parent='rig', start=card0 + 55, t0=55,
                 transform={'position': kf((55, [0, 0]), (68, [480, 6], 'outQuad'), (91, [624, 15], 'outQuad')), 'scale': kf((55, [30, 30]), (91, [36.5, 36.5], 'outQuad'))})
    return doc(f'再現 B12 キャラ紹介説明書 {tag}', n, [flap, front, back, card, rig])


def _mk_b12(tag, key, n, atlas_f, card0, color):
    @reg(key, 'B12', '入れ子(S48 の箱の展開図・S21 のカード)+ null の親 + crop')
    def _f(ctx):
        return _b12_doc(tag, n, atlas_f, card0, color)
    return _f


for _a in _B12:
    _mk_b12(*_a)


# ---------------------------------------------------------------- B10 ソウルジェムトランジション

# (枝番, 連番フォルダ, 枚数, S22 の頭のコマ, 左右反転して使われるか, 画面が紫で埋まったあと抜けはじめるコマ(None = 抜けない))
_G = 'scene/20_キャラ紹介後半/Blender/ソウルジェムトランジション/'
_B10 = [
    ('01 1.08', _G + '01/1.08', 200, 1667, True, 105),
    ('01 1.04', _G + '01/1.04', 200, 1667, True, 105),
    ('02 1.08', _G + '02/1.08', 200, 2048, False, 92),
    ('02 1.07', _G + '02/1.07', 200, 2048, False, 92),
    ('02 1.04', _G + '02/1.04', 200, 2048, False, 92),
    ('03 1.04', _G + '03/1.04', 200, 2349, True, 87),
    ('03 1.01', _G + '03/1.01', 200, 2349, True, 87),
    ('04 1.04', _G + '04/1.04', 103, 2709, False, None),
]


def _b10_doc(tag, n, s22, flip, off):
    """座標は「完成版で見える向き」で書き、左右反転して使われる連番は全体を鏡に写しておく(AviUtl 側の反転で元に戻る)。"""
    def X(x):
        return 1920 - x if flip else x
    zs, cov, ret = (off - 23, off - 10, off - 9) if off else (n + 10, n + 20, n + 30)
    S1 = 5.2
    hc = (975, 445)                                    # 卵形の窓の中心(せり上がりきった位置)= rig の原点
    q, c = (900, 900), (960, 700)                      # 寄るときに q の点が c へ来る
    p1 = [X(c[0]) - S1 * (X(q[0]) - X(hc[0])), c[1] - S1 * (q[1] - hc[1])]
    # せり上がり: 下から上がりながら手前へ来る(小さい → 等倍)
    rk = 1.0 if off else 1.5                           # 04 はゆっくり上がる(完成版 2711〜2785)
    pos = [(round(f * rk), [X(hc[0]), y]) for f, y in ((0, 1500), (6, 975), (12, 800), (18, 710), (24, 650), (33, 594), (48, 445))]
    sc = [(0, [60, 60]), (round(18 * rk), [70, 70]), (round(33 * rk), [80, 80]), (round(48 * rk), [100, 100])]
    if off:
        # 寄りきって画面が紫で埋まる(cov)→ 通り抜けたあと、小さくなりながら影絵に戻り(off - 2)、横へ抜ける(off + 8)。
        # 抜ける向きは連番の画面で左(ここだけ X() を通さない。反転して使う 01・03 は完成版で右、反転しない 02 は左)
        pos += [(zs, [X(hc[0]), hc[1]]), (cov, p1, 'inQuad'), (off - 2, [600, 560], 'outQuad'), (off + 4, [520, 540]), (off + 8, [-1100, 420], 'inQuad')]
        sc += [(zs, [100, 100]), (cov, [S1 * 100, S1 * 100], 'inQuad'), (off - 2, [100, 100], 'outQuad'), (off + 4, [88, 88]), (off + 8, [85, 85])]
    rig = layer('rig', 'null', n, transform={'position': kf(*pos), 'scale': kf(*sc)})

    def ell(id, cx, cy, w, h, **src):
        return layer(id, 'shape', n, dict({'kind': 'ellipse', 'width': w, 'height': h}, **src), parent='rig',
                     transform={'position': [X(cx) - X(hc[0]), cy - hc[1]]})
    ring = ell('ring', hc[0], hc[1], 800, 900, fill=None, stroke=PURPLE, stroke_width=34)
    top = [ell('spike', hc[0], hc[1] - 505, 44, 150, fill=PURPLE), ell('jewel', hc[0], hc[1] - 520, 22, 70, fill='#a8243c')]
    top.reverse()
    for i, dx in enumerate((-70, -36, 36, 70)):
        top.append(ell(f'tb{i}', hc[0] + dx, hc[1] - 458 + abs(dx) * 0.12, 40, 40, fill=PURPLE))
    hole = ell('hole', hc[0], hc[1], 772, 872, fill='#ffffff')
    inner = layer('inner', 'comp', n, {'comp_id': C_S22}, start=s22, t1=min(n, cov - 1), matte={'layer': 'hole', 'mode': 'alpha'},
                  transform={'position': [960, 540], 'scale': [-100 if flip else 100, 100]})
    base = [ell('cup', 905, 545, 900, 1000, fill=PURPLE), ell('foot', 930, 1090, 720, 430, fill=PURPLE)]
    for i in range(7):                                  # 受け皿のふちの玉(左下の側)
        a = math.radians(150 + i * 13)
        base.append(ell(f'bd{i}', 905 + 462 * math.cos(a), 545 + 512 * math.sin(a), 52, 52, fill=PURPLE))
    for i in range(4):                                  # 右のふちの玉
        a = math.radians(-28 + i * 14)
        base.append(ell(f'br{i}', hc[0] + 410 * math.cos(a), hc[1] + 460 * math.sin(a), 44, 44, fill=PURPLE))
    layers = []
    return doc(f'再現 B10 ソウルジェムトランジション {tag}', n, layers + [ring] + top + [inner, hole] + base + [rig])


def _mk_b10(tag, key, n, s22, flip, off):
    @reg(key, 'B10', 'shape(だ円の輪・受け皿の影絵)+ 入れ子 S22 をだ円のマットで窓に + null の親で寄り')
    def _f(ctx):
        return _b10_doc(tag, n, s22, flip, off)
    return _f


for _a in _B10:
    _mk_b10(*_a)


# ---------------------------------------------------------------- B11 杏子立ち絵(仮: マネキン)
# 元は杏子の 3D モデル(8 着)の書き出し。2 巡目は comp-kit の mesh の mannequin(関節つきの人形)で仮置きする。
# 完成版のコマを見て合わせたもの: 頭の位置・大きさ(頭の中心 ≈ (888, 216)・頭の高さ ≈ 215)、腰の高さ、腕のポーズ(4 組)、服の色。

_K = 'scene/20_キャラ紹介後半/Blender/杏子立ち絵/'
SKIN, HAIR = '#f7dccd', '#a8324e'
# ポーズ(本人の右 = 画面の左): G1 = 右手を腰・左手を斜め下へ広げる / G2 = 左手を上げて振る / G3 = 右手を胸の前 / G4 = 左手を肩の高さでピース
_B11_POSE = {
    1: {'shoulder_r': [-22, 62, 46], 'elbow_r': 98, 'hand_r': 'fist', 'shoulder_l': [8, -30, 50], 'elbow_l': 12, 'hand_l': 'open'},
    2: {'shoulder_l': [0, -90, 118], 'elbow_l': 'WAVE', 'hand_l': 'open', 'shoulder_r': [0, 0, 30], 'elbow_r': 10, 'hand_r': 'open'},
    3: {'shoulder_r': [38, 25, 14], 'elbow_r': 138, 'hand_r': 'fist', 'shoulder_l': [0, -20, 30], 'elbow_l': 12, 'hand_l': 'open'},
    4: {'shoulder_l': [12, -80, 48], 'elbow_l': 118, 'hand_l': 'peace', 'shoulder_r': [0, 0, 28], 'elbow_r': 14, 'hand_r': 'mitt'},
}
# (枝番, 連番フォルダ, 枚数, ポーズの組, 色, 服)
_B11 = [
    ('01-1 私服パーカー', _K + '01-1_私服パーカー/1.02', 166, 1, {'top': '#8fb3a6', 'bottom': '#55698f', 'shoes': '#6a4a4a'}, {'sleeves': 1, 'pants': 0.1}),
    ('01-2 魔法少女服', _K + '01-2_魔法少女服/1.02', 166, 1, {'top': '#a32f48', 'bottom': '#a32f48', 'skirt': '#e68aa8', 'socks': '#3b2233', 'shoes': '#7a2338'}, {'sleeves': 0, 'pants': 0.08, 'skirt': 0.62, 'skirt_flare': 0.9, 'socks': 1.55}),
    ('02-1 制服', _K + '02-1_制服/1.02', 141, 2, {'top': '#efe7d2', 'bottom': '#6b6a5a', 'skirt': '#6b6a5a', 'socks': '#2c2a33', 'shoes': '#4a3a34'}, {'sleeves': 1, 'pants': 0.08, 'skirt': 0.6, 'skirt_flare': 0.8, 'socks': 1.3}),
    ('02-2 水着', _K + '02-2_水着/1.02', 141, 2, {'top': '#b12c3d', 'bottom': '#b12c3d', 'skirt': '#f0a696', 'shoes': SKIN}, {'sleeves': 0, 'pants': 0.06, 'skirt': 0.95, 'skirt_flare': 0.5}),
    ('03-1 赤ワンピ', _K + '03-1_赤ワンピ/1.03', 141, 3, {'top': '#c0434a', 'bottom': '#c0434a', 'skirt': '#c0434a', 'shoes': '#6a3a3a'}, {'sleeves': 0.2, 'pants': 0.05, 'skirt': 1.3, 'skirt_flare': 0.9}),
    ('03-2 白ワンピ', _K + '03-2_白ワンピ/1.02', 141, 3, {'top': '#ffffff', 'bottom': '#ffffff', 'skirt': '#ffffff', 'shoes': '#e8e0d8'}, {'sleeves': 0, 'pants': 0.05, 'skirt': 1.3, 'skirt_flare': 0.9}),
    ('04-1 シスター杏子', _K + '04-1_シスター杏子/1.04', 166, 4, {'top': '#1d1b22', 'bottom': '#1d1b22', 'skirt': '#1d1b22', 'shoes': '#2a2228'}, {'sleeves': 0.8, 'pants': 0.05, 'skirt': 1.15, 'skirt_flare': 1.0}),
    ('04-2 シスター杏子2', _K + '04-2_シスター杏子2/1.04', 166, 4, {'top': '#1d1b22', 'bottom': '#1d1b22', 'skirt': '#1d1b22', 'shoes': '#2a2228'}, {'sleeves': 0.8, 'pants': 0.05, 'skirt': 1.15, 'skirt_flare': 1.0}),
]
B11_GEOM = {'x': 915, 'feet_y': 1450, 'height': 1350, 'heads': 5.6}     # 連番の画面(1920×1080)での足もと・身長(完成版から目で合わせた)


def _sway(n, amp, ph=0.0, base=0.0, per=None):
    """ゆっくりした往復(呼吸・ゆれ)。n コマの間に per コマ周期の sin を 8 コマおきのキーで書く。"""
    per = per or max(60, n * 0.6)
    return {'k': [dict(f=f, v=round(base + amp * math.sin(2 * math.pi * (f / per + ph)), 3)) for f in range(0, n + 8, 8)]}


def _b11_doc(tag, n, grp, colors, outfit):
    """3D モデルの立ち絵の代わりのマネキン(仮)。座標は連番の画面(1920×1080)。立って、呼吸・体のゆれ・髪のゆれ・(G2 は)手を振る。"""
    g = B11_GEOM
    pose = dict(_B11_POSE[grp])
    if pose.get('elbow_l') == 'WAVE':
        pose['elbow_l'] = _sway(n, 14, 0.0, 48, per=44)
    pose.update({'root': [0, 0, _sway(n, 1.0)], 'chest': [_sway(n, 1.2, 0.25, 1.0, per=90), 0, _sway(n, -0.8)], 'head': [0, _sway(n, 2.5, 0.1), _sway(n, 2.0, 0.3, -3.0 if grp in (3, 4) else 0)],
                 'pony_1': [_sway(n, 3, 0.4, 4), _sway(n, 4, 0.55, 16), 0], 'pony_2': [0, _sway(n, 5, 0.7, 8), 0], 'pony_3': [0, _sway(n, 6, 0.85), 0]})
    fig = {'geometry': 'mannequin', 'style': 'mannequin', 'position': [0, 0, 0], 'rotation': [0, _sway(n, 3.0, 0.5, -4), 0],
           'body': {'height': g['height'], 'heads': g['heads'], 'thickness': 0.95, 'shoulder': 0.95},
           'colors': {'skin': SKIN, 'hair': HAIR, 'ribbon': '#1c1a1e', 'eyes': '#8a2030', **colors},
           'hair': {'style': 'ponytail', 'length': 0.5, 'thickness': 1.05}, 'outfit': outfit,
           'face': False, 'outline': {'width': 3, 'color': '#4a2a34'}, 'material': {'type': 'toon', 'toon_steps': 3}, 'preset': 'stand', 'pose': pose}   # 顔は描かない(のっぺらぼう)
    L = [layer('fig', 'mesh', n, {'light': {'ambient': 1.5, 'intensity': 1.3, 'direction': [-0.4, -0.8, -1]}, 'objects': [fig]}, pos=[g['x'], g['feet_y'], 0])]
    return doc(f'再現 B11 杏子立ち絵 {tag}(仮: マネキン)', n, L)


def _b11_puppet_doc(tag, n, grp, g, bone=False):
    """2D の立ち絵 + パーツ分解(puppet レイヤー)。頭の中心・頭の高さをマネキン(= 完成版に合わせた値)と同じにして置く。
    出せる動き = 呼吸・髪と服のゆれ・小さい首ふり・かしげ・体の傾き・まばたき。出せない = 腕のポーズ(手を腰・手を振る・こぶしを胸・ピース)と体の回転(絵のポーズのまま)。"""
    G = B11_GEOM
    hh = G['height'] / G['heads']
    head = [G['x'], G['feet_y'] - G['height'] + hh / 2]
    src = {}
    if bone:
        src.update(_b11_bone_pose(n, grp))
    L = [puppet_layer('fig', n, g, head, hh, seed=grp, wind=0.15, source=src)]
    return doc(f'再現 B11 杏子立ち絵 {tag}(仮: 2D 立ち絵 + 分解{" + 関節" if bone else ""} {g["puppet_id"]})', n, L)


def _b11_bone_pose(n, grp):
    """関節(ボーン)のポーズ(担当 PUP の BONE_USAGE.md の書式: pose_preset / pose_amount / pose。腕と脚は 正 = 外へ開く、[角度, 長さの倍率])。
    パペットに bones.json が無ければ効かない(エラーにはならず puppet と同じ絵)。完成版の 4 組のポーズを 2D の曲げで近づける。"""
    w = lambda amp, per, base=0.0, ph=0.0: psway(n, amp, per, ph, base)      # noqa: E731
    if grp == 1:      # 右手を腰・左手を斜め下へ広げる
        return {'pose_preset': 'hand_on_hip', 'pose_amount': 1, 'pose': {'shoulder_l': w(3, 120, 42), 'elbow_l': 6}}
    if grp == 2:      # 左手を上げて振る・右手は少し開く
        return {'pose': {'shoulder_l': 122, 'elbow_l': w(16, 44, 30), 'shoulder_r': 28}}
    if grp == 3:      # 右こぶしを胸の前・左手は少し開く
        return {'pose': {'shoulder_r': 18, 'elbow_r': [-128, 0.9], 'shoulder_l': w(2, 130, 26)}}
    return {'pose': {'shoulder_l': 44, 'elbow_l': [96, 0.95], 'shoulder_r': 26}}      # 左手を肩の高さでピース(手の形は変わらない)


def _mk_b11(sym, tag, key, n, grp, colors, outfit):
    g = find_puppet(sym)
    bone = PEOPLE == 'bone' and g is not None and has_bones(g['puppet_id'])      # 関節は、そのパペットに bones.json があるときだけ
    if g:
        how = (f'仮: 2D の立ち絵 + パーツ分解(puppet レイヤー {g["puppet_id"]} = 表の {g["key"]}。新しく生成した立ち絵・ユーザー未確認)。頭の位置と大きさは完成版に合わせた。'
               f'動き = 呼吸・髪ゆれ・首ふり・体の傾き・まばたき{"・関節のポーズ" if bone else ""}。腕のポーズ・体の回転は絵のまま(出せない)。AUP_PEOPLE=mannequin でマネキンに戻る')
    else:
        how = ('仮: マネキン(mesh の mannequin。体格・ポーズ・服の色を完成版に合わせた関節つきの人形)。元絵 = 杏子の 3D モデルの書き出し'
               + ('' if PEOPLE == 'mannequin' else f'。この衣装({sym})のパペットがまだ無いのでマネキンのまま'))

    @reg(key, 'B11', how, placeholder=True)
    def _f(ctx):
        if g:
            return _b11_puppet_doc(tag, n, grp, g, bone)
        return _b11_doc(tag, n, grp, colors, outfit)
    return _f


for _i, _a in enumerate(_B11):
    _mk_b11('ABCDEFGH'[_i], *_a)


# ---------------------------------------------------------------- P01 背景の写真(仮の板)

@reg('still:_ext/D/CloudData/GoogleDrive/MAD/魔法少女まどか☆マギカ/杏子整理/背景/Kyouko_church.jpg', 'P01',
     '仮の板: 冬枯れの木立と教会の影絵(shape)。元絵 = 教会の写真 Kyouko_church.jpg', placeholder=True)
def p01(ctx):
    """S12 1484-1517 の背景(白黒にして白を 80 % かぶせて使う)。完成版では葉の落ちた木と教会の建物が淡い灰色で見える。"""
    w, h, n = 1280, 720, 60
    L = []

    def tree(i, x, y0, hgt, th, lean, col):
        # 幹 + 枝(折れ線)。x・y0 = 根元
        top = (x + lean, y0 - hgt)
        L.append(layer(f'tr{i}', 'shape', n, {'kind': 'path', 'closed': False, 'fill': None, 'stroke': col, 'stroke_width': th, 'cap': 'round',
                                              'points': [[0, 0], [lean * 0.4, -hgt * 0.5], [lean, -hgt]]}, pos=[x, y0]))
        for j, (t, dx, dy) in enumerate(((0.45, -0.34, -0.3), (0.55, 0.36, -0.28), (0.7, -0.28, -0.26), (0.8, 0.3, -0.22), (0.95, -0.16, -0.2), (1.0, 0.2, -0.2))):
            bx, by = x + lean * t, y0 - hgt * t
            L.append(layer(f'br{i}_{j}', 'shape', n, {'kind': 'path', 'closed': False, 'fill': None, 'stroke': col, 'stroke_width': max(2, th * (0.5 - 0.05 * j)), 'cap': 'round',
                                                      'points': [[0, 0], [dx * hgt * 0.6, dy * hgt * 0.6], [dx * hgt * 1.0, dy * hgt * 1.5]]}, pos=[bx, by]))
    tree(0, 1130, 720, 640, 46, 30, '#3c3c3c')
    tree(1, 170, 720, 600, 34, -24, '#444444')
    tree(2, 880, 700, 430, 18, 10, '#5a5a5a')
    tree(3, 420, 700, 380, 14, -8, '#666666')
    # 教会(塔 + 身廊)
    L += [
        layer('spire', 'shape', n, {'kind': 'path', 'closed': True, 'fill': '#6e6e6e', 'points': [[-34, 0], [0, -120], [34, 0]]}, pos=[600, 300]),
        layer('tower', 'shape', n, {'kind': 'rect', 'width': 70, 'height': 250, 'fill': '#787878'}, pos=[600, 425]),
        layer('nave', 'shape', n, {'kind': 'rect', 'width': 330, 'height': 150, 'fill': '#828282'}, pos=[760, 480]),
        layer('roof', 'shape', n, {'kind': 'path', 'closed': True, 'fill': '#707070', 'points': [[-175, 0], [-150, -60], [150, -60], [175, 0]]}, pos=[760, 405]),
        layer('ground', 'shape', n, {'kind': 'rect', 'width': w, 'height': 170, 'fill': '#9a9a9a'}, pos=[w / 2, h - 85]),
        layer('sky', 'solid', n, {'color': '#c9c9c9'}),
    ]
    return doc('再現 P01 Kyouko_church(仮の板)', n, L, w=w, h=h)


# ---------------------------------------------------------------- V02 scene17 矢じり(帯ごと・キャラごとの書き出し 28 本)

# AviUtl のシーン 17 は、7 本の縦の帯(x = -925 … 85)に矢じりの輪郭が上っていく絵(緑の地)。
# 書き出しは「帯 1 本ぶんの段だけ表示」× キャラ 4 人(2・4 人目はフレームバッファの左右反転で鏡写し。
# 色は完成版を見て決めた: 2 人目だけ橙 #fea700、ほかは赤 #e65163。紫 #8f83be は共通)。
# いまのプロジェクトは最後の書き出しの状態(7 本目だけ表示・1 人目の色)なので、シーン 17 の文書を
# 「表示する段」「単色化の色」「左右」を差し替えて取り込み器(SceneBuilder)に通し、28 本ぶんを作る。
_S17_STRIPS = [(2, 7), (10, 16), (18, 20), (22, 26), (29, 35), (37, 43), (45, 47)]     # 帯ごとの段の範囲(頭 = グループ制御)
_S17_CHARS = [(1, '#e65163', False, 'scene/17_キャラ紹介矢じり/scene17_0.09_%02d-1.avi'),
              (2, '#fea700', True, 'scene/17_キャラ紹介矢じり/キャラ2/scene17_0.10キャラ2_%02d.avi'),
              (3, '#e65163', False, 'scene/17_キャラ紹介矢じり/キャラ3/scene17_0.10キャラ3_%02d.avi'),
              (4, '#e65163', True, 'scene/17_キャラ紹介矢じり/キャラ4/scene17_0.10キャラ4_%02d.avi')]
_AUP = {}


def _s17_doc(strip, color, mirror, name):
    import copy
    import types
    import aup_to_comp as A
    if 'doc' not in _AUP:
        _AUP['doc'] = json.load(open(os.path.join(SAKURA, '1.05.json'), encoding='utf-8'))
        _AUP['mats'] = AM.Materials(sakura=SAKURA, root=None, api='http://127.0.0.1:8002', project_id=PID, budget_mb=0, rebuild=REBUILD)
    src = _AUP['doc']
    lo, hi = _S17_STRIPS[strip - 1]
    objs = []
    for o in src['exedit']['objects']:
        if o['scene'] != 17:
            objs.append(o)
            continue
        if not (o['layer'] == 1 or lo <= o['layer'] <= hi) or (o['layer'] != 1 and o['start'] >= 60):
            continue
        o = copy.deepcopy(o)
        for f in o['filters']:
            if f['name'] == '単色化' and o['filters'][0]['name'] == 'グループ制御':
                f['exdata']['color'] = color.lstrip('#')
            if mirror and f['name'] in ('斜めクリッピング', 'マスク'):
                for t in f['tracks']:
                    if t['name'] in ('中心X', 'X'):
                        for k in ('value', 'left', 'right'):
                            if isinstance(t.get(k), (int, float)):
                                t[k] = -t[k]
        objs.append(o)
    scenes = []
    for s in src['exedit']['scenes']:
        if s['index'] == 17:
            s = dict(s, layer_settings=[dict(ls, hidden=False) for ls in s['layer_settings']])
        scenes.append(s)
    d2 = dict(src, exedit=dict(src['exedit'], objects=objs, scenes=scenes))
    opts = types.SimpleNamespace(avi_as_scene=False, avi_ok=set(), avi_dropped=set(), recreate_map={}, variants={}, drop_disabled=True,
                                 fetch=False, fetch_seq_scenes=set(), matte_copy=False, seq_filter=None, _stack=[])
    b = A.SceneBuilder(d2, 17, _AUP['mats'], lambda sn: _CM.get(str(sn)), opts)
    data, _dur = b.build()
    return doc(name, 170, data['layers'], bg=data.get('bg'))


def _mk_s17(ch, color, mirror, pat, strip):
    @reg(pat % strip, 'V02', 'シーン 17 を「帯 1 本だけ表示・キャラの色・(2/4 人目は)鏡写し」に差し替えて取り込み直した comp')
    def _f(ctx):
        return _s17_doc(strip, color, mirror, f'再現 V02 矢じり キャラ{ch} 帯{strip:02d}')
    return _f


for _ch, _col, _mir, _pat in _S17_CHARS:
    for _k in range(1, 8):
        _mk_s17(_ch, _col, _mir, _pat, _k)
