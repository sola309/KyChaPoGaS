#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""recreate.py の共通部品(登録簿と小道具)。作り直しの本体は recreate_g*.py に分けて書く。"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aup_materials as AM   # noqa: E402

SAKURA = AM.SAKURA
W, H, FPS = 1920, 1080, 60
PID = int(os.environ.get('AUP_PROJECT', '36'))     # 作る先のプロジェクト(recreate.py --project-id が環境変数に入れる。37 = 元素材を使わない作り直し)
REBUILD = PID != 36


def scene_comps():
    """AviUtl のシーン番号(文字列)→ そのプロジェクトでの comp id。"""
    return json.load(open(os.path.join(SAKURA, 'comp_map.json'), encoding='utf-8')).get(str(PID), {})


BUILDERS = {}     # key(連番フォルダの相対パス)→ (台帳 ID, 関数, メモ)


def reg(key, lid, how, placeholder=False):
    def deco(fn):
        BUILDERS[key] = {'id': lid, 'fn': fn, 'how': how, 'placeholder': placeholder}
        return fn
    return deco


# ---------------------------------------------------------------- 小道具

def kf(*pts):
    """kf((f, v, 'outQuad'), (f, v), ...) → キーフレーム値。3 つ目の加減速は「そのキーから次のキーまで」(エンジンと同じ = 区間の頭に書く)。
    着地の側に書きたいときは kfa を使う。最後のキーに書いた加減速は効かない。"""
    return {'k': [dict(f=p[0], v=p[1], **({'e': p[2]} if len(p) > 2 else {})) for p in pts]}


def kfa(*pts):
    """kfa((f, v), (f, v, 'outCirc'), ...): 3 つ目は「このキーへ着くまでの」加減速(着地の側に書く流儀)。
    エンジンは区間の頭のキーの e を使うので、1 個前のキーへずらして入れる。kf と混ぜて使わないこと(1 区間ずれて、直線のまま動く原因になる)。"""
    ks = [dict(f=p[0], v=p[1]) for p in pts]
    for i in range(1, len(pts)):
        if len(pts[i]) > 2:
            ks[i - 1]['e'] = pts[i][2]
    return {'k': ks}


_EZ = {'linear': lambda t: t, 'inQuad': lambda t: t * t, 'outQuad': lambda t: 1 - (1 - t) ** 2, 'inCubic': lambda t: t ** 3, 'outCubic': lambda t: 1 - (1 - t) ** 3,
       'inQuart': lambda t: t ** 4, 'outQuart': lambda t: 1 - (1 - t) ** 4, 'inExpo': lambda t: 0.0 if t <= 0 else 2 ** (10 * (t - 1)), 'outExpo': lambda t: 1.0 if t >= 1 else 1 - 2 ** (-10 * t),
       'inCirc': lambda t: 1 - math.sqrt(max(0.0, 1 - t * t)), 'outCirc': lambda t: math.sqrt(max(0.0, 1 - (1 - t) ** 2)),
       'inOutQuad': lambda t: 2 * t * t if t < 0.5 else 1 - 2 * (1 - t) ** 2, 'inOutCubic': lambda t: 4 * t ** 3 if t < 0.5 else 1 - 4 * (1 - t) ** 3}


