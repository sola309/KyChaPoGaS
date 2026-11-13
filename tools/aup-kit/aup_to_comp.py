#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AviUtl(拡張編集)のプロジェクト(aup_parse.py の JSON)→ KyChaPoGaS のコンポジション文書。

    python3 aup_to_comp.py 1.05.json --scene 36 --project-id 36 --api http://127.0.0.1:8002 --fetch
    python3 aup_to_comp.py 1.05.json --scene 1 --dry-run out.json          # 文書だけ書く(API を使わない)
    python3 aup_to_comp.py 1.05.json --all --project-id 36                 # 全シーン

対応づけは reference/aviutl_mad/ANALYSIS.md の 7 章のとおり。要点:
  - AviUtl のシーン 1 個 = コンポジション 1 個。中に置くシーン(シーンオブジェクト・`sceneNN_*.avi`)は先に作る。
  - 中間点でつながった区間は 1 レイヤーにまとめ、区間の境目をキーフレームにする。
  - レイヤー番号が大きいほど手前 → 配列は逆順(先頭が手前)。
  - フィルタは上から順に effects に入れる(offset / clip_line / crop / mask / mask_image / blinds / fill …)。
  - 対応が無いものは {"type":"aviutl_script","name","params","raw"} として残す。
同じシーンをもう一度流すと、同じコンポジションを書き換える(comp_map.json)。
"""
import argparse
import collections
import json
import math
import os
import re
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import aup_materials as AM  # noqa: E402

# ------------------------------------------------------------------ イージング

PENNER_KINDS = ['Quad', 'Cubic', 'Quart', 'Quint', 'Sine', 'Expo', 'Circ', 'Elastic', 'Back', 'Bounce']
PENNER_DIRS = ['in', 'out', 'inOut', 'outIn']


def penner_name(n):
    """イージング番号(UndoFish 氏 easing_aviutl.lua)→ 名前。1 = linear、2〜41 は 4 個ずつ in/out/inOut/outIn。"""
    try:
        n = int(n)
    except Exception:
        return 'linear'
    if n <= 1 or n > 41:
        return 'linear'
    k, d = divmod(n - 2, 4)
    return PENNER_DIRS[d] + PENNER_KINDS[k]


def _bounce_out(t):
    n, d = 7.5625, 2.75
    if t < 1 / d:
        return n * t * t
    if t < 2 / d:
        t -= 1.5 / d
        return n * t * t + 0.75
    if t < 2.5 / d:
        t -= 2.25 / d
        return n * t * t + 0.9375
    t -= 2.625 / d
    return n * t * t + 0.984375


def _ease_in(kind, t, s=1.70158):
    if kind == 'Quad':
        return t * t
    if kind == 'Cubic':
        return t ** 3
    if kind == 'Quart':
        return t ** 4
    if kind == 'Quint':
        return t ** 5
    if kind == 'Sine':
        return 1 - math.cos(t * math.pi / 2)
    if kind == 'Expo':
        return 0.0 if t <= 0 else 2 ** (10 * (t - 1))
    if kind == 'Circ':
        return 1 - math.sqrt(max(0.0, 1 - t * t))
    if kind == 'Elastic':
        if t <= 0 or t >= 1:
            return float(t >= 1)
        p = 0.3
        return -(2 ** (10 * (t - 1))) * math.sin((t - 1 - p / 4) * 2 * math.pi / p)
    if kind == 'Back':
        return t * t * ((s + 1) * t - s)
    if kind == 'Bounce':
        return 1 - _bounce_out(1 - t)
    return t


def ease_value(name, t):
    """名前つきイージングの値(焼き込み用)。"""
    if t <= 0:
        return 0.0
    if t >= 1:
        return 1.0
    if name == 'hold':
        return 0.0
    if name == 'linear' or not name:
        return t
    m = re.match(r'^(inOut|outIn|in|out)([A-Z][a-z]+)$', name)
    if not m:
        return t
    d, k = m.groups()
    if d == 'in':
        return _ease_in(k, t)
    if d == 'out':
        return 1 - _ease_in(k, 1 - t)
    if d == 'inOut':
        return _ease_in(k, t * 2) / 2 if t < 0.5 else 1 - _ease_in(k, (1 - t) * 2) / 2
    return (1 - _ease_in(k, 1 - t * 2)) / 2 if t < 0.5 else 0.5 + _ease_in(k, t * 2 - 1) / 2


# ------------------------------------------------------------------ 書体

def map_font(name, bold=False):
    """AviUtl の書体名 → (CSS の書体名, weight, メモ)。市販の書体は Noto に置き換える。"""
    n = (name or '').lstrip('@')
    w = 700 if bold else 400
    if 'あんず' in n:
        return 'APJapanesefont', w, None
    if n.startswith('Noto Sans JP') or n.startswith('Noto Sans CJK'):
        ws = {'Thin': 100, 'Light': 300, 'DemiLight': 350, 'Regular': 400, 'Medium': 500, 'Bold': 700, 'Black': 900}
        for k, v in ws.items():
            if n.endswith(k):
                return 'Noto Sans JP', v, None
        return 'Noto Sans JP', w, None
    if '小塚明朝' in n or 'Kozuka Mincho' in n:
        ww = 700 if re.search(r'\b(B|H)$', n) else 300 if re.search(r'\b(L|EL)$', n) else 400
        return 'Noto Serif JP', ww, f'{n} の代わり'
    if '小塚ゴシック' in n or 'Kozuka Gothic' in n:
        ww = 900 if re.search(r'\bH$', n) else 700 if re.search(r'\bB$', n) else 400
        return 'Noto Sans JP', ww, f'{n} の代わり'
    if any(k in n for k in ('Caslon', 'Cambria', 'Arabic', '明朝', 'Mincho', 'Times')):
        return 'Noto Serif JP', 700 if 'Bold' in n else w, f'{n} の代わり'
    if any(k in n for k in ('Impact', 'Arial Black', 'あかずきん', 'Heavy')):
        return 'Noto Sans JP', 900, f'{n} の代わり'
    if 'Dubai' in n:
        return 'Noto Sans JP', 500 if 'Medium' in n else w, f'{n} の代わり'
    return 'Noto Sans JP', w, (f'{n} の代わり' if n else None)


# AviUtl のサイズと CSS の font-size(em)の比。
# はじめは「サイズ = Windows の文字セルの高さ(ascent + descent)」と読んで Noto Sans JP に 0.69 などを掛けたが、
# 完成動画(シーン 1 の 400 コマ目「Sakura Kyoko」= Noto Sans JP Black/Thin)と比べると小さすぎた。
# サイズ = em(lfHeight が負の指定)として 1.0 で合う。書体ごとに直したくなったらここに (名前の一部, 係数) を足す。
EM_PER_CELL = []


# 置き換えた書体の見かけの大きさ合わせ(元の書体は em に対して字が小さい)。完成動画と見比べて決めた値。
SUBST_SCALE = {'Adobe Arabic': 0.74}


def em_factor(name):
    n = (name or '').lstrip('@')
    for k, v in EM_PER_CELL:
        if n.startswith(k) or k in n:
            return v
    return 1.0


CAM_ROLL_SIGN = 1      # カメラの rotation.z の向き(エンジンの決めに合わせる。完成動画と見比べて決めた)
BLEND = {'通常': 'normal', '加算': 'add', '減算': 'subtract', '乗算': 'multiply', 'スクリーン': 'screen',
         'オーバーレイ': 'overlay', '比較(明)': 'lighten', '比較(暗)': 'darken', '輝度': 'luminosity',
         '色差': 'color_diff', '陰影': 'shade', '明暗': 'light_dark', '差分': 'difference'}
MASK_SHAPES = {1: 'ellipse', 2: 'rect', 3: 'triangle', 4: 'pentagon', 5: 'hexagon', 6: 'star'}


def hexcol(c):
    return '#' + (c or 'ffffff').lower().rjust(6, '0')[-6:]


def yc_to_rgb(hexs):
    """クロマキーの color_yc(Y, Cb, Cr の int16 LE。Y 0〜4096、Cb/Cr ±2048)→ '#rrggbb'。"""
    try:
        b = bytes.fromhex(hexs)
        y, cb, cr = (int.from_bytes(b[i:i + 2], 'little', signed=True) for i in (0, 2, 4))
    except Exception:
        return '#00ff00'
    r = (255 * y + ((((22881 * cr) >> 16) + 3) << 10)) >> 12
    g = (255 * y + ((((-5616 * cb) >> 16) + ((-11655 * cr) >> 16) + 3) << 10)) >> 12
    bl = (255 * y + ((((28919 * cb) >> 16) + 3) << 10)) >> 12
    q = lambda v: max(0, min(255, v))
    return '#%02x%02x%02x' % (q(r), q(g), q(bl))


def parse_params(s):
    """スクリプトの設定文字列 'a=1;b="x";c=0xff' → dict。"""
    out = {}
    for part in re.split(r';(?=(?:[^"]*"[^"]*")*[^"]*$)', s or ''):
        if '=' not in part:
            continue
        k, v = part.split('=', 1)
        k, v = k.strip(), v.strip()
        if k.startswith('local '):
            k = k[6:].strip()
        if v.startswith('"') and v.endswith('"'):
            v = v[1:-1]
        else:
            try:
                v = int(v, 16) if v.lower().startswith('0x') else (float(v) if '.' in v else int(v))
            except Exception:
                pass
        out[k] = v
    return out


def col_param(v, default='#ffffff'):
    if isinstance(v, (int, float)):
        return '#%06x' % (int(v) & 0xffffff)
    if isinstance(v, str):
        try:
            return '#%06x' % (int(v, 16) & 0xffffff)
        except Exception:
            return default
    return default


# ------------------------------------------------------------------ 鎖(中間点をまとめたオブジェクト)

class Chain:
    def __init__(self, segs):
        segs.sort(key=lambda o: o['start'])
        self.segs = segs
        o = segs[0]
        self.o = o
        self.id = o.get('chain', {}).get('leader', o['id'])
        self.scene, self.layer = o['scene'], o['layer']
        self.start, self.end = segs[0]['start'], segs[-1]['end']
        self.kind = o['filters'][0]['name']
        self.lid = f'o{self.id}'
        self.disabled = bool(o.get('disabled'))

    def filt(self, i):
        return self.o['filters'][i]

    def track(self, fi, name):
        """[(区間の開始, 終了, トラック)] を返す。"""
        out = []
        for s in self.segs:
            for t in s['filters'][fi]['tracks']:
                if t['name'] == name:
                    out.append((s['start'], s['end'], t))
                    break
        return out


def seg_ease(t):
    """1 区間のトラック → (補間の名前, 中間点無視か)。"""
    mode = t.get('mode')
    acc, dec = t.get('accel'), t.get('decel')
    ad = 'inOutQuad' if (acc and dec) else 'inQuad' if acc else 'outQuad' if dec else None
    if mode is None or mode == '移動無し':
        return None, False
    if mode == '瞬間移動':
        return 'hold', False
    if mode == '中間点無視':
        return ad or 'linear', True
    if mode == 'スクリプト':
        if 'イージング' in (t.get('script') or ''):
            return t.get('easing') or penner_name(t.get('param')), False
        return ad or 'linear', False
    # 直線移動・加減速移動・ほか
    if mode == '加減速移動':
        return ad or 'inOutQuad', False
    return ad or 'linear', False


class Conv:
    """トラック → プロパティ値。"""

    def __init__(self, chain, stats):
        self.c = chain
        self.stats = stats

    def scalar(self, fi, name, fn=lambda v: v):
        """[(f, v, e)] のキー列(1 個なら定数)を返す。"""
        tr = self.c.track(fi, name)
        if not tr:
            return [(self.c.start, fn(0), None)]
        s0, e0, t0 = tr[0]
        if 'mode' not in t0 or t0.get('mode') == '移動無し':
            return [(s0, fn(t0.get('value', t0.get('left', 0))), None)]
        ez, ign = seg_ease(t0)
        last = tr[-1]
        self.stats['ease'][ez + ('(中間点無視)' if ign else '')] += 1
        if ign:
            keys = [(s0, fn(t0['left']), ez), (last[1], fn(last[2].get('right', last[2].get('left'))), None)]
        else:
            keys = []
            for (s, e, t) in tr:
                ez, _ = seg_ease(t)
                keys.append((s, fn(t.get('left', t.get('value', 0))), ez or 'linear'))
            if keys[-1][2] == 'hold':
                keys.append((last[1] + 1, fn(last[2].get('left')), None))
            else:
                keys.append((last[1], fn(last[2].get('right', last[2].get('left'))), None))
        if all(abs(k[1] - keys[0][1]) < 1e-9 for k in keys):
            return [(s0, keys[0][1], None)]
        # 1 コマだけの鎖などでキーのコマが重なったら後ろを 1 つずらす
        out = []
        for k in keys:
            if out and k[0] <= out[-1][0]:
                k = (out[-1][0] + 1, k[1], k[2])
            out.append(k)
        if len(keys) == 2 and ign:
            self.stats['ignore_mid'] += 1
        return out

    @staticmethod
    def eval_keys(keys, f):
        if len(keys) == 1 or f <= keys[0][0]:
            return keys[0][1]
        for (a, b) in zip(keys, keys[1:]):
            if f < b[0]:
                t = (f - a[0]) / (b[0] - a[0])
                return a[1] + (b[1] - a[1]) * ease_value(a[2], t)
        return keys[-1][1]

    @staticmethod
    def r(v):
        return round(v, 4)

    def prop(self, fi, name, fn=lambda v: v):
        keys = self.scalar(fi, name, fn)
        if len(keys) == 1:
            return self.r(keys[0][1])
        return self._kf([(f, self.r(v), e) for f, v, e in keys])

    @staticmethod
    def _kf(keys):
        k = []
        for f, v, e in keys:
            d = {'f': f, 'v': v}
            if e and e != 'linear':
                d['e'] = e
            k.append(d)
        return {'k': k}

    def vec(self, comps, combine=None):
        """comps = [(fi, name, fn) | 定数]。成分ごとのキー列をまとめて配列のプロパティ値にする。
        combine があれば成分の値の並び → 出力の配列(例: 拡大率 × X × Y)。
        成分でキーの位置か補間が違うときは 1 コマずつの値に焼く。"""
        lists = []
        for c in comps:
            if isinstance(c, (int, float)):
                lists.append([(self.c.start, float(c), None)])
            else:
                lists.append(self.scalar(*c))
        comb = combine or (lambda vs: vs)
        anim = [l for l in lists if len(l) > 1]
        if not anim:
            return [self.r(v) for v in comb([l[0][1] for l in lists])]
        sig = [(k[0], k[2]) for k in anim[0]]
        if all([(k[0], k[2]) for k in l] == sig for l in anim) and (combine is None or len(anim) == 1):
            keys = []
            for i, (f, e) in enumerate(sig):
                vs = [l[i][1] if len(l) > 1 else l[0][1] for l in lists]
                keys.append((f, [self.r(v) for v in comb(vs)], e))
            return self._kf(keys)
        self.stats['baked'] += 1
        f0 = min(l[0][0] for l in anim)
        f1 = max(l[-1][0] for l in anim)
        keys = []
        for f in range(f0, f1 + 1):
            keys.append((f, [self.r(v) for v in comb([self.eval_keys(l, f) for l in lists])], None))
        return self._kf(keys)

    def calc(self, comps, fn):
        """成分の値の並び → 1 個の数。成分が動くならキー(必要なら 1 コマずつ)にする。"""
        v = self.vec(comps, combine=lambda vs: [fn(vs)])
        if isinstance(v, dict):
            return {'k': [dict(k, v=k['v'][0]) for k in v['k']]}
        return v[0]

    def const(self, fi, name, default=0):
        tr = self.c.track(fi, name)
        if not tr:
            return default
        t = tr[0][2]
        return t.get('value', t.get('left', default))

    def is_anim(self, fi, name):
        return len(self.scalar(fi, name)) > 1


# ------------------------------------------------------------------ テキスト

TAG_RE = re.compile(r'<(s|#|p|w|r|c)([^>]*)>')


def text_runs(text, size, font, bold, notes):
    """制御文字 <s大きさ,書体> を runs に分ける。ほかの制御文字は取り除いて数える。"""
    runs = []
    cur_size, cur_font = size, font
    pos = 0
    for m in TAG_RE.finditer(text):
        if m.start() > pos:
            runs.append((text[pos:m.start()], cur_size, cur_font))
        pos = m.end()
        if m.group(1) == 's':
            a = m.group(2).split(',')
            cur_size = float(a[0]) if a[0].strip() else size
            cur_font = a[1].strip() if len(a) > 1 and a[1].strip() else font
        else:
            notes['text_tag_' + m.group(1)] += 1
    if pos < len(text):
        runs.append((text[pos:], cur_size, cur_font))
    return runs


# ------------------------------------------------------------------ シーン → 文書

class SceneBuilder:
    def __init__(self, doc, scene_no, mats, comp_of, opts):
        self.doc = doc
        ex = doc['exedit']
        self.sc = next(s for s in ex['scenes'] if s['index'] == scene_no)
        self.no = scene_no
        self.W, self.H = self.sc['width'] or doc['project']['width'], self.sc['height'] or doc['project']['height']
        self.fps = doc['project']['fps']
        self.mats = mats
        self.comp_of = comp_of          # シーン番号 → comp id(無ければ None)
        self.opts = opts
        self.hidden = {ls['layer'] for ls in self.sc['layer_settings'] if ls.get('hidden')}
        by = collections.defaultdict(list)
        for o in ex['objects']:
            if o['scene'] == scene_no:
                by[o.get('chain', {}).get('leader', o['id'])].append(o)
        self.chains = sorted((Chain(v) for v in by.values()), key=lambda c: (c.layer, c.start))
        self.stats = {'ease': collections.Counter(), 'ignore_mid': 0, 'baked': 0}
        self.rep = {
            'scene': scene_no, 'objects_total': len(self.chains), 'segments': sum(len(c.segs) for c in self.chains),
            'dropped_disabled': 0, 'dropped_hidden_layer': 0, 'audio_skipped': 0, 'guide': 0,
            'layers': collections.Counter(), 'effects_mapped': collections.Counter(),
            'effects_unmapped': collections.Counter(), 'effects_disabled': 0, 'missing': [],
            'fonts': collections.Counter(), 'font_subst': collections.Counter(), 'notes': collections.Counter(),
            'avi_as_scene': [],
        }

    # ---- 小道具 ----
    def keep(self, c):
        if c.kind == '音声ファイル':
            return False
        if c.disabled or c.layer in self.hidden:
            return not self.opts.drop_disabled
        return True

    def fx(self, typ, params=None, **extra):
        d = {'type': typ, 'params': params or {}}
        d.update(extra)
        self.rep['effects_mapped'][typ] += 1
        return d

    def raw_fx(self, f, cv, fi, name=None):
        nm = name or f['name']
        self.rep['effects_unmapped'][nm] += 1
        params = {t['name']: cv.prop(fi, t['name']) for t in f['tracks']}
        params.update({k: v for k, v in f.get('checks', {}).items()})
        return {'type': 'aviutl_script', 'name': nm, 'params': params,
                'raw': {'filter': f['name'], 'exdata': {k: v for k, v in f['exdata'].items() if not k.startswith('_')}}}

    def still(self, path):
        e = self.mats.still_asset(path, fetch=self.opts.fetch) if self.mats else None
        if not e:
            self.rep['missing'].append(AM.norm(path))
        return e

    # ---- フィルタ → エフェクト ----
    def effect(self, c, cv, fi, f, src):
        """1 個のフィルタ → エフェクト(の並び)。src はレイヤーの source(テキストの per_char などを書き足すことがある)。"""
        n = f['name']
        x = f['exdata']
        ck = f.get('checks', {})
        P = lambda name, fn=(lambda v: v): cv.prop(fi, name, fn)
        if n == '座標':
            return [self.fx('offset', {'position': cv.vec([(fi, 'X'), (fi, 'Y'), (fi, 'Z')])})]
        if n == '拡大率':
            sc = cv.vec([(fi, '拡大率'), (fi, 'X'), (fi, 'Y')], combine=lambda v: [v[0] * v[1] / 100, v[0] * v[2] / 100])
            return [self.fx('offset', {'scale': sc})]
        if n == '回転':
            return [self.fx('offset', {'rotation': cv.vec([(fi, 'X'), (fi, 'Y'), (fi, 'Z')])})]
        if n == '透明度':
            return [self.fx('offset', {'opacity': P('透明度', lambda v: 100 - v)})]
        if n == '斜めクリッピング':
            return [self.fx('clip_line', {'cx': P('中心X'), 'cy': P('中心Y'), 'angle': P('角度'),
                                          'width': P('幅'), 'feather': P('ぼかし')})]
        if n == 'クリッピング':
            p = {'top': P('上'), 'bottom': P('下'), 'left': P('左'), 'right': P('右')}
            if ck.get('中心の位置を変更'):
                p['recenter'] = True
            return [self.fx('crop', p)]
        if n == 'マスク':
            p = {'x': P('X'), 'y': P('Y'), 'rotation': P('回転'), 'size': P('サイズ'),
                 'aspect': P('縦横比'), 'feather': P('ぼかし'), 'invert': bool(ck.get('マスクの反転'))}
            if ck.get('元のサイズに合わせる'):
                p['fit_original'] = True
            nm = x.get('name') or ''
            if x.get('type') == 0 and nm:
                if nm.startswith('*'):
                    e = self.still(nm)
                    p['asset_id'] = e['asset_id'] if e else None
                    if not e:
                        p['missing'] = AM.norm(nm)
                    return [self.fx('mask_image', p)]
                m = re.match(r'^:?(\d+)$', nm)       # シーンをマスクにする指定(あれば)
                if m:
                    p['comp_id'] = self.comp_of(int(m.group(1)))
                    return [self.fx('mask_image', p)]
                p['figure'] = nm
                return [self.fx('mask', dict(p, shape='figure'))]
            p['shape'] = MASK_SHAPES.get(x.get('type'), 'rect')
            return [self.fx('mask', p)]
        if n == '単色化':
            return [self.fx('fill', {'color': hexcol(x.get('color')), 'amount': P('強さ'),
                                     'keep_luma': bool(ck.get('輝度を保持する'))})]
        if n == '反転':
            p = {'h': bool(ck.get('左右反転')), 'v': bool(ck.get('上下反転'))}
            for k, nm in (('輝度反転', 'luma'), ('色相反転', 'hue'), ('透明度反転', 'alpha')):
                if ck.get(k):
                    p[nm] = True
            return [self.fx('flip', p)]
        if n == '縁取り':
            # ぼかしは px ではなく、縁の太さに対する割合(0〜100)。サイズ 1・ぼかし 50 でも 1px のくっきりした縁になる
            return [self.fx('stroke_outline', {'width': P('サイズ'), 'color': hexcol(x.get('color')),
                                               'blur': cv.calc([(fi, 'サイズ'), (fi, 'ぼかし')], lambda v: round(v[0] * v[1] / 100, 3))})]
        if n == 'シャドー':
            sx, sy = cv.const(fi, 'X'), cv.const(fi, 'Y')
            p = {'distance': round(math.hypot(sx, sy), 3), 'angle': round(math.degrees(math.atan2(sx, -sy)) % 360, 3),
                 'blur': P('拡散'), 'opacity': P('濃さ'), 'color': hexcol(x.get('color'))}
            if cv.is_anim(fi, 'X') or cv.is_anim(fi, 'Y'):
                self.rep['notes']['シャドーの X/Y が動く(定数にした)'] += 1
            return [self.fx('drop_shadow', p)]
        if n == 'ぼかし':
            p = {'radius': P('範囲')}
            if cv.const(fi, '縦横比'):
                p['aspect'] = P('縦横比')
            if cv.const(fi, '光の強さ'):
                p['light'] = P('光の強さ')
            if ck.get('サイズ固定'):
                p['fixed_size'] = True
            return [self.fx('blur', p)]
        if n == '色調補正':
            return [self.fx('color', {'brightness': P('明るさ', lambda v: v - 100), 'contrast': P('ｺﾝﾄﾗｽﾄ', lambda v: v - 100),
                                      'hue': P('色相'), 'luminance': P('輝度'), 'saturation': P('彩度', lambda v: v - 100)})]
        if n == 'クロマキー':
            return [self.fx('chroma_key', {'color': yc_to_rgb(x.get('color_yc', '')), 'hue_range': P('色相範囲'),
                                           'sat_range': P('彩度範囲'), 'edge': P('境界補正'),
                                           'spill': bool(ck.get('色彩補正')), 'alpha_fix': bool(ck.get('透過補正'))})]
        if n == 'カラーキー':
            return [self.fx('chroma_key', {'mode': 'color_key', 'color': yc_to_rgb(x.get('color_yc', '')),
                                           'luma_range': P('輝度範囲'), 'diff_range': P('色差範囲'), 'edge': P('境界補正')})]
        if n == 'グラデーション':
            return [self.fx('gradient_overlay', {
                'amount': P('強さ'), 'cx': P('中心X'), 'cy': P('中心Y'), 'angle': P('角度'), 'width': P('幅'),
                'color': None if x.get('no_color') else hexcol(x.get('color')),
                'color2': None if x.get('no_color2') else hexcol(x.get('color2')),
                'blend': BLEND.get(AM_BLEND(x.get('blend')), 'normal'),
                'shape': ['linear', 'radial', 'rect', 'convex'][x.get('type', 0)] if x.get('type', 0) < 4 else 'linear'})]
        if n in ('画像ファイル合成', '動画ファイル合成'):
            mode = {0: 'over', 1: 'under', 2: 'replace_color', 3: 'luma_to_alpha'}.get(x.get('mode', 0), 'over')
            p = {'mode': mode, 'x': P('X'), 'y': P('Y'), 'scale': P('拡大率')}
            if ck.get('ループ画像'):
                p['tile'] = True
            path = x.get('file') or ''
            if n == '画像ファイル合成':
                e = self.still(path) if path else None
                p['asset_id'] = e['asset_id'] if e else None
            else:
                src2 = self.video_source(c, cv, fi, path, {})
                p.update(src2)
                if ck.get('ループ再生'):
                    p['loop'] = True
            if p.get('asset_id') is None and p.get('comp_id') is None:
                p['missing'] = AM.norm(path)
            return [self.fx('overlay_source', p)]
        if n == '画像ループ':
            return [self.fx('repeat', {'mode': 'grid', 'count_x': P('横回数'), 'count_y': P('縦回数'), 'gap_x': 100, 'gap_y': 100,
                                       'scroll_x': P('速度X'), 'scroll_y': P('速度Y'), 'individual': bool(ck.get('個別オブジェクト'))})]
        if n == 'グロー':
            return [self.fx('glow', {'strength': P('強さ', lambda v: v / 100), 'radius': P('拡散'), 'threshold': P('しきい値'),
                                     'blur': P('ぼかし'), 'light_only': bool(ck.get('光成分のみ')),
                                     'color': None if x.get('no_color') else hexcol(x.get('color'))})]
        if n == '拡散光':
            return [self.fx('glow', {'variant': 'diffuse', 'strength': P('強さ', lambda v: v / 100), 'radius': P('拡散'), 'threshold': 0})]
        if n == '発光':
            return [self.fx('glow', {'variant': 'emit', 'strength': P('強さ', lambda v: v / 100), 'radius': P('拡散'),
                                     'threshold': P('しきい値'), 'color': None if x.get('no_color') else hexcol(x.get('color'))})]
        if n == '色ずれ':
            return [self.fx('rgb_shift', {'amount': P('ずれ幅'), 'angle': P('角度'), 'strength': P('強さ'), 'kind': x.get('type', 0)})]
        if n == 'ノイズ':
            return [self.fx('noise', {'amount': P('強さ'), 'speed_x': P('速度X'), 'speed_y': P('速度Y'), 'change': P('変化速度'),
                                      'period_x': P('周期X'), 'period_y': P('周期Y'), 'threshold': P('しきい値'),
                                      'kind': x.get('type', 0), 'mode': x.get('mode', 0), 'seed': x.get('seed', 0)})]
        if n == '方向ブラー':
            return [self.fx('blur', {'variant': 'directional', 'radius': P('範囲'), 'angle': P('角度')})]
        if n == '放射ブラー':
            return [self.fx('blur', {'variant': 'radial', 'radius': P('範囲'), 'cx': P('X'), 'cy': P('Y')})]
        if n in ('アニメーション効果', 'カメラ効果'):
            return self.script_effect(c, cv, fi, f, src)
        return [self.raw_fx(f, cv, fi)]

    def script_effect(self, c, cv, fi, f, src):
        x = f['exdata']
        name = x.get('script') or x.get('name') or f'#{x.get("type")}'
        prm = parse_params(x.get('param', ''))
        T = lambda i, fn=(lambda v: v): cv.prop(fi, f'track{i}', fn)
        K = lambda i: cv.const(fi, f'track{i}')
        chk = f.get('checks', {}).get('check0', 0)
        fps = self.fps
        if name == '斜めブラインド@ANM1':
            p = {'ratio': T(0), 'pitch': T(1), 'angle': T(2)}
            if chk:
                p['timed'] = True
                p['time'] = T(3)
            return [self.fx('blinds', p)]
        if name.startswith('斜めブラインド(改)'):
            return [self.fx('blinds', {'ratio': T(0), 'pitch': T(1), 'angle': T(2), 'base': T(3), 'variant': 'kai',
                                       'stagger': prm.get('TS', 0), 'flag': prm.get('chk', 0)})]
        if name.startswith('扇クリッピング'):
            # fan_clipping.lua(時計タイプ)を読むと: 斜めクリッピングを組み合わせて、
            # 時計の角度(0 = 上・時計回り)で (基準角 - 90) から 拡張角 ぶん(正 = 時計回り、負 = 反時計回り)の扇形を消す。
            p = {'start': T(0, lambda v: v - 90), 'sweep': T(1), 'cx': T(2), 'cy': T(3), 'opts': prm}
            if prm.get('alpha', 100) != 100:
                p['removed_opacity'] = 100 - prm.get('alpha', 100)     # 消した側をうすく残す
            if chk:
                p['variant'] = 'type2'     # チェックあり = 時計タイプではないほう(未確認)
                self.rep['notes']['扇クリッピングR のチェックあり(型が違う)'] += 1
            return [self.fx('clip_sector', p)]
        if name == '画像ループ2@ANM1':
            return [self.fx('repeat', {'mode': 'grid', 'gap_x': T(0), 'gap_y': T(1), 'count_x': T(2), 'count_y': T(3),
                                       'stagger_rows': bool(chk), 'opts': prm})]
        if name == '一方向に並べる@ANM1':
            return [self.fx('repeat', {'mode': 'line', 'count': T(0), 'gap': T(1), 'angle': T(2), 'both': bool(chk), 'extra': T(3)})]
        if name in ('円形配置', '円形並べ@ANM1'):
            indiv = src is not None and src.get('individual')
            if indiv and name == '円形配置':
                src['on_circle'] = {'arc': T(0), 'radius': T(1), 'rotation': T(2), 'opts': prm}
                self.rep['effects_mapped']['text.on_circle'] += 1
                return []
            return [self.fx('repeat', {'mode': 'circle', 'arc': T(0), 'radius': T(1), 'rotation': T(2),
                                       'count': prm.get('num', 8), 'opts': prm})]
        if name == 'TA標準登場@TA' and src is not None and 'text' in src:
            dur, itv = K(0), K(1)
            pw = prm.get('beki', 1)
            ez = {1: 'linear', 2: 'outQuad', 3: 'outCubic', 4: 'outQuart', 5: 'outQuint'}.get(pw, {'pow': pw})
            order = {0: 'forward', 1: 'backward', 2: 'random', 3: 'random', 4: 'center', 5: 'edges'}.get(int(K(3)), 'forward')
            frm = {'position': [prm.get('x', 0), prm.get('y', 0), prm.get('z', 0)]}
            if K(2) != 100:
                frm['scale'] = [K(2), K(2)]
            rx, ry, rz = prm.get('rx', 0), prm.get('ry', 0), prm.get('rz', 0)
            if rx or ry or rz:
                frm['rotation'] = [rx, ry, rz]
            if prm.get('fade'):
                frm['opacity'] = 0
            pc = {'stagger': round(itv * fps, 3), 'duration': round(abs(dur) * fps, 3), 'order': order, 'from': frm, 'e': ez}
            if int(K(3)) in (2, 3):
                pc['seed'] = c.id
            if dur < 0:      # 退場
                src.setdefault('per_char', {})
                src['per_char'] = dict(src.get('per_char') or {}, out=dict(pc, to=frm))
                src['per_char']['out'].pop('from', None)
            else:
                pc.update(src.get('per_char') or {})
                src['per_char'] = pc
            self.rep['effects_mapped']['text.per_char'] += 1
            return []
        if name == '振り子':
            sp, ang = K(0) or 1, K(1)
            half = fps / (2 * sp)
            return [self.fx('offset', {'rotation': {'k': [{'f': c.start, 'v': [0, 0, -ang], 'e': 'inOutSine'},
                                                          {'f': round(c.start + half, 3), 'v': [0, 0, ang], 'e': 'inOutSine'}],
                                                    'loop': 'pingpong'}})]
        if name == '輪郭追跡(表示)@輪郭追跡':
            return [self.fx('trace_outline', {'progress': T(0), 'width': T(1), 'start': T(2), 'threshold': T(3),
                                              'color': col_param(prm.get('col')), 'only_line': bool(prm.get('rin')), 'opts': prm})]
        if name == '縁取りT':
            return [self.fx('stroke_outline', {'width': T(0), 'blur': T(1), 'alpha_base': T(2), 'mix': T(3),
                                               'color': col_param(prm.get('col1')), 'color2': col_param(prm.get('col2'), None) if 'col2' in prm else None,
                                               'variant': 'T', 'opts': prm})]
        if name == 'ブリーチバイパス@T_Color_Module':
            return [self.fx('bleach_bypass', {'amount': T(0), 'saturation': T(1), 'gamma': T(2)})]
        if name in ('グレースケール@T_Color_Module', '白黒@T_Color_Module'):
            p = {'light': col_param(prm.get('col1'), '#ffffff'), 'dark': col_param(prm.get('col2'), '#000000')}
            if name.startswith('グレースケール'):
                p.update({'mode': T(0), 'gamma': T(1)})
            else:
                p.update({'r': T(0), 'g': T(1), 'b': T(2), 'w': T(3)})
            return [self.fx('duotone', p)]
        if name == '２値化@T_Color_Module':
            p = {'level': T(0), 'mode': T(1)}
            if chk:
                p.update({'light': col_param(prm.get('col1'), '#ffffff'), 'dark': col_param(prm.get('col2'), '#000000')})
            return [self.fx('threshold', p)]
        if name == 'ハーフトーンT':
            return [self.fx('halftone', {'size': T(0), 'min': T(1), 'max': T(2), 'angle': T(3),
                                         'shape': prm.get('fig', '円'), 'fg': col_param(prm.get('col1')), 'bg': col_param(prm.get('col2')),
                                         'self_mask': bool(chk), 'opts': prm})]
        m = re.match(r'^(X|Y|Z|拡大率|透明度|回転)@イージング$', name)
        if m:
            # タイプ・開始・終了・進捗(-1 = オブジェクトの長さで 0→1)
            ez = penner_name(K(0))
            a, b = K(1), K(2)
            what = m.group(1)
            def val(v):
                if what == 'X':
                    return [v, 0, 0]
                if what == 'Y':
                    return [0, v, 0]
                if what == 'Z':
                    return [0, 0, v]
                return v
            key = {'X': 'position', 'Y': 'position', 'Z': 'position', '拡大率': 'scale', '透明度': 'opacity', '回転': 'rotation'}[what]
            if what == '拡大率':
                val = lambda v: [v, v]
            if what == '透明度':
                val = lambda v: 100 - v
            if what == '回転':
                val = lambda v: [0, 0, v]
            if K(3) != -1 or cv.is_anim(fi, 'track3'):
                # 進捗(0〜100)を手で動かしている: 値 = 開始 + (終了 - 開始) × E(進捗/100)。1 コマずつ焼く
                self.rep['notes']['@イージングの進捗を手で動かしている(1 コマずつ焼いた)'] += 1
                pk = cv.scalar(fi, 'track3')
                ak, bk = cv.scalar(fi, 'track1'), cv.scalar(fi, 'track2')
                keys = []
                for f_ in range(c.start, c.end + 1):
                    pr = max(0.0, min(1.0, Conv.eval_keys(pk, f_) / 100))
                    a_, b_ = Conv.eval_keys(ak, f_), Conv.eval_keys(bk, f_)
                    v = a_ + (b_ - a_) * ease_value(ez, pr)
                    v = val(round(v, 3))
                    keys.append((f_, v, None))
                keys = [k for i, k in enumerate(keys) if i in (0, len(keys) - 1) or k[1] != keys[i - 1][1] or k[1] != keys[i + 1][1]]
                return [self.fx('offset', {key: Conv._kf(keys) if len(keys) > 1 else keys[0][1]})]
            return [self.fx('offset', {key: {'k': [{'f': c.start, 'v': val(a), 'e': ez}, {'f': c.end, 'v': val(b)}]}})]
        return [self.raw_fx(f, cv, fi, name)]

    # ---- 素材 ----
    def video_source(self, c, cv, fi, path, layer):
        """動画ファイル(連番・AVI・シーンの書き出し)→ {'asset_id'|'comp_id', 'start', 'speed'}。layer があれば type も決める。"""
        x = c.filt(fi)['exdata']
        base = AM.norm(path).rsplit('\\', 1)[-1]
        nframes, sfps = AM.video_meta(x)
        pos = cv.scalar(fi, '再生位置')
        spd = cv.scalar(fi, '再生速度')
        p0 = pos[0][1]
        sp0 = spd[0][1] / 100.0
        out = {}
        remap = None
        if len(pos) > 1:
            # 再生位置を動かしている = 時間の付け替え
            remap = pos
            self.rep['notes']['再生位置を動かす動画(time_remap)'] += 1
        ratio = self.fps / sfps
        m = AM.SCENE_AVI_RE.match(base)
        if base == AM.GUIDE_BASENAME:
            e = self.mats.file_asset('guide:original_op', os.path.join(self.mats.sakura, 'original_op.mp4')) if self.mats else None
            out['asset_id'] = e['asset_id'] if e else None
            out['start'] = round((p0 - 1) * ratio, 3)
        elif (m and self.opts.avi_as_scene and (self.no, int(m.group(1))) in self.opts.avi_ok
              and self.scene_covers(int(m.group(1)), c.start, c.end - c.start)):
            # シーンを書き出した AVI。AVI の (再生位置-1) コマ目が、置いた位置 c.start に映る。
            # AVI の 0 コマ目 = シーンの (c.start - (再生位置-1)) コマ目とみなすので、c.start に映るのはシーンの c.start コマ目。
            sn = int(m.group(1))
            out['comp_id'] = self.comp_of(sn)
            out['start'] = round(c.start, 3)
            out['substituted'] = AM.norm(path)
            self.rep['avi_as_scene'].append((base, sn))
        elif AM.SEQ_RE.match(base):
            lo = int(min(k[1] for k in pos))
            hi = int(max(max(k[1] for k in pos), p0 + (c.end - c.start) * abs(sp0) / ratio)) + 1
            if nframes:
                hi = min(hi, nframes)
            e = self.mats.seq_asset(path, lo, hi, sfps, fetch=(self.opts.fetch and self.no in self.opts.fetch_seq_scenes and
                                               (not self.opts.seq_filter or re.search(self.opts.seq_filter, AM.norm(path))))) if self.mats else None
            if e:
                out['asset_id'] = e['asset_id']
                out['start'] = round((p0 - e['first']) * ratio, 3)
                if remap:
                    remap = [(f, (v - e['first']) * ratio, ez) for f, v, ez in remap]
                    out['time_remap'] = Conv._kf([(f, round(v, 3), ez) for f, v, ez in remap])
            else:
                out['asset_id'] = None
        else:
            out['asset_id'] = None
        if out.get('asset_id') is None and out.get('comp_id') is None:
            out['missing'] = AM.norm(path)
            out.setdefault('start', round((p0 - 1) * ratio, 3))
            self.rep['missing'].append(AM.norm(path))
        out['speed'] = round(sp0, 4)
        if x.get('_internal_260_hex'):
            out['source_fps'] = sfps
        return out

    def scene_covers(self, sn, start, length):
        """シーン sn に、その時間帯に映るものがあるか(書き出した AVI をシーンで置き換えてよいかの目安)。"""
        if sn == self.no:
            return False
        ex = self.doc['exedit']
        sc = next((s for s in ex['scenes'] if s['index'] == sn), None)
        if not sc:
            return False
        hid = {ls['layer'] for ls in sc['layer_settings'] if ls.get('hidden')}
        a, b = start, start + length
        n = 0
        for o in ex['objects']:
            if o['scene'] != sn or o.get('disabled') or o['layer'] in hid:
                continue
            fn = o['filters'][0]['name']
            if fn == '音声ファイル' or (fn == '動画ファイル' and o['filters'][0]['exdata'].get('file', '').endswith('\\' + AM.GUIDE_BASENAME)):
                continue
            if o['start'] <= b and o['end'] >= a:
                n += 1
        return n >= 2

    # ---- レイヤー ----
    def draw_transform(self, c, cv, di):
        f = c.filt(di)
        W2, H2 = self.W / 2, self.H / 2
        t = {'position': cv.vec([(di, 'X', lambda v: v + W2), (di, 'Y', lambda v: v + H2), (di, 'Z')])}
        ext = f['name'] == '拡張描画'
        if ext:
            def sc(v):
                s, a = v
                return [s * (1 - max(0, a) / 100), s * (1 + min(0, a) / 100)]
            t['scale'] = cv.vec([(di, '拡大率'), (di, '縦横比')], combine=sc)
            t['rotation'] = cv.vec([(di, 'X軸回転'), (di, 'Y軸回転'), (di, 'Z軸回転')])
            anc = cv.vec([(di, '中心X'), (di, '中心Y'), (di, '中心Z')])
            if anc != [0, 0, 0]:
                t['anchor'] = anc
        else:
            t['scale'] = cv.vec([(di, '拡大率')], combine=lambda v: [v[0], v[0]])
            t['rotation'] = cv.vec([0, 0, (di, '回転')])
        t['opacity'] = cv.prop(di, '透明度', lambda v: 100 - v)
        return t

    def base_layer(self, c, typ):
        L = {'id': c.lid, 'name': (c.o.get('name') or c.kind)[:60], 'type': typ, 'in': c.start, 'out': c.end + 1}
        if c.disabled or c.layer in self.hidden:
            L['visible'] = False
        L['aviutl'] = {'object': c.id, 'layer': c.layer, 'kind': c.kind, 'segments': len(c.segs)}
        return L

    def build_object(self, c):
        cv = Conv(c, self.stats)
        fs = c.o['filters']
        f0 = fs[0]
        x0 = f0['exdata']
        kind = c.kind
        last = len(fs) - 1
        has_draw = fs[last]['name'] in ('標準描画', '拡張描画')
        fx_range = range(1, last if has_draw else last + 1)
        src = {}
        L = None
        if kind == '動画ファイル':
            path = x0.get('file', '')
            vs = self.video_source(c, cv, 0, path, None)
            if 'comp_id' in vs:
                L = self.base_layer(c, 'comp')
                src = {'comp_id': vs['comp_id'], 'substituted': vs.get('substituted')}
            else:
                L = self.base_layer(c, 'video')
                src = {'asset_id': vs.get('asset_id')}
                if vs.get('missing'):
                    L['missing'] = vs['missing']
                if 'time_remap' in vs:
                    src['time_remap'] = vs['time_remap']
                if f0['checks'].get('アルファチャンネルを読み込む'):
                    src['alpha'] = True
                if f0['checks'].get('ループ再生'):
                    src['loop'] = True
            L['start'], L['speed'] = vs['start'], vs['speed']
            if AM.norm(path).endswith('\\' + AM.GUIDE_BASENAME):
                L['guide'] = True
                L['name'] = '下絵(元の OP 動画)'
                self.rep['guide'] += 1
        elif kind == '画像ファイル':
            L = self.base_layer(c, 'image')
            e = self.still(x0.get('file', ''))
            src = {'asset_id': e['asset_id'] if e else None}
            if not e:
                L['missing'] = AM.norm(x0.get('file', ''))
        elif kind == '図形':
            col = hexcol(x0.get('color'))
            ft = x0.get('type', 0)
            if x0.get('name'):
                self.rep['notes']['図形(ファイル・名前つき)'] += 1
            lwk = cv.scalar(0, 'ライン幅')
            lw_min = min(k[1] for k in lwk)
            T3 = [(0, 'サイズ'), (0, '縦横比'), (0, 'ライン幅')]
            if ft == 0:
                # 背景 = 画面いっぱい。ライン幅が小さいと「画面の縁の枠」になる
                if not any(0 < k[1] < min(self.W, self.H) / 2 for k in lwk):
                    L = self.base_layer(c, 'solid')
                    src = {'color': col, 'width': self.W, 'height': self.H}
                else:
                    L = self.base_layer(c, 'shape')
                    src = {'kind': 'rect', 'width': cv.calc(T3, lambda v: max(0, self.W - v[2])),
                           'height': cv.calc(T3, lambda v: max(0, self.H - v[2])),
                           'fill': None, 'stroke': col, 'stroke_width': cv.prop(0, 'ライン幅'), 'join': 'miter'}
            else:
                L = self.base_layer(c, 'shape')
                kd = {1: 'ellipse', 2: 'rect', 3: 'polygon', 4: 'polygon', 5: 'polygon', 6: 'star'}.get(ft, 'rect')
                wf = lambda v: v[0] * (1 - max(0, v[1]) / 100)
                hf = lambda v: v[0] * (1 + min(0, v[1]) / 100)
                smin = min(k[1] for k in cv.scalar(0, 'サイズ'))
                if not any(0 < k[1] < smin / 2 for k in lwk):
                    src = {'kind': kd, 'width': cv.calc(T3, wf), 'height': cv.calc(T3, hf), 'fill': col, 'stroke': None}
                else:
                    src = {'kind': kd, 'width': cv.calc(T3, lambda v: max(0, wf(v) - v[2])),
                           'height': cv.calc(T3, lambda v: max(0, hf(v) - v[2])),
                           'fill': None, 'stroke': col, 'stroke_width': cv.prop(0, 'ライン幅'), 'join': 'miter'}
                if ft in (3, 4, 5):
                    src['sides'] = ft
                if ft == 6:
                    src['sides'] = 5
        elif kind == 'テキスト':
            L = self.base_layer(c, 'text')
            src = self.text_source(c, cv, f0)
        elif kind == 'シーン':
            L = self.base_layer(c, 'comp')
            sn = x0.get('scene')
            src = {'comp_id': self.comp_of(sn), 'scene': sn}
            pos = cv.scalar(0, '再生位置')
            L['start'] = pos[0][1] - 1
            L['speed'] = round(cv.const(0, '再生速度') / 100.0, 4)
            if len(pos) > 1:
                src['time_remap'] = Conv._kf([(f, v - 1, e) for f, v, e in pos])
                self.rep['notes']['再生位置を動かすシーン(time_remap)'] += 1
            if f0['checks'].get('ループ再生'):
                src['loop'] = True
        elif kind == 'フレームバッファ':
            L = self.base_layer(c, 'adjustment')
        elif kind == 'カスタムオブジェクト':
            L, src = self.custom_object(c, cv, f0)
        else:
            L = self.base_layer(c, 'null')
            self.rep['notes'][f'未対応のオブジェクト {kind}'] += 1
        self.rep['layers'][L['type']] += 1
        # エフェクト
        effects = []
        for fi in fx_range:
            f = fs[fi]
            if f['name'] in ('標準再生',):
                continue
            if f['name'] == 'カスタムオブジェクト' and fi == 0:
                continue
            if not f['enabled']:
                self.rep['effects_disabled'] += 1
                if self.opts.drop_disabled:
                    continue
            for e in self.effect(c, cv, fi, f, src):
                if not f['enabled']:
                    e['enabled'] = False
                effects.append(e)
        if has_draw:
            L['transform'] = self.draw_transform(c, cv, last)
            bn = fs[last]['exdata'].get('blend_name', '通常')
            if bn != '通常':
                L['blend'] = BLEND.get(bn, 'normal')
            if fs[last].get('checks', {}).get('裏面を表示しない'):
                L['backface'] = False
            if kind == 'フレームバッファ':
                t = L['transform']
                moved = (t['position'] != [self.W / 2, self.H / 2, 0] or t['scale'] != [100, 100] or
                         t['rotation'] != [0, 0, 0] or t['opacity'] != 100 or
                         any(e['type'] in ('offset', 'clip_line', 'crop', 'mask', 'mask_image', 'repeat', 'flip') for e in effects))
                if moved:
                    L['snapshot'] = True
                if f0['checks'].get('フレームバッファをクリア'):
                    L['clear'] = True
        if src:
            L['source'] = src
        if effects:
            L['effects'] = effects
        return L

    def text_source(self, c, cv, f0):
        x = f0['exdata']
        ck = f0['checks']
        text = (x.get('text') or '').replace('\r\n', '\n').replace('\r', '\n')
        notes = self.rep['notes']
        bold = bool(ck.get('B'))
        font, weight, sub = map_font(x.get('font'), bold)
        self.rep['fonts'][x.get('font')] += 1
        if sub:
            self.rep['font_subst'][f"{x.get('font')} → {font} {weight}"] += 1
        emf = em_factor(x.get('font')) * SUBST_SCALE.get((x.get('font') or '').lstrip('@'), 1.0)
        size = cv.prop(0, 'サイズ', lambda v: v * emf)
        base_size = cv.const(0, 'サイズ')
        src = {'text': TAG_RE.sub('', text), 'font': font, 'weight': weight, 'size': size, 'fill': hexcol(x.get('color'))}
        src['font_original'] = x.get('font')
        src['size_aviutl'] = base_size
        if (x.get('font') or '').startswith('@'):
            src['rotated_glyphs'] = True       # @ つきの書体(縦書き用。和文の字が 90 度寝る)
            notes['@ つきの書体'] += 1
        runs = text_runs(text, base_size, x.get('font'), bold, notes)
        if any(r[1] != base_size or r[2] != x.get('font') for r in runs):
            rr = []
            for t, s, fn in runs:
                f2, w2, _ = map_font(fn, bold)
                rr.append({'text': t, 'font': f2, 'weight': w2, 'size': round(s * em_factor(fn) * SUBST_SCALE.get((fn or '').lstrip('@'), 1.0), 3)})
            src['runs'] = rr
        al = x.get('align', 0)
        if al >= 9:
            src['writing'] = 'vertical'
            src['valign'] = ['top', 'middle', 'bottom'][(al - 9) % 3]
            src['align'] = ['right', 'center', 'left'][(al - 9) // 3]
        else:
            src['align'] = ['left', 'center', 'right'][al % 3]
            src['valign'] = ['top', 'middle', 'bottom'][al // 3]
        if x.get('spacing_x'):
            src['tracking'] = x['spacing_x']
            if x['spacing_x'] < 0 and ck.get('文字毎に個別オブジェクト'):
                # 負の字間 + 文字毎に個別オブジェクト: 完成動画では詰まらず、逆に広がって映る(シーン 23 の「主題歌」-28 → 約 +16、
                # 「｢桜爛ロマンシア｣」-48 → 約 +32)。理由は未確認。実測に合わせて -0.62 倍にしておく。
                src['tracking'] = round(-0.62 * x['spacing_x'], 2)
                src['tracking_aviutl'] = x['spacing_x']
                notes['負の字間 + 個別オブジェクト(実測で補正)'] += 1
        if '\n' in src['text']:
            src['leading'] = round(max([base_size] + [r[1] for r in runs]) + (x.get('spacing_y') or 0), 3)   # 行送り = セルの高さ + 行間
        if ck.get('I'):
            src['italic'] = True
        tt = x.get('type', 0)
        if tt in (1, 2):
            src['shadow'] = {'color': hexcol(x.get('color2')), 'light': tt == 2}
        elif tt in (3, 4):
            src['stroke'] = hexcol(x.get('color2'))
            src['stroke_width'] = 2 if tt == 4 else 4
        if ck.get('文字毎に個別オブジェクト'):
            src['individual'] = True
        if cv.const(0, '表示速度'):
            src['reveal_speed'] = cv.const(0, '表示速度')
        if x.get('monospace'):
            src['monospace'] = True
        return src

    def custom_object(self, c, cv, f0):
        x = f0['exdata']
        name = x.get('script') or x.get('name') or f'#{x.get("type")}'
        prm = parse_params(x.get('param', ''))
        K = lambda i: cv.const(0, f'track{i}')
        if name == 'カウンター':
            L = self.base_layer(c, 'text')
            font, weight, sub = map_font(prm.get('font'), False)
            self.rep['fonts'][prm.get('font')] += 1
            emf = em_factor(prm.get('font'))
            src = {'text': '', 'font': font, 'weight': weight, 'size': cv.prop(0, 'track2', lambda v: v * emf), 'fill': col_param(prm.get('col1'), '#ffffff'),
                   'font_original': prm.get('font'), 'align': 'center', 'valign': 'middle',
                   'counter': {'start': K(0), 'rate': K(1), 'format': int(K(3)), 'from_frame': c.start}}
            self.rep['effects_mapped']['text.counter'] += 1
            return L, src
        L = self.base_layer(c, 'null')
        self.rep['effects_unmapped'][f'カスタムオブジェクト:{name}'] += 1
        L['aviutl_object'] = {'type': 'aviutl_script', 'name': name,
                              'params': dict({f'track{i}': cv.prop(0, f'track{i}') for i in range(4)}, **prm,
                                             check0=f0['checks'].get('check0', 0)),
                              'raw': {'filter': 'カスタムオブジェクト', 'exdata': {k: v for k, v in x.items() if not k.startswith('_')}}}
        return L, {}

    def control_layer(self, c, targets):
        """グループ制御・カメラ制御。targets = 対象のレイヤー id の並び。"""
        cv = Conv(c, self.stats)
        f0 = c.filt(0)
        fs = c.o['filters']
        W2, H2 = self.W / 2, self.H / 2
        if c.kind == 'グループ制御':
            L = self.base_layer(c, 'group')
            L['scope'] = targets
            L['transform'] = {
                'position': cv.vec([(0, 'X', lambda v: v + W2), (0, 'Y', lambda v: v + H2), (0, 'Z')]),
                'scale': cv.vec([(0, '拡大率')], combine=lambda v: [v[0], v[0]]),
                'rotation': cv.vec([(0, 'X軸回転'), (0, 'Y軸回転'), (0, 'Z軸回転')]),
            }
            L['inherit'] = bool(f0['checks'].get('上位グループ制御の影響を受ける'))
            if not f0['checks'].get('同じグループのオブジェクトを対象にする', 1):
                L['aviutl']['same_group_only'] = False
        else:
            L = self.base_layer(c, 'camera')
            L['scope'] = targets
            L['transform'] = {'position': cv.vec([(0, 'X', lambda v: v + W2), (0, 'Y', lambda v: v + H2), (0, 'Z')]),
                              'rotation': cv.vec([0, 0, (0, '傾き')])}
            src = {'zoom': 1024, 'target': cv.vec([(0, '目標X', lambda v: v + W2), (0, '目標Y', lambda v: v + H2), (0, '目標Z')])}
            fov = cv.const(0, '視野角')
            if fov or cv.is_anim(0, '視野角'):
                src['fov_v'] = cv.prop(0, '視野角')
                del src['zoom']
            if cv.const(0, '目標ﾚｲﾔ'):
                src['target_layer_no'] = cv.const(0, '目標ﾚｲﾔ')
            if cv.const(0, '深度ぼけ'):
                src['dof'] = cv.prop(0, '深度ぼけ')
            src['zbuffer'] = bool(f0['checks'].get('Zバッファ/シャドウマップを有効にする'))
            L['source'] = src
        L['aviutl']['range'] = f0['exdata'].get('range')
        self.rep['layers'][L['type']] += 1
        effects = []
        for fi in range(1, len(fs)):
            f = fs[fi]
            if not f['enabled']:
                self.rep['effects_disabled'] += 1
                if self.opts.drop_disabled:
                    continue
            if c.kind == 'カメラ制御' and f['name'] == 'カメラ効果':
                x = f['exdata']
                nm = x.get('script') or ''
                if nm.startswith('オートターゲット'):
                    # tarN = 注視するオブジェクトのレイヤー番号(絶対値)。この作品では tar1 だけで、カメラのすぐ下の段に置いた
                    # 「図形フィルタを無効にした円」(映らない目印)の位置を追う。カメラは目印から「カメラ距離」だけ手前。
                    # → エンジンに追従の機能が無くても合うよう、カメラの position / target を 1 コマずつの値に焼く。
                    prm = parse_params(x.get('param', ''))
                    tars = [prm.get(f'tar{i}') for i in range(1, 11)]
                    tars = [int(t) for t in tars if isinstance(t, (int, float))]
                    L['aviutl']['auto_target'] = {'layers': tars, 'index': cv.prop(fi, 'track0'), 'distance': cv.prop(fi, 'track1'),
                                                  'ease': cv.prop(fi, 'track2'), 'smooth': cv.prop(fi, 'track3'), 'opts': prm}
                    self.rep['effects_mapped']['camera.auto_target(焼き込み)'] += 1
                    if len(tars) > 1:
                        self.rep['notes']['オートターゲットの目標が 2 個以上(1 個目だけ使った)'] += 1
                    if tars:
                        dist = cv.scalar(fi, 'track1')
                        locs = [u for u in self.chains if u.layer == tars[0] and u.start <= c.end and u.end >= c.start
                                and u.kind not in ('グループ制御', 'カメラ制御', '音声ファイル')]
                        own = [cv.scalar(0, n) for n in ('X', 'Y', 'Z')]
                        pk, tk, rk = [], [], []
                        for f_ in range(c.start, c.end + 1):
                            u = next((u for u in locs if u.start <= f_ <= u.end), None)
                            d = Conv.eval_keys(dist, f_)
                            if u is None:
                                p = [Conv.eval_keys(k, f_) for k in own]
                                t = None
                            else:
                                t = self.chain_pos(u, f_)
                                p = [t[0], t[1], t[2] - d]
                            pk.append((f_, [round(p[0] + W2, 3), round(p[1] + H2, 3), round(p[2], 3)], None))
                            # カメラの向きは目印の回転に合わせる(目印が -54 度なら、画面は時計回りに 54 度回って見える)
                            rk.append((f_, [0, 0, round(CAM_ROLL_SIGN * (self.chain_rot(u, f_) if u is not None else Conv.eval_keys(cv.scalar(0, '傾き'), f_)), 3)], None))
                            if t is not None:
                                tk.append((f_, [round(t[0] + W2, 3), round(t[1] + H2, 3), round(t[2], 3)], None))
                        def thin(keys):
                            out = [k for i, k in enumerate(keys) if i in (0, len(keys) - 1) or k[1] != keys[i - 1][1] or k[1] != keys[i + 1][1]]
                            return out[0][1] if len(out) == 1 or all(k[1] == out[0][1] for k in out) else Conv._kf(out)
                        if pk:
                            L['transform']['position'] = thin(pk)
                        if tk:
                            L['source']['target'] = thin(tk)
                        if rk and any(k[1][2] for k in rk):
                            L['transform']['rotation'] = thin(rk)
                    continue
            for e in self.effect(c, cv, fi, f, None):
                if not f['enabled']:
                    e['enabled'] = False
                effects.append(e)
        if effects:
            L['effects'] = effects
        return L

    def chain_pos(self, u, f):
        """オブジェクトの f コマ目の位置(画面の中心が原点。描画フィルタの X・Y・Z + 座標フィルタ)。"""
        cv = Conv(u, {'ease': collections.Counter(), 'ignore_mid': 0, 'baked': 0})
        p = [0.0, 0.0, 0.0]
        for fi, fl in enumerate(u.o['filters']):
            if fl['name'] in ('標準描画', '拡張描画') or (fl['name'] == '座標' and fl['enabled']):
                for i, n in enumerate(('X', 'Y', 'Z')):
                    p[i] += Conv.eval_keys(cv.scalar(fi, n), f)
        return p

    def chain_rot(self, u, f):
        """オブジェクトの f コマ目の Z 回転(度)。"""
        cv = Conv(u, {'ease': collections.Counter(), 'ignore_mid': 0, 'baked': 0})
        r = 0.0
        for fi, fl in enumerate(u.o['filters']):
            if fl['name'] == '標準描画':
                r += Conv.eval_keys(cv.scalar(fi, '回転'), f)
            elif fl['name'] == '拡張描画':
                r += Conv.eval_keys(cv.scalar(fi, 'Z軸回転'), f)
            elif fl['name'] == '回転' and fl['enabled']:
                r += Conv.eval_keys(cv.scalar(fi, 'Z'), f)
        return r

    def build(self):
        kept = []
        for c in self.chains:
            if c.kind == '音声ファイル':
                self.rep['audio_skipped'] += 1
                continue
            if c.disabled:
                self.rep['dropped_disabled'] += 1
            elif c.layer in self.hidden:
                self.rep['dropped_hidden_layer'] += 1
            if self.keep(c):
                kept.append(c)
        live = [c for c in kept if not (c.disabled or c.layer in self.hidden)]
        by_layer = collections.defaultdict(list)
        for c in live:
            by_layer[c.layer].append(c)
        layers = {}
        extra = {}       # 鎖の id → 追加のレイヤー(マット用の写し)
        controls = [c for c in kept if c.kind in ('グループ制御', 'カメラ制御')]
        # 先にふつうのオブジェクト
        for c in kept:
            if c in controls:
                continue
            layers[c.id] = self.build_object(c)
        # 上のオブジェクトでクリッピング
        for c in live:
            if not c.o.get('clip_with_above') or c in controls:
                continue
            ly = c.layer - 1
            src_c = None
            while ly >= 1:
                cands = [u for u in by_layer.get(ly, []) if u.start <= c.end and u.end >= c.start and u not in controls]
                if cands:
                    u = max(cands, key=lambda u: min(u.end, c.end) - max(u.start, c.start))
                    if u.o.get('clip_with_above'):
                        ly -= 1
                        continue
                    src_c = u
                break
            if src_c is None:
                self.rep['notes']['上のオブジェクトでクリッピング(相手なし)'] += 1
                continue
            if self.opts.matte_copy:
                # マット元を隠すエンジン向け: 写しを作ってそれをマットにする
                mid = src_c.lid + '_m'
                if src_c.id not in extra:
                    m = json.loads(json.dumps(layers[src_c.id]))
                    m['id'] = mid
                    m['name'] = '(マット) ' + m['name']
                    m['aviutl']['matte_copy_of'] = src_c.lid
                    extra[src_c.id] = m
                layers[c.id]['matte'] = {'layer': mid, 'mode': 'alpha'}
                self.rep['layers']['matte_copy'] = len(extra)
            else:
                layers[c.id]['matte'] = {'layer': src_c.lid, 'mode': 'alpha', 'keep_source': True}
            self.rep['notes']['上のオブジェクトでクリッピング → matte'] += 1
        # グループ制御・カメラ制御の対象
        used_layers = sorted(by_layer)
        for c in controls:
            rng = c.filt(0)['exdata'].get('range', 0) or 0
            tg = []
            if not (c.disabled or c.layer in self.hidden):
                for u in live:
                    if u is c or u.layer <= c.layer or (rng and u.layer > c.layer + rng):
                        continue
                    if u.start > c.end or u.end < c.start:
                        continue
                    if c.kind == 'カメラ制御':
                        if u.kind in ('グループ制御', 'カメラ制御'):
                            continue
                        if not u.o.get('camera_target'):
                            continue
                    elif u.kind == 'カメラ制御':
                        continue
                    tg.append(u.lid)
                    if u.id in extra:
                        tg.append(extra[u.id]['id'])
            layers[c.id] = self.control_layer(c, tg)
            if c.kind == 'カメラ制御':
                for u in live:
                    if u.lid in tg and u.id in layers:
                        layers[u.id]['three_d'] = True
                        if u.id in extra:
                            extra[u.id]['three_d'] = True
        # カメラ制御が無くても、AviUtl は Z・X/Y 軸回転を透視で描く(視点は (0,0,-1024)、Z=0 が等倍)。
        # そういうレイヤーを three_d にして、既定のカメラ(zoom 1024・並べ替えなし)の scope に入れる。
        def nz(v, idx):
            if isinstance(v, dict):
                return any(abs(k['v'][i]) > 1e-6 for k in v.get('k', []) for i in idx if isinstance(k['v'], list) and len(k['v']) > i)
            return isinstance(v, list) and any(len(v) > i and abs(v[i]) > 1e-6 for i in idx)

        def has_depth(L):
            t = L.get('transform') or {}
            if nz(t.get('position'), [2]) or nz(t.get('rotation'), [0, 1]) or nz(t.get('anchor'), [2]):
                return True
            for e in L.get('effects') or []:
                if e['type'] == 'offset' and (nz(e['params'].get('position'), [2]) or nz(e['params'].get('rotation'), [0, 1])):
                    return True
            return False
        need = set()
        for c in live:
            L = layers.get(c.id)
            if not L or L['type'] in ('camera', 'adjustment'):
                continue
            if L['type'] == 'group':
                gt = dict(L['transform'])
                if has_depth({'transform': gt, 'effects': L.get('effects')}):
                    need.update(L['scope'])
            elif has_depth(L):
                need.add(L['id'])
        dcam_scope = []
        for c in live:
            L = layers.get(c.id)
            if L and L['id'] in need and L['type'] not in ('group', 'camera') and not L.get('three_d'):
                L['three_d'] = True
                dcam_scope.append(L['id'])
                if c.id in extra:
                    extra[c.id]['three_d'] = True
                    dcam_scope.append(extra[c.id]['id'])
        default_cam = None
        if dcam_scope:
            default_cam = {'id': 'cam_default', 'name': '既定の視点(AviUtl: 距離 1024)', 'type': 'camera', 'in': 0,
                           'out': max([c.end + 1 for c in kept] + [1]), 'scope': dcam_scope,
                           'transform': {'position': [self.W / 2, self.H / 2, -1024], 'rotation': [0, 0, 0]},
                           'source': {'zoom': 1024, 'target': [self.W / 2, self.H / 2, 0], 'zbuffer': False},
                           'aviutl': {'kind': '(既定のカメラ)'}}
            self.rep['layers']['camera(既定)'] += 1
        # 並び: レイヤー番号の大きいほうが手前(配列の先頭)。同じ段は時刻順
        order = sorted(kept, key=lambda c: (-c.layer, c.start))
        out = []
        for c in order:
            out.append(layers[c.id])
            if c.id in extra:
                out.append(extra[c.id])
        if default_cam:
            out.append(default_cam)
        dur = max([c.end + 1 for c in kept] + [1])
        data = {'version': 1, 'bg': None if self.sc.get('alpha') else '#000000', 'layers': out,
                'aviutl': {'scene': self.no, 'source': os.path.basename(self.doc['project'].get('project_path', '').replace('\\', '/'))}}
        self.rep['duration'] = dur
        self.rep['layers_out'] = len(out)
        self.rep['ease'] = dict(self.stats['ease'])
        self.rep['baked_props'] = self.stats['baked']
        return data, dur


def AM_BLEND(i):
    names = ['通常', '加算', '減算', '乗算', 'スクリーン', 'オーバーレイ', '比較(明)', '比較(暗)', '輝度', '色差', '陰影', '明暗', '差分']
    try:
        return names[int(i)]
    except Exception:
        return '通常'


# ------------------------------------------------------------------ API

class Api:
    def __init__(self, base):
        self.base = base.rstrip('/')

    def call(self, method, path, body=None):
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                t = r.read()
                return json.loads(t) if t else None
        except urllib.error.HTTPError as e:
            raise RuntimeError(f'{method} {path} → {e.code} {e.read().decode(errors="replace")[:500]}')


def nested_scenes(doc, sn, opts, seen=None):
    """sn が中に置くシーン(シーンオブジェクトと、置き換える sceneNN_*.avi)を、深いほうから先に並べて返す。"""
    seen = seen if seen is not None else []
    ex = doc['exedit']
    sc = next((s for s in ex['scenes'] if s['index'] == sn), None)
    if sc is None:
        return seen
    hid = {ls['layer'] for ls in sc['layer_settings'] if ls.get('hidden')}
    subs = []
    for o in ex['objects']:
        if o['scene'] != sn:
            continue
        if opts.drop_disabled and (o.get('disabled') or o['layer'] in hid):
            continue
        for f in o['filters']:
            if f['name'] == 'シーン':
                subs.append(f['exdata'].get('scene'))
            elif f['name'] in ('動画ファイル', '動画ファイル合成') and opts.avi_as_scene:
                m = AM.SCENE_AVI_RE.match(AM.norm(f['exdata'].get('file', '')).rsplit('\\', 1)[-1])
                if m and (sn, int(m.group(1))) in opts.avi_ok:
                    subs.append(int(m.group(1)))
    for s in subs:
        if s is None or s == sn or s in seen or s in opts._stack:
            continue
        opts._stack.append(sn)
        nested_scenes(doc, s, opts, seen)
        opts._stack.pop()
        if s not in seen:
            seen.append(s)
    return seen


def avi_edges(doc, drop_disabled=True):
    """`sceneNN_*.avi`(シーンを書き出した動画)をそのシーンのコンポジションで置き換えてよい組 (親, 子) の集合。
    シーンオブジェクトによる入れ子は必ず守り、循環になる組は捨てる。番号の大きいシーンが小さいシーンを使う組を先に採る
    (完成動画の組み上げの向き。例: 20 → 12 を採り、12 → 20(下見用に敷いた書き出し)は捨てる)。"""
    ex = doc['exedit']
    nums = {s['index'] for s in ex['scenes']}
    hid = AM.hidden_layers(ex)
    hard, soft = set(), set()
    for o in ex['objects']:
        if drop_disabled and (o.get('disabled') or (o['scene'], o['layer']) in hid):
            continue
        for f in o['filters']:
            if f['name'] == 'シーン':
                hard.add((o['scene'], f['exdata'].get('scene')))
            elif f['name'] in ('動画ファイル', '動画ファイル合成'):
                m = AM.SCENE_AVI_RE.match(AM.norm(f['exdata'].get('file', '')).rsplit('\\', 1)[-1])
                if m and int(m.group(1)) in nums and int(m.group(1)) != o['scene']:
                    soft.add((o['scene'], int(m.group(1))))
    edges = set(hard)

    def reach(a, b):
        seen, st = set(), [a]
        while st:
            x = st.pop()
            if x == b:
                return True
            if x in seen:
                continue
            seen.add(x)
            st += [c for (p, c) in edges if p == x]
        return False
    ok = set()
    for (p, c) in sorted(soft, key=lambda e: (e[0] < e[1], e)):
        if (p, c) in hard or reach(c, p):
            continue
        edges.add((p, c))
        ok.add((p, c))
    return ok


def scene_name(doc, sn, names):
    return f'S{sn:02d} {names.get(sn, "")}'.strip()


SCENE_NAMES = {0: 'Root', 1: '冒頭長いカット', 4: '冒頭線路螺旋', 8: 'タイトルパート背景', 12: 'キャラ紹介1前後', 13: 'タイトルロゴ',
               14: 'タイトルロゴ文字', 17: 'キャラ紹介矢じり', 18: 'キャラ紹介背景矢じり', 20: 'キャラ紹介後半', 21: 'キャラ紹介説明書',
               22: 'キャラ紹介ソウルジェム中', 23: '10年愛', 25: '楽曲タイトル直後(桜模様マスク)', 26: '楽曲タイトル直後',
               27: '網目模様背景動画', 30: '3Dモデル羅列', 31: '響け～', 32: '車両内', 33: 'モバゲ杏子羅列', 34: '咲き誇れ',
               35: 'キャラ羅列', 36: 'キャラ羅列紹介', 38: 'えちえち杏子ちゃん', 39: '筆記後エフェクト', 40: 'キャラ相関図',
               42: 'ソウルジェム内', 43: 'ラストカット', 48: 'ポッキープリッツパッケージ'}


def jsonable(o):
    if isinstance(o, collections.Counter):
        return dict(o.most_common())
    if isinstance(o, dict):
        return {str(k): jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [jsonable(v) for v in o]
    return o


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('json')
    ap.add_argument('--scene', type=int, action='append', default=[])
    ap.add_argument('--all', action='store_true', help='全シーン')
    ap.add_argument('--project-id', type=int)
    ap.add_argument('--api', default='http://127.0.0.1:8002')
    ap.add_argument('--dry-run', metavar='OUT.json', help='API を使わず、文書を書くだけ')
    ap.add_argument('--materials-root', default=None)
    ap.add_argument('--fetch', action='store_true', help='足りない素材を PC から取り寄せて登録する')
    ap.add_argument('--fetch-seq-scene', type=int, action='append', default=None,
                    help='連番を取り寄せてよいシーン(省略時は --scene で指定したシーン)')
    ap.add_argument('--seq-filter', default=None, help='取り寄せる連番をパスの正規表現でしぼる')
    ap.add_argument('--budget-mb', type=float, default=3000)
    ap.add_argument('--keep-disabled', dest='drop_disabled', action='store_false',
                    help='無効のオブジェクト・非表示レイヤーも visible:false で残す')
    ap.add_argument('--drop-disabled', dest='drop_disabled', action='store_true', default=True)
    ap.add_argument('--no-avi-as-scene', dest='avi_as_scene', action='store_false', default=True,
                    help='sceneNN_*.avi をそのシーンのコンポジションで置き換えない')
    ap.add_argument('--matte-copy', action='store_true', help='マット元の写しを作る(matte.keep_source が無いエンジン向け)')
    ap.add_argument('--no-nested', action='store_true', help='中に置くシーンを一緒に取り込まない')
    ap.add_argument('--report-dir', default=None)
    a = ap.parse_args()
    a._stack = []
    doc = json.load(open(a.json, encoding='utf-8'))
    a.avi_ok = avi_edges(doc, a.drop_disabled) if a.avi_as_scene else set()
    sakura = os.path.dirname(os.path.abspath(a.json))
    all_scenes = [s['index'] for s in doc['exedit']['scenes']]
    want = all_scenes if a.all else a.scene
    if not want:
        ap.error('--scene か --all を指定')
    a.fetch_seq_scenes = set(a.fetch_seq_scene if a.fetch_seq_scene is not None else a.scene)
    todo = []
    for sn in want:
        if not a.no_nested:
            for s in nested_scenes(doc, sn, a):
                if s not in todo:
                    todo.append(s)
        if sn not in todo:
            todo.append(sn)
    dry = bool(a.dry_run)
    api = None if dry else Api(a.api)
    mats = AM.Materials(sakura=sakura, root=a.materials_root, api=None if dry else a.api,
                        project_id=a.project_id, budget_mb=a.budget_mb)
    map_path = os.path.join(sakura, 'comp_map.json')
    cmap = {}
    if os.path.exists(map_path):
        cmap = json.load(open(map_path, encoding='utf-8'))
    pkey = str(a.project_id)
    pm = cmap.setdefault(pkey, {})
    W, H, fps = doc['project']['width'], doc['project']['height'], doc['project']['fps']

    def comp_of(sn):
        if sn is None:
            return None
        k = str(sn)
        if k in pm:
            return pm[k]
        if dry:
            return -sn if sn else None       # 文書だけ書くときの仮の番号
        if not any(s == sn for s in all_scenes):
            return None
        sc = next(s for s in doc['exedit']['scenes'] if s['index'] == sn)
        c = api.call('POST', '/api/comps/', {'project_id': a.project_id, 'name': scene_name(doc, sn, SCENE_NAMES),
                                             'width': sc['width'] or W, 'height': sc['height'] or H, 'fps': fps,
                                             'duration_frames': 1, 'data': {'version': 1, 'bg': None, 'layers': []}})
        pm[k] = c['id']
        json.dump(cmap, open(map_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        return c['id']

    if not dry:
        # 前に作った comp が消されていたら作り直す
        have = {c['id'] for c in api.call('GET', f'/api/comps/?project_id={a.project_id}')}
        for k in [k for k, v in pm.items() if v not in have]:
            del pm[k]
    rdir = a.report_dir or os.path.join(sakura, 'import_reports')
    os.makedirs(rdir, exist_ok=True)
    dry_out = {}
    for sn in todo:
        b = SceneBuilder(doc, sn, mats, comp_of, a)
        data, dur = b.build()
        rep = jsonable(b.rep)
        rep['missing'] = sorted(set(rep['missing']))
        if dry:
            dry_out[str(sn)] = {'name': scene_name(doc, sn, SCENE_NAMES), 'width': b.W, 'height': b.H, 'fps': fps,
                                'duration_frames': dur, 'data': data}
        else:
            cid = comp_of(sn)
            api.call('PATCH', f'/api/comps/{cid}', {'name': scene_name(doc, sn, SCENE_NAMES), 'width': b.W, 'height': b.H,
                                                    'fps': fps, 'duration_frames': dur, 'data': data})
            rep['comp_id'] = cid
        json.dump(rep, open(os.path.join(rdir, f'scene{sn:02d}.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        um = sum(rep['effects_unmapped'].values())
        print(f"scene {sn:2d} → comp {rep.get('comp_id', '-')}: レイヤー {rep['layers_out']} (元 {rep['objects_total']}、無効 {rep['dropped_disabled']}・非表示段 {rep['dropped_hidden_layer']} を除く) "
              f"効果 {sum(rep['effects_mapped'].values())} 未対応 {um} 素材なし {len(rep['missing'])}")
    if dry:
        json.dump(dry_out if len(dry_out) > 1 else next(iter(dry_out.values())), open(a.dry_run, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    else:
        json.dump(cmap, open(map_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    mats.save()


if __name__ == '__main__':
    main()