def retime(keys, f0, f1, ease, step=2):
    """道のり(keys = [(f, v), …]。直線でつないだ道)の形はそのままに、f0〜f1 のあいだの進み方だけを ease の曲線に置き換える。
    途中のキーを通る道を「1 本の加減速」で進ませたいときに使う(キーごとに加減速を書くと、キーのたびに止まって見える)。
    → [(f, v), …](step コマごとの密なキー。区間の外のキーはそのまま)。v は数の並び。"""
    ks = sorted(keys, key=lambda k: k[0])
    inside = [k for k in ks if f0 <= k[0] <= f1]
    assert inside and inside[0][0] == f0 and inside[-1][0] == f1, 'f0・f1 はキーのあるコマにする'
    # 道のりの長さで媒介変数を取る
    def dist(a, b):
        return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b))) if isinstance(a, (list, tuple)) else abs(a - b)
    cum = [0.0]
    for a, b in zip(inside, inside[1:]):
        cum.append(cum[-1] + dist(a[1], b[1]))
    total = cum[-1] or 1.0

    def at(u):
        d = u * total
        for i in range(len(inside) - 1):
            if d <= cum[i + 1] or i == len(inside) - 2:
                seg = (cum[i + 1] - cum[i]) or 1.0
                t = min(1.0, max(0.0, (d - cum[i]) / seg))
                a, b = inside[i][1], inside[i + 1][1]
                return [round(x + (y - x) * t, 3) for x, y in zip(a, b)] if isinstance(a, (list, tuple)) else round(a + (b - a) * t, 4)
    fn = _EZ[ease]
    out = [k[:2] for k in ks if k[0] < f0]
    f = f0
    while f < f1:
        out.append((f, at(fn((f - f0) / (f1 - f0)))))
        f += step
    out.append((f1, at(1.0)))
    out += [k[:2] for k in ks if k[0] > f1]
    return out


SPLINE_KEYS = {'position', 'scale', 'rotation', 'anchor', 'target', 'offset', 'zoom', 'head_turn', 'head_tilt', 'body_lean'}


def auto_spline(node, name=None, stat=None):
    """完成版を見て数コマおきに打ったキーの列(直線でつないだ道)を、キーを通るなめらかな補間(interp: "spline")にする。
    直線のままだとキーのたびに速さが折れて、かくかくした動きになる(元は Blender の F カーブ = なめらか)。
    対象: 位置・拡大・回転・カメラの目標など(SPLINE_KEYS)で、キーが 3 個以上あり、加減速の無い区間が 2 つ以上続く物。
    加減速 e を書いた区間・hold・0.5 コマ未満の区間(飛び)はエンジンがスプラインから外す。"""
    stat = stat if stat is not None else {'n': 0}
    if isinstance(node, dict):
        k = node.get('k')
        if isinstance(k, list) and name in SPLINE_KEYS and 'interp' not in node and len(k) >= 3:
            run = best = 0
            for a, b in zip(k, k[1:]):
                ok = not a.get('e') and b['f'] - a['f'] >= 0.5 and isinstance(a.get('v'), (int, float, list)) and a.get('v') != b.get('v')
                run = run + 1 if ok else 0
                best = max(best, run)
            if best >= 2:
                node['interp'] = 'spline'
                stat['n'] += 1
            return stat
        for key, v in node.items():
            auto_spline(v, key if not isinstance(v, list) or key in SPLINE_KEYS or True else name, stat) if not isinstance(v, list) else [auto_spline(x, key if key in SPLINE_KEYS else None if isinstance(x, dict) and ('type' in x or 'geometry' in x or 'id' in x) else key, stat) for x in v]
    elif isinstance(node, list):
        for x in node:
            auto_spline(x, name, stat)
    return stat


def layer(id, type, n, source=None, pos=None, **kw):
    L = {'id': id, 'type': type, 'in': kw.pop('t0', 0), 'out': kw.pop('t1', n)}
    tr = kw.pop('transform', None) or {}
    if pos is not None:
        tr['position'] = pos
    if tr:
        L['transform'] = tr
    if source is not None:
        L['source'] = source
    L.update(kw)
    return L


def petals(id, n, seed=1, rate=20, life=5, size=30, colors=('#ffd9e4', '#ffb7cd', '#ffffff'), wind=(120, 0, 0), gravity=(0, 60, 0),
           area=(2400, 1300, 0), pos=(960, 540), pre=300, sprite='petal', **extra):
    """画面全体に舞う花びら(粒子)。pre コマぶん前から出しておく(頭のコマからもう舞っている)。"""
    em = {'preset': 'petals', 'sprite': sprite, 'position': [0, 0, 0], 'emit': 'box', 'area': list(area), 'rate': rate, 'life': life,
          'size': [size, size], 'size_random': 0.6, 'wind': list(wind), 'gravity': list(gravity), 'colors': list(colors),
          'opacity': [0, 100, 100, 100, 0]}
    em.update(extra)
    return layer(id, 'particles', n, {'seed': seed, 'emitter': em}, pos=list(pos), t0=-pre)


def doc(name, n, layers, bg=None, fps=FPS, w=W, h=H):
    return {'name': name, 'fps': fps, 'duration_frames': n, 'width': w, 'height': h, 'data': {'version': 1, 'bg': bg, 'layers': layers}}




# ---------------------------------------------------------------- 人物の置き方(v3): mannequin / puppet / bone
# 3D モデルの人物の所(B11 キャラ紹介・B14 屋上・B25c ポッキーゲーム)を何で置くか。AUP_PEOPLE=mannequin R/rec.sh B11 で元のマネキンに戻せる。
#   mannequin = mesh の関節つきの人形(色だけ) / puppet = 2D の立ち絵をパーツ分解した puppet レイヤー / bone = puppet + 関節(ボーン)のポーズ(書式が出るまでは puppet と同じ)
PEOPLE = os.environ.get('AUP_PEOPLE', 'auto')      # 既定 auto = 関節(bones.json)のあるパペットは bone、無ければ puppet、パペットが無ければ mannequin。puppet = 関節を使わない
P2D_JSON = '/tmp/claude-1000/sakura-rebuild/P2D/puppets.json'      # 担当 KEY が衣装ごとに作ったパペットの表(順に増える)
BONE_USAGE = '/tmp/claude-1000/sakura-rebuild/PUP/BONE_USAGE.md'   # 関節(ボーン)の書式(担当 PUP)。あれば bone 版を組める
_PUP_API = os.environ.get('AUP_API', 'http://127.0.0.1:8002')
_PUP_GEOM = {}


def puppet_table():
    """puppets.json を {キー: {puppet_id, …}} で返す(無ければ空)。書式のゆれ(一覧 / 辞書)は吸収する。"""
    try:
        d = json.load(open(P2D_JSON, encoding='utf-8'))
    except Exception:
        return {}
    if isinstance(d, dict) and isinstance(d.get('puppets'), (dict, list)):
        d = d['puppets']
    if isinstance(d, list):
        d = {str(e.get('key') or e.get('記号') or e.get('symbol') or e.get('name') or i): e for i, e in enumerate(d) if isinstance(e, dict)}
    return {str(k): v for k, v in d.items() if isinstance(v, dict) and v.get('puppet_id')} if isinstance(d, dict) else {}


def puppet_geom(pid):
    """パペットの manifest から、キャンバス・人物の箱・頭の中心と高さ(キャンバスの px)。読めなければ None。"""
    if pid in _PUP_GEOM:
        return _PUP_GEOM[pid]
    g = None
    try:
        import urllib.request
        with urllib.request.urlopen(f'{_PUP_API}/api/puppet/{pid}/manifest', timeout=20) as r:
            m = json.load(r)
        cw, ch = m['canvas'][:2]
        bbs = [L['bbox'] for L in m.get('layers', []) if L.get('bbox')]
        box = [min(b[0] for b in bbs), min(b[1] for b in bbs), max(b[2] for b in bbs), max(b[3] for b in bbs)]
        face = next((L['bbox'] for L in m['layers'] if L.get('name') == 'face' and L.get('bbox')), None)
        if face:      # 顔の箱(額〜あご)の 1.28 倍 = 頭の高さ(頭頂〜あご)
            hh = (face[3] - face[1]) * 1.28
            head = [(face[0] + face[2]) / 2, face[3] - hh / 2]
        else:         # 顔のレイヤーが無い(後ろ姿など): 人物の箱の上 1/6.3 を頭とみなす
            hh = (box[3] - box[1]) / 6.3
            head = [(box[0] + box[2]) / 2, box[1] + hh / 2]
        g = {'puppet_id': pid, 'canvas': [cw, ch], 'box': box, 'head': head, 'head_h': hh, 'layers': [L.get('name') for L in m['layers']]}
    except Exception as e:      # noqa: BLE001
        print('puppet_geom: 読めない', pid, e)
    _PUP_GEOM[pid] = g
    return g


def find_puppet(sym, view=None):
    """衣装の記号(A〜H)と向き(None = 正面 / 'back' = 後ろ姿 / 'side' = 横顔)→ puppet_geom。無ければ None。
    A の正面だけは、表に無くても既存の kyoko_parka_r2(検証用のパーカー)を使う。"""
    if PEOPLE == 'mannequin':
        return None
    words = {'back': ('back', '後ろ', 'うしろ'), 'side': ('side', 'prof', '横')}
    allw = words['back'] + words['side']
    for k, v in puppet_table().items():
        st = str(v.get('status') or v.get('状態') or '')
        if any(x in st for x in ('失敗', 'まだ', 'NG', 'fail')):
            continue
        kl = k.lower()
        if not (k.upper().startswith(sym) or kl.startswith(sym.lower())):
            continue
        if view is None and (len(k) == 1 or not any(w in kl for w in allw)) or view is not None and any(w in kl for w in words[view]):
            g = puppet_geom(v['puppet_id'])
            if g:
                bx = v.get('box') or v.get('bbox') or v.get('person_box') or v.get('人物の箱')
                if isinstance(bx, list) and len(bx) == 4 and not v.get('_box_used'):
                    g = dict(g, box=bx)
                return dict(g, key=k)
    if sym == 'A' and view is None:
        g = puppet_geom('kyoko_parka_r2')
        return g and dict(g, key='A(検証用 kyoko_parka_r2)')
    return None


def has_bones(pid):
    """そのパペットに関節(bones.json。担当 PUP の make_bones.py が作る)があるか。"""
    return os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'backend', 'data', 'puppets', pid, 'bones.json'))


def use_bones(pid):
    """このパペットで関節のポーズを付けるか(AUP_PEOPLE が auto / bone で、bones.json があるとき)。"""
    return PEOPLE in ('auto', 'bone') and has_bones(pid)


def psway(n, amp, per, ph=0.0, base=0.0, step=8):
    """ゆっくりした往復のキー(呼吸・首ふり・体の傾き)。"""
    return {'k': [dict(f=f, v=round(base + amp * math.sin(2 * math.pi * (f / per + ph)), 4)) for f in range(0, n + step, step)]}


def puppet_layer(id, n, g, head_center, head_h, seed=0, wind=0.0, sway=1.0, turn=0.22, **kw):
    """puppet レイヤー。パペットの頭の中心を head_center(comp の px)に、頭の高さを head_h に合わせて置く(= マネキンと同じ合わせ方)。
    付ける動き(puppet で出せる物だけ): 呼吸・髪と服のゆれ・小さい首ふり・かしげ・体の傾き・自動まばたき。腕・脚は動かない。"""
    s = head_h / g['head_h'] * 100
    cw, ch = g['canvas']
    src = {'puppet_id': g['puppet_id'], 'auto_blink': True, 'blink_interval': 3.1 + 0.37 * (seed % 5), 'blink_seed': 11 + seed,
           'head_turn': psway(n, turn, 150 + 13 * seed, 0.1 * seed), 'head_tilt': psway(n, 2.2, 190 + 9 * seed, 0.3 + 0.17 * seed),
           'body_lean': psway(n, 1.1, 170 + 11 * seed, 0.55 + 0.11 * seed), 'breath': 1, 'sway': sway, 'wind': wind, 'sway_seed': 3 + seed}
    src.update(kw.pop('source', {}))
    return layer(id, 'puppet', n, src, transform={'anchor': [g['head'][0] - cw / 2, g['head'][1] - ch / 2], 'position': list(head_center), 'scale': [round(s, 3), round(s, 3)]}, **kw)
