#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""aep_parse.py の JSON (AE のプロジェクト) を comp-kit のコンポジション文書にする。

    python3 aep_to_comp.py aep_full.json --root 000 --out DIR [--id-base 380000] [--placeholder]

AE のコンポ 1 個 = 文書 1 個 (DIR/<id>.json。id = id_base + AE の item id)。入れ子はそのまま comp レイヤー。
素材 (フッテージ) は使わない決まりなので、既定では「仮の板」(素材の大きさの淡い四角 + 名前) に置き換える。
差し替え表 (--assets map.json: {"<AE footage id>": {"asset_id": N}}) があればその素材を置く。

変換のきまり:
- 時刻: コマ = 秒 × そのコンポの fps。レイヤーの in / out はコンポの時間。入れ子の start = (in − レイヤーの start) × fps。
- 変形: AE のアンカーはレイヤー空間 (大きさのあるレイヤーは左上原点)。comp-kit は中心からのずれなので、
  大きさのあるレイヤー (素材・入れ子・平面) は (w/2, h/2) を引く。子の位置も親の箱の中心原点に直す。
  シェイプ・テキスト・ヌルは原点 = レイヤーの原点。シェイプの中身は「ヌル (AE のレイヤー) → ヌル (グループ) → 形」の親子にする。
- イージング: AE の速さ・影響 → 3 次ベジェ [x1, y1, x2, y2]。空間の値は道のり、それ以外は一番大きく動く次元で決める。
  空間の接線がある位置 (曲がった動きの道) と、次元ごとにキーの時刻が違う X / Y 分割は、毎コマのキーに焼く。
- エクスプレッション: よく使う形だけ読む (effect("…")("…") の参照、value + [...]、loopOut、数 * time)。
  読めないものは値のまま残し、unresolved に数える。
"""
import argparse
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict

STATS = Counter()
UNRESOLVED = Counter()


def hexc(c):
    """AE の色 ARGB (0〜255) か RGB → '#rrggbb'"""
    if c is None:
        return None
    # 静的値は末尾の 0 が落ちている → ARGB の 4 つにそろえる
    c = vecn(c, 4)
    c = c[1:4]
    return '#%02x%02x%02x' % tuple(max(0, min(255, int(round(x)))) for x in c[:3])


# ------------------------------------------------------------------ プロパティの木を引く
def kid(node, mn):
    for k in node.get('kids', []) if isinstance(node, dict) else node:
        if k.get('mn') == mn:
            return k
    return None


def kids_of(props, mn):
    for k in props:
        if k.get('mn') == mn:
            return k
    return None


def find_all(props, mn):
    for k in props:
        if k.get('mn') == mn:
            yield k
        if 'kids' in k:
            yield from find_all(k['kids'], mn)


# ------------------------------------------------------------------ キーフレーム → comp-kit の値
def bez_of(k0, k1, dv, dt, spatial, dim_i):
    """k0 → k1 の区間の 3 次ベジェ。None = 直線"""
    if k0['o'] == 3:
        return 'hold'
    if spatial:
        so, io = k0.get('so', 0), k0.get('io', 1 / 6)
        si, ii = k1.get('si', 0), k1.get('ii', 1 / 6)
    else:
        so, io = k0['so'][dim_i], k0['io'][dim_i]
        si, ii = k1['si'][dim_i], k1['ii'][dim_i]
    out_lin = k0['o'] == 1
    in_lin = k1['i'] == 1
    if out_lin and in_lin:
        return None
    if abs(dv) < 1e-9 or dt <= 0:
        return None
    x1 = 1 / 3 if out_lin else max(0.0, min(1.0, io))
    y1 = x1 if out_lin else so * io * dt / dv
    x2 = 2 / 3 if in_lin else max(0.0, min(1.0, 1 - ii))
    y2 = x2 if in_lin else 1 - si * ii * dt / dv
    if abs(x1 - y1) < 1e-4 and abs(x2 - y2) < 1e-4:
        return None
    return [round(x1, 4), round(y1, 4), round(x2, 4), round(y2, 4)]


def cubic_bezier_y(e, x):
    x1, y1, x2, y2 = e
    lo, hi, t = 0.0, 1.0, x
    for _ in range(30):
        bx = 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3
        if abs(bx - x) < 1e-7:
            break
        if bx < x:
            lo = t
        else:
            hi = t
        t = (lo + hi) / 2
    return 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3


def ae_value_at(p, t):
    """AE のプロパティの時刻 t (レイヤー時間, 秒) の値。曲がった道・停止つき"""
    ks = p['k']
    if t <= ks[0]['t']:
        return ks[0]['v']
    if t >= ks[-1]['t']:
        return ks[-1]['v']
    for a, b in zip(ks, ks[1:]):
        if a['t'] <= t <= b['t']:
            break
    dt = b['t'] - a['t']
    x = (t - a['t']) / dt if dt > 0 else 1
    va, vb = a['v'], b['v']
    if a['o'] == 3:
        return va
    sp = p.get('spatial')
    if isinstance(va, list):
        if sp:
            dv = a_dist(a, b)
            e = bez_of(a, b, dv, dt, True, 0)
            u = cubic_bezier_y(e, x) if isinstance(e, list) else x
            to, ti = a.get('to') or [0] * len(va), b.get('ti') or [0] * len(va)
            if any(abs(v) > 1e-6 for v in to + ti):
                return bez_point(va, [va[i] + to[i] for i in range(len(va))], [vb[i] + ti[i] for i in range(len(vb))], vb, arc_u(va, to, ti, vb, u))
            return [va[i] + (vb[i] - va[i]) * u for i in range(len(va))]
        out = []
        for i in range(len(va)):
            e = bez_of(a, b, vb[i] - va[i], dt, False, i)
            u = cubic_bezier_y(e, x) if isinstance(e, list) else x
            out.append(va[i] + (vb[i] - va[i]) * u)
        return out
    e = bez_of(a, b, vb - va, dt, False, 0)
    u = cubic_bezier_y(e, x) if isinstance(e, list) else x
    return va + (vb - va) * u


def bez_point(p0, c0, c1, p1, t):
    u = 1 - t
    return [u ** 3 * p0[i] + 3 * u * u * t * c0[i] + 3 * u * t * t * c1[i] + t ** 3 * p1[i] for i in range(len(p0))]


def arc_u(p0, to, ti, p1, u):
    """道のりの割合 u → 曲線の媒介変数"""
    c0 = [p0[i] + to[i] for i in range(len(p0))]
    c1 = [p1[i] + ti[i] for i in range(len(p1))]
    n = 64
    pts = [bez_point(p0, c0, c1, p1, j / n) for j in range(n + 1)]
    cum = [0.0]
    for j in range(1, n + 1):
        cum.append(cum[-1] + math.dist(pts[j], pts[j - 1]))
    tot = cum[-1]
    if tot <= 0:
        return u
    d = u * tot
    for j in range(1, n + 1):
        if cum[j] >= d:
            f = (d - cum[j - 1]) / max(1e-9, cum[j] - cum[j - 1])
            return (j - 1 + f) / n
    return 1.0


def a_dist(a, b):
    va, vb = a['v'], b['v']
    to, ti = a.get('to') or [0] * len(va), b.get('ti') or [0] * len(vb)
    if any(abs(v) > 1e-6 for v in to + ti):
        c0 = [va[i] + to[i] for i in range(len(va))]
        c1 = [vb[i] + ti[i] for i in range(len(vb))]
        pts = [bez_point(va, c0, c1, vb, j / 32) for j in range(33)]
        return sum(math.dist(pts[j], pts[j - 1]) for j in range(1, 33))
    return math.dist(va, vb)


def conv_prop(p, start, fps, fn=lambda v: v, default=None, layer_dur=None):
    """AE のプロパティ → comp-kit のプロパティ値。start = レイヤーの start (秒)"""
    if p is None:
        return default
    if 'k' not in p:
        v = p.get('v', default)
        return fn(v) if v is not None else default
    ks = p['k']
    if not p.get('dim'):
        STATS['keys_unknown_layout'] += 1
        return default
    curved = p.get('spatial') and any(
        any(abs(x) > 1e-6 for x in (k.get('to') or []) + (k.get('ti') or [])) for k in ks)
    if curved:
        # 曲がった動きの道は毎コマに焼く
        STATS['baked_curved_paths'] += 1
        t0, t1 = ks[0]['t'], ks[-1]['t']
        f0, f1 = math.floor((start + t0) * fps), math.ceil((start + t1) * fps)
        out = []
        for f in range(f0, f1 + 1):
            t = f / fps - start
            out.append({'f': f, 'v': fn(ae_value_at(p, t))})
        return {'k': out}
    out = []
    for i, k in enumerate(ks):
        d = {'f': round((start + k['t']) * fps, 3), 'v': fn(k['v'])}
        if i + 1 < len(ks):
            b = ks[i + 1]
            dt = b['t'] - k['t']
            if k['o'] == 3:
                d['e'] = 'hold'
            elif isinstance(k['v'], list):
                if p.get('spatial'):
                    e = bez_of(k, b, a_dist(k, b), dt, True, 0)
                else:
                    dims = [abs(b['v'][j] - k['v'][j]) for j in range(len(k['v']))]
                    j = max(range(len(dims)), key=lambda q: dims[q])
                    e = bez_of(k, b, b['v'][j] - k['v'][j], dt, False, j)
                    # 次元ごとにイージングが違えば毎コマに焼く
                    es = [bez_of(k, b, b['v'][q] - k['v'][q], dt, False, q) for q in range(len(dims)) if dims[q] > 1e-6]
                    if any(x != es[0] for x in es):
                        return bake(p, start, fps, fn)
                if e:
                    d['e'] = e
            else:
                dv = b['v'] - k['v']
                if abs(dv) < 1e-9 and (abs(k['so'][0]) > 1e-6 or abs(b['si'][0]) > 1e-6):
                    return bake(p, start, fps, fn)  # 同じ値に戻る行き過ぎ
                e = bez_of(k, b, dv, dt, False, 0)
                if e:
                    d['e'] = e
        out.append(d)
    return {'k': out}


def bake(p, start, fps, fn):
    STATS['baked_props'] += 1
    ks = p['k']
    f0, f1 = math.floor((start + ks[0]['t']) * fps), math.ceil((start + ks[-1]['t']) * fps)
    out = []
    for f in range(f0, f1 + 1):
        out.append({'f': f, 'v': fn(ae_value_at(p, f / fps - start))})
    # 停止キーは焼くとき 1 コマずれないよう、そのまま残す
    return {'k': out}


def vecn(v, n, fill=0):
    """静的値は末尾の 0 を落として入っているので、次元をそろえる"""
    if not isinstance(v, list):
        v = [v]
    return list(v[:n]) + [fill] * (n - len(v))


def map_val(pv, fn):
    """comp-kit のプロパティ値に関数を掛ける"""
    if isinstance(pv, dict) and 'k' in pv:
        return dict(pv, k=[dict(k, v=fn(k['v'])) for k in pv['k']])
    return fn(pv) if pv is not None else None


def merge_xy(px, py, pz=None):
    """X / Y (/ Z) に分けた位置を 1 本にする。キーの時刻がそろわなければ毎コマに焼く"""
    vals = [px, py] + ([pz] if pz is not None else [])
    keyed = [v for v in vals if isinstance(v, dict)]
    if not keyed:
        return [v if v is not None else 0 for v in vals]
    frames = sorted({k['f'] for v in keyed for k in v['k']})

    def at(v, f):
        if not isinstance(v, dict):
            return v or 0
        ks = v['k']
        if f <= ks[0]['f']:
            return ks[0]['v']
        if f >= ks[-1]['f']:
            return ks[-1]['v']
        for a, b in zip(ks, ks[1:]):
            if a['f'] <= f <= b['f']:
                x = (f - a['f']) / (b['f'] - a['f']) if b['f'] > a['f'] else 1
                e = a.get('e')
                if e == 'hold':
                    return a['v']
                u = cubic_bezier_y(e, x) if isinstance(e, list) else x
                return a['v'] + (b['v'] - a['v']) * u
        return ks[-1]['v']

    same = len(keyed) == 1 or all([k['f'] for k in v['k']] == [k['f'] for k in keyed[0]['k']] and
                                  [k.get('e') for k in v['k']] == [k.get('e') for k in keyed[0]['k']] for v in keyed)
    if same:
        return {'k': [dict({'f': f, 'v': [at(v, f) for v in vals]},
                           **({'e': keyed[0]['k'][i]['e']} if 'e' in keyed[0]['k'][i] else {}))
                      for i, f in enumerate(frames)]}
    STATS['baked_separated'] += 1
    f0, f1 = int(math.floor(frames[0])), int(math.ceil(frames[-1]))
    return {'k': [{'f': f, 'v': [round(at(v, f), 3) for v in vals]} for f in range(f0, f1 + 1)]}


# ------------------------------------------------------------------ エクスプレッション
def resolve_expr(p, layer, comp_layers, start, fps, fn, default):
    x = p.get('x') or ''
    xs = x.strip()
    base = conv_prop(p, start, fps, fn, default)
    m = re.fullmatch(r'effect\("([^"]+)"\)\("([^"]+)"\)\s*;?', xs)
    if m:
        ref = effect_param(layer, m.group(1), m.group(2))
        if ref is not None:
            STATS['expr_effect_ref'] += 1
            return conv_prop(ref, start, fps, fn, default)
    m = re.fullmatch(r'effect\("([^"]+)"\)\("([^"]+)"\)\s*([+-])\s*(-?[\d.]+)\s*;?', xs)
    if m:
        ref = effect_param(layer, m.group(1), m.group(2))
        if ref is not None:
            STATS['expr_effect_ref_add'] += 1
            off = float(m.group(4)) * (1 if m.group(3) == '+' else -1)
            return conv_prop(ref, start, fps, lambda v: fn(v + off) if not isinstance(v, list) else fn(v), default)
    m = re.fullmatch(r'value\s*\+\s*\[(.*)\]\s*;?', xs, re.S)
    if m:
        refs = [effect_param(layer, *mm) for mm in re.findall(r'effect\("([^"]+)"\)\("([^"]+)"\)', m.group(1))]
        if refs and all(r is not None for r in refs) and any('k' in r for r in refs):
            # 参照先が動く: 毎コマに焼く (範囲 = 全部のキーの範囲)
            STATS['expr_value_add_baked'] += 1
            ts = [k['t'] for q in [p] + refs if 'k' in q for k in q['k']]
            f0 = int(math.floor((start + min(ts)) * fps))
            f1 = int(math.ceil((start + max(ts)) * fps))

            def at(q, t):
                if 'k' in q:
                    v = ae_value_at(q, t)
                else:
                    v = q.get('v') or 0
                return v
            out = []
            for f in range(f0, f1 + 1):
                t = f / fps - start
                base_v = vecn(at(p, t), len(refs))
                add = [vecn(at(r, t), 1)[0] for r in refs]
                out.append({'f': f, 'v': fn([round(base_v[i] + add[i], 3) for i in range(len(refs))])})
            return {'k': out}
        if refs and all(r is not None for r in refs) and not any('k' in r for r in refs):
            add = [r.get('v') or 0 for r in refs]
            add = [a if not isinstance(a, list) else a[0] for a in add]
            STATS['expr_value_add'] += 1
            return conv_prop(p, start, fps, lambda v: fn([vv + (add[i] if i < len(add) else 0) for i, vv in enumerate(vecn(v, len(add)))]), default)
    m = re.fullmatch(r'try\s*\{.*\}\s*catch\s*\(e\)\s*\{\s*value\s*\}', xs, re.S)
    if m:
        STATS['expr_try_value'] += 1
        return base
    m = re.fullmatch(r'loopOut\("(pingpong|cycle)"\)\s*;?', xs)
    if m:
        STATS['expr_loopout'] += 1
        if isinstance(base, dict):
            return dict(base, loop=m.group(1))
        return base
    m = re.fullmatch(r'(-?[\d.]+)\s*\*\s*time\s*;?', xs)
    if m:
        STATS['expr_time'] += 1
        rate = float(m.group(1))
        f_in, f_out = layer['in'] * fps, layer['out'] * fps
        return {'k': [{'f': round(f_in, 3), 'v': fn(rate * layer['in'])}, {'f': round(f_out, 3), 'v': fn(rate * layer['out'])}]}
    refs = re.findall(r'effect\("([^"]+)"\)\("([^"]+)"\)', xs)
    if refs and any(effect_param(layer, *r) is None for r in refs):
        # 無いエフェクトを呼ぶ式は AE でもエラーで止まり、元の値になる
        STATS['expr_missing_effect_value'] += 1
        return base
    UNRESOLVED[xs.splitlines()[0][:80] if xs else ''] += 1
    return base


def effect_param(layer, ename, pname):
    r = _effect_param(layer, ename, pname)
    if r is None:
        # 擬似エフェクト (Pseudo/…) は名前が入っていないので、項目の名前だけで探す
        for e in iter_effects(layer):
            if e.get('mn', '').startswith('Pseudo/') and not e.get('name'):
                for q in e.get('kids', []):
                    if q.get('name') == pname:
                        return q
    return r


def _effect_param(layer, ename, pname):
    for e in iter_effects(layer):
        if e.get('user_name') == ename or (not e.get('user_name') and e.get('name') == ename):
            for q in e.get('kids', []):
                if q.get('name') == pname or q.get('mn', '').endswith(pname):
                    return q
            # 名前が無い (既定名) ときは 1 番目の値
            vals = [q for q in e.get('kids', []) if 'kids' not in q and not q.get('mn', '').endswith('-0000')]
            if vals:
                return vals[0]
    return None


def iter_effects(layer):
    par = kids_of(layer.get('props', []), 'ADBE Effect Parade')
    if par:
        for e in par.get('kids', []):
            if e.get('effect'):
                yield e


def pv(p, layer, start, fps, fn=lambda v: v, default=None):
    """プロパティ → 値 (エクスプレッションつき)"""
    if p is None:
        return default
    if p.get('x'):
        return resolve_expr(p, layer, None, start, fps, fn, default)
    return conv_prop(p, start, fps, fn, default)


# ------------------------------------------------------------------ 変換の本体
class Conv:
    def __init__(self, items, id_base, placeholder=True, assets=None):
        self.items = items
        self.by = {i['id']: i for i in items}
        self.id_base = id_base
        self.placeholder = placeholder
        self.assets = assets or {}
        self.docs = {}
        self.missing_fx = Counter()
        self.footage_used = Counter()

    def size_of(self, item):
        if not item:
            return (0, 0)
        return (item.get('width') or 0, item.get('height') or 0)

    def layer_size(self, L, comp):
        s = self.by.get(L['source_id'])
        if s and s['type'] in ('comp', 'footage'):
            return self.size_of(s)
        return (0, 0)

    def convert_comp(self, cid):
        if cid in self.docs:
            return self.id_base + cid
        c = self.by[cid]
        self.docs[cid] = None  # 循環よけ
        fps = c.get('fps_exact') or 60
        layers = []
        ae_layers = c.get('layers', [])
        sizes = {L['id']: self.layer_size(L, c) for L in ae_layers}
        kinds = {}
        for L in ae_layers:
            kinds[L['id']] = self.kind(L)
        for L in ae_layers:
            layers.extend(self.convert_layer(L, c, fps, sizes, kinds))
        bgc = c.get('bg')
        doc = {'id': self.id_base + cid, 'name': c['name'], 'width': c['width'], 'height': c['height'],
               'fps': fps, 'duration_frames': int(round((c.get('duration') or 0) * fps)),
               'data': {'version': 1, 'bg': None, 'layers': layers}}
        self.docs[cid] = doc
        return doc['id']

    def kind(self, L):
        props = L.get('props', [])
        if 'camera' in L['flags']:
            return 'camera'
        if kids_of(props, 'ADBE Root Vectors Group'):
            return 'shape'
        if kids_of(props, 'ADBE Text Properties'):
            return 'text'
        s = self.by.get(L['source_id'])
        if 'null' in L['flags']:
            return 'null'
        if 'adjustment' in L['flags']:
            return 'adjustment'
        if s and s['type'] == 'comp':
            return 'comp'
        if s and s.get('solid'):
            return 'solid'
        if s:
            return 'footage'
        return 'null'

    def transform(self, L, fps, size, parent_size, kind):
        props = L.get('props', [])
        tg = kids_of(props, 'ADBE Transform Group') or {'kids': []}
        st = L['start']
        w, h = size
        pw, ph = parent_size
        three = 'threeD' in L['flags']
        anc = pv(kid(tg, 'ADBE Anchor Point'), L, st, fps, default=None)
        pos = kid(tg, 'ADBE Position')
        if pos is not None:
            posv = pv(pos, L, st, fps, default=None)
        elif any(q is not None and ('k' in q or q.get('x') or q.get('v')) for q in
                 (kid(tg, 'ADBE Position_0'), kid(tg, 'ADBE Position_1'), kid(tg, 'ADBE Position_2'))):
            # 次元を分けた位置 (分けていないときも 0 の X/Y が入っているので、キーか 0 以外のときだけ)
            px = pv(kid(tg, 'ADBE Position_0'), L, st, fps, default=0)
            py = pv(kid(tg, 'ADBE Position_1'), L, st, fps, default=0)
            pz = pv(kid(tg, 'ADBE Position_2'), L, st, fps, default=0) if three else None
            posv = merge_xy(px, py, pz)
        else:
            posv = None
        if posv is None:
            # 既定 = コンポの中心 (シェイプ・テキストも同じ)
            posv = [self.cur_comp['width'] / 2, self.cur_comp['height'] / 2, 0]
        # 既定値 (ファイルに無い): アンカー = 箱の中心、位置 = コンポの中心
        if anc is None:
            anc = [w / 2, h / 2, 0]
        T = {}

        def sub2(v, dx, dy):
            v = vecn(v, 3)
            return [round(v[0] - dx, 3), round(v[1] - dy, 3)] + ([round(v[2], 3)] if three else [])

        T['position'] = map_val(posv, lambda v: sub2(v, pw / 2, ph / 2))
        T['anchor'] = map_val(anc, lambda v: sub2(v, w / 2, h / 2))
        sc = pv(kid(tg, 'ADBE Scale'), L, st, fps, default=None)
        if sc is not None:
            T['scale'] = map_val(sc, lambda v: [round(x * 100, 4) for x in (v if isinstance(v, list) and len(v) >= 2 else [vecn(v, 1)[0]] * 3)][:3 if three else 2])
        rz = pv(kid(tg, 'ADBE Rotate Z'), L, st, fps, default=0)
        if three:
            rx = pv(kid(tg, 'ADBE Rotate X'), L, st, fps, default=0)
            ry = pv(kid(tg, 'ADBE Rotate Y'), L, st, fps, default=0)
            ori = kid(tg, 'ADBE Orientation')
            if isinstance(rx, dict) or isinstance(ry, dict) or isinstance(rz, dict):
                T['rotation'] = merge_xy(rx, ry, rz)
            elif rx or ry or rz:
                T['rotation'] = [rx, ry, rz]
        elif rz:
            T['rotation'] = rz
        op = pv(kid(tg, 'ADBE Opacity'), L, st, fps, default=None)
        if op is not None:
            T['opacity'] = map_val(op, lambda v: round(v * 100, 3))
        return T

    def base_layer(self, L, c, fps, kind, sizes):
        lid = 'L%d' % L['id']
        d = {'id': lid, 'name': L.get('name') or (self.by.get(L['source_id'], {}).get('name') or lid),
             'in': round(L['in'] * fps, 3), 'out': round(L['out'] * fps, 3)}
        if 'visible' not in L['flags']:
            d['visible'] = False
        if 'threeD' in L['flags']:
            d['three_d'] = True
        if 'motion_blur' in L['flags']:
            d['motion_blur'] = True
        par = L.get('parent_id')
        psize = (0, 0)
        if par and par in sizes:
            d['parent'] = 'L%d' % par
            psize = sizes[par]
        if L.get('matte_mode') and L.get('matte_id'):
            d['matte'] = {'layer': 'L%d' % L['matte_id'],
                          'mode': {1: 'alpha', 2: 'alpha_inv', 3: 'luma', 4: 'luma_inv'}.get(L['matte_mode'], 'alpha')}
        return d, psize

    def convert_layer(self, L, c, fps, sizes, kinds):
        kind = kinds[L['id']]
        d, psize = self.base_layer(L, c, fps, kind, sizes)
        size = sizes[L['id']]
        out = []
        if kind == 'camera':
            d['type'] = 'camera'
            d['transform'] = self.transform(L, fps, (0, 0), psize, kind)
            cam = kids_of(L.get('props', []), 'ADBE Camera Options Group')
            zoom = pv(kid(cam, 'ADBE Camera Zoom'), L, L['start'], fps, default=None) if cam else None
            d['source'] = {'zoom': zoom if zoom is not None else round(c['width'] / 2 / math.tan(math.radians(39.6 / 2)), 2)}
            # AE の 2 ノードカメラ: 目標点
            tg = kids_of(L.get('props', []), 'ADBE Transform Group')
            poi = pv(kid(tg, 'ADBE Anchor Point'), L, L['start'], fps, default=None) if tg else None
            if poi is not None:
                d['source']['target'] = map_val(poi, lambda v: vecn(v, 3))
            d['transform'].pop('anchor', None)
            return [d]
        d['transform'] = self.transform(L, fps, size, psize, kind)
        d['effects'] = self.effects(L, fps, size)
        if not d['effects']:
            del d['effects']
        masks = self.masks(L, fps, size)
        if masks:
            d['masks'] = masks
        if kind == 'comp':
            s = self.by[L['source_id']]
            d['type'] = 'comp'
            d['source'] = {'comp_id': self.convert_comp(s['id'])}
            d['start'] = round((L['in'] - L['start']) * fps, 3)
            tr = kid({'kids': L.get('props', [])}, 'ADBE Time Remapping')
            if tr and 'k' in tr:
                d['time_remap'] = conv_prop(tr, L['start'], fps, lambda v: round(v * (s.get('fps_exact') or fps), 3))
                STATS['time_remap'] += 1
            return [d]
        if kind == 'solid':
            s = self.by[L['source_id']]
            d['type'] = 'solid'
            d['source'] = {'color': hexc([255] + [x * 255 for x in s.get('solid_color', [1, 0.5, 0.5, 0.5])[1:]])
                           if s.get('solid_color') else '#808080', 'width': size[0], 'height': size[1]}
            return [d]
        if kind == 'adjustment':
            d['type'] = 'adjustment'
            return [d]
        if kind == 'null':
            d['type'] = 'null'
            return [d]
        if kind == 'footage':
            s = self.by[L['source_id']]
            self.footage_used[s['id']] += 1
            a = self.assets.get(str(s['id']))
            if a:
                d['type'] = 'image'
                d['source'] = dict(a, fit={'width': size[0], 'height': size[1]})
            else:
                d['type'] = 'shape'
                name = os.path.basename((s.get('path') or s.get('name') or '').replace('\\', '/'))
                d['source'] = {'kind': 'rect', 'width': size[0], 'height': size[1],
                               'fill': '#d9c8e8', 'stroke': '#8a6aa8', 'stroke_width': 6}
                d['name'] = '仮: ' + name
                d['placeholder'] = {'ae_footage_id': s['id'], 'file': name}
            return [d]
        if kind == 'text':
            d['type'] = 'text'
            tp = kids_of(L.get('props', []), 'ADBE Text Properties')
            doc = None
            for td in find_all(tp.get('kids', []), 'ADBE Text Document'):
                doc = td.get('doc')
            doc = doc or {}
            size = doc.get('size') or 60
            src = {'text': doc.get('text') if doc.get('text') is not None else (L.get('name') or ''),
                   'font': self.font_map(doc.get('font')), 'size': size,
                   'align': {0: 'left', 1: 'right', 2: 'center'}.get(doc.get('justify'), 'left'),
                   'valign': 'top'}
            lead = doc.get('leading') or 0
            if lead and lead > 1:
                src['leading'] = lead
            if doc.get('fill_on', True) and doc.get('fill'):
                src['fill'] = hexc([255] + [x * 255 for x in doc['fill'][1:4]])
            else:
                src['fill'] = None
            if doc.get('stroke_on') and doc.get('stroke') and (doc.get('stroke_width') or 0) > 0.5:
                src['stroke'] = hexc([255] + [x * 255 for x in doc['stroke'][1:4]])
                src['stroke_width'] = doc['stroke_width']
            if doc.get('tracking'):
                src['tracking'] = round(doc['tracking'] / 1000 * size, 2)
            d['source'] = src
            # AE の文字の原点 = 1 行目のベースライン。comp-kit (valign top) の原点は箱の上端なので、アンカーを字の高さぶん下げる
            asc = round(size * 0.88, 2)
            d['transform']['anchor'] = map_val(d['transform'].get('anchor', [0, 0]),
                                               lambda v: [v[0], round(v[1] + asc, 2)] + list(v[2:]))
            if kids_of(tp.get('kids', []), 'ADBE Text Animators') and kids_of(tp.get('kids', []), 'ADBE Text Animators').get('kids'):
                STATS['text_animators'] += 1
            STATS['text_layers'] += 1
            return [d]
        if kind == 'shape':
            # AE のシェイプレイヤー = ヌル (原点 = レイヤーの原点) + 中身
            d['type'] = 'null'
            out.append(None)  # 先頭はあとで入れる (中身より後ろ = 奥にはしない。ヌルは描かれない)
            contents = self.shape_contents(L, fps, d['id'], kids_of(L.get('props', []), 'ADBE Root Vectors Group'))
            # マット・エフェクト・不透明度はヌルでは効かないので中身に配る
            fx = d.pop('effects', None)
            mt = d.get('matte')
            for ch in contents:
                ch['in'], ch['out'] = d['in'], d['out']
                if 'visible' in d:
                    ch['visible'] = d['visible']
                if d.get('three_d'):
                    ch['three_d'] = True
                if d.get('motion_blur'):
                    ch['motion_blur'] = True
            op = d['transform'].pop('opacity', None)
            if len(contents) == 1 and not contents[0].get('parent_is_group'):
                # 1 個だけなら 1 枚にまとめる (ヌルを作らない)
                ch = contents[0]
                lt = d['transform']
                ct = ch.get('transform', {})
                # 形の位置 (レイヤー空間) はアンカーから引く
                cp = ct.get('position', [0, 0])
                if isinstance(cp, list) and not isinstance(lt.get('anchor'), dict) and \
                        not any(k in ct for k in ('scale', 'rotation', 'anchor')):
                    ch['id'], ch['name'] = d['id'], d['name']
                    ch.pop('parent', None)
                    if 'parent' in d:
                        ch['parent'] = d['parent']
                    if mt:
                        ch['matte'] = mt
                    an = lt.get('anchor', [0, 0])
                    an = an if isinstance(an, list) else [0, 0]
                    lt['anchor'] = [round(an[0] - cp[0], 3), round(an[1] - cp[1], 3)] + an[2:]
                    ct.pop('position', None)
                    if 'opacity' in ct:
                        op = op if op is not None else ct['opacity']
                    ch['transform'] = lt
                    if op is not None:
                        lt['opacity'] = op
                    if fx:
                        for e in fx:
                            if e.get('_box_rel') and isinstance(cp, list):
                                # 箱の中心 = 形の位置 (AE のレイヤー空間)
                                e['params']['cx'] = round(e['params']['cx'] - cp[0], 2)
                                e['params']['cy'] = round(e['params']['cy'] - cp[1], 2)
                        ch['effects'] = fx + ch.get('effects', [])
                    if d.get('masks'):
                        ch['masks'] = d['masks']
                    return [ch]
            if op is not None:
                for ch in contents:
                    ch.setdefault('transform', {})
                    if 'opacity' not in ch['transform']:
                        ch['transform']['opacity'] = op
            if fx or mt or d.get('masks'):
                # まとめて掛けたいので、中身を入れ子にせず「グループ」レイヤーにする
                d['type'] = 'group'
                d['source'] = {'layers': [ch['id'] for ch in contents]}
                if fx:
                    d['effects'] = fx
                STATS['shape_group_fx'] += 1
            out = [d] + contents
            return out
        return [d]

    FONTS = {'APJapanesefont': 'APJapanesefont', 'APJapanesefontT': 'APJapanesefont'}
    MISSING_FONTS = Counter()

    def font_map(self, f):
        if not f:
            return 'Noto Sans JP'
        if f in self.FONTS:
            return self.FONTS[f]
        self.MISSING_FONTS[f] += 1
        if 'Heavy' in f or 'Black' in f or f in ('Impact',) or 'Bold' in f:
            return 'Noto Sans JP'
        return 'Noto Sans JP'

    # ---------------------------------------------------------- シェイプの中身
    def shape_contents(self, L, fps, parent_id, root):
        st = L['start']
        res = []
        if not root:
            return res
        self._shape_group(L, fps, st, root.get('kids', []), parent_id, [], res, '%s_' % parent_id, False)
        return res

    def _shape_group(self, L, fps, st, items, parent_id, inherited, res, prefix, is_group):
        # items は上から順。塗り・線はそれより上の形に掛かる
        res_start = len(res)
        paths = []
        n = 0
        items = [it for it in items if it.get('enabled', True)]  # 目を閉じた形・塗り・線は描かない
        for idx, it in enumerate(items):
            mn = it.get('mn', '')
            if mn in ('ADBE Vector Shape - Rect', 'ADBE Vector Shape - Ellipse', 'ADBE Vector Shape - Group',
                      'ADBE Vector Shape - Star', 'ADBE Vector Group'):
                paths.append((idx, it))
        paints = [(idx, it) for idx, it in enumerate(items)
                  if it.get('mn') in ('ADBE Vector Graphic - Fill', 'ADBE Vector Graphic - Stroke', 'ADBE Vector Graphic - G-Fill')]
        trims = [it for it in items if it.get('mn') == 'ADBE Vector Filter - Trim']
        reps = [(idx, it) for idx, it in enumerate(items) if it.get('mn') == 'ADBE Vector Filter - Repeater']
        if any(it.get('mn') == 'ADBE Vector Filter - Merge' for it in items):
            STATS['shape_merge_paths'] += 1
        for idx, it in paths:
            mn = it['mn']
            # この形に掛かる塗り・線 = 同じ階層で後ろにあるもの + 親から
            my_paints = [p for j, p in paints if j > idx] + [p for p in inherited]
            if mn == 'ADBE Vector Group':
                g = it
                vg = kid(g, 'ADBE Vectors Group')
                tg = kid(g, 'ADBE Vector Transform Group')
                gid = '%sG%d' % (prefix, idx)
                gl = {'id': gid, 'name': g.get('name') or gid, 'type': 'null', 'parent': parent_id,
                      'transform': self.group_transform(L, fps, st, tg)}
                res.append(gl)
                start_len = len(res)
                self._shape_group(L, fps, st, vg.get('kids', []) if vg else [], gid, my_paints, res, gid + '_', True)
                # グループの不透明度は中身へ
                gop = gl['transform'].pop('opacity', None)
                if gop is not None:
                    for ch in res[start_len:]:
                        if ch.get('type') == 'shape':
                            ch.setdefault('transform', {}).setdefault('opacity', gop)
                continue
            geom = self.geom(L, fps, st, it)
            if geom is None:
                continue
            first = True
            for p in my_paints:
                lay = {'id': '%sS%d_%d' % (prefix, idx, n), 'name': (it.get('name') or mn.split(' - ')[-1]),
                       'type': 'shape', 'parent': parent_id, 'source': dict(geom['source']),
                       'transform': dict(geom['transform'])}
                if is_group:
                    lay['parent_is_group'] = True
                n += 1
                lay['_paint'] = id(p)
                self.paint(L, fps, st, p, lay)
                if trims:
                    tr = trims[0]
                    s0 = pv(kid(tr, 'ADBE Vector Trim Start'), L, st, fps, default=0)
                    s1 = pv(kid(tr, 'ADBE Vector Trim End'), L, st, fps, default=100)
                    so = pv(kid(tr, 'ADBE Vector Trim Offset'), L, st, fps, default=0)
                    # comp-kit の trim は [始, 終] の 1 本
                    lay['source']['trim'] = merge_xy(s0, s1)
                    if so:
                        lay['source']['trim_offset'] = map_val(so, lambda v: v / 3.6)  # AE は角度、comp-kit は %
                    if lay['source'].get('fill'):
                        lay['source']['trim_fill'] = True  # AE のトリミングは塗りも削る
                        STATS['trim_on_fill'] += 1
                    STATS['shape_trim'] += 1
                for j, rp in reps:
                    if j > idx:
                        lay['repeater'] = self.repeater(L, fps, st, rp)
                        STATS['shape_repeater'] += 1
                        break
                res.append(lay)
            if not my_paints:
                STATS['shape_without_paint'] += 1
        self._merge_compound(res, res_start, parent_id)

    def _merge_compound(self, res, start, parent_id):
        """同じ塗り・線に入る複数のパス = 複合パス (字の穴)。1 枚の path + subpaths にまとめる"""
        first = {}
        drop = set()
        for i in range(start, len(res)):
            ly = res[i]
            if ly.get('parent') != parent_id or '_paint' not in ly:
                continue
            src = ly['source']
            ok = src.get('kind') == 'path' and isinstance(src.get('points'), list) and \
                'trim' not in src and 'repeater' not in ly and ly.get('transform', {}).get('position') == [0, 0]
            if not ok:
                continue
            k = ly['_paint']
            if k in first:
                base = res[first[k]]
                base['source'].setdefault('subpaths', []).append({'points': src['points'], 'closed': src.get('closed', True)})
                drop.add(i)
                STATS['compound_subpaths'] += 1
            else:
                first[k] = i
        for i in sorted(drop, reverse=True):
            del res[i]

    def group_transform(self, L, fps, st, tg):
        T = {'position': [0, 0]}
        if not tg:
            return T
        an = pv(kid(tg, 'ADBE Vector Anchor'), L, st, fps, default=None)
        po = pv(kid(tg, 'ADBE Vector Position'), L, st, fps, default=None)
        sc = pv(kid(tg, 'ADBE Vector Scale'), L, st, fps, default=None)
        ro = pv(kid(tg, 'ADBE Vector Rotation'), L, st, fps, default=None)
        op = pv(kid(tg, 'ADBE Vector Group Opacity'), L, st, fps, default=None)
        if po is not None:
            T['position'] = po
        if an is not None:
            T['anchor'] = an
        if sc is not None:
            T['scale'] = map_val(sc, lambda v: [round(x * 100, 4) for x in (v if isinstance(v, list) else [v, v])][:2])
        if ro:
            T['rotation'] = ro
        if op is not None:
            T['opacity'] = map_val(op, lambda v: round(v * 100, 3))
        if kid(tg, 'ADBE Vector Skew') and kid(tg, 'ADBE Vector Skew').get('v'):
            STATS['shape_skew'] += 1
        return T

    def geom(self, L, fps, st, it):
        mn = it['mn']
        T = {'position': [0, 0]}  # 書かないと comp-kit はコンポの中心に置く
        if mn == 'ADBE Vector Shape - Rect':
            size = pv(kid(it, 'ADBE Vector Rect Size'), L, st, fps, default=[100, 100])
            pos = pv(kid(it, 'ADBE Vector Rect Position'), L, st, fps, default=None)
            rnd = pv(kid(it, 'ADBE Vector Rect Roundness'), L, st, fps, default=0)
            size = self.fix_point_ctrl(L, it, 'ADBE Vector Rect Size', size)
            src = {'kind': 'rect', 'width': map_val(size, lambda v: v[0]), 'height': map_val(size, lambda v: v[1])}
            if rnd:
                src['radius'] = rnd
            if pos is not None:
                T['position'] = pos
            return {'source': src, 'transform': T}
        if mn == 'ADBE Vector Shape - Ellipse':
            size = pv(kid(it, 'ADBE Vector Ellipse Size'), L, st, fps, default=[100, 100])
            size = self.fix_point_ctrl(L, it, 'ADBE Vector Ellipse Size', size)
            pos = pv(kid(it, 'ADBE Vector Ellipse Position'), L, st, fps, default=None)
            src = {'kind': 'ellipse', 'width': map_val(size, lambda v: v[0]), 'height': map_val(size, lambda v: v[1])}
            if pos is not None:
                T['position'] = pos
            return {'source': src, 'transform': T}
        if mn == 'ADBE Vector Shape - Star':
            typ = (kid(it, 'ADBE Vector Star Type') or {}).get('v', 1)
            pts = pv(kid(it, 'ADBE Vector Star Points'), L, st, fps, default=5)
            orad = pv(kid(it, 'ADBE Vector Star Outer Radius'), L, st, fps, default=100)
            irad = pv(kid(it, 'ADBE Vector Star Inner Radius'), L, st, fps, default=50)
            rot = pv(kid(it, 'ADBE Vector Star Rotation'), L, st, fps, default=0)
            pos = pv(kid(it, 'ADBE Vector Star Position'), L, st, fps, default=None)
            o = orad if not isinstance(orad, dict) else orad['k'][0]['v']
            i_ = irad if not isinstance(irad, dict) else irad['k'][0]['v']
            src = {'kind': 'star' if typ == 1 else 'polygon', 'sides': pts,
                   'width': map_val(orad, lambda v: v * 2), 'height': map_val(orad, lambda v: v * 2)}
            if typ == 1:
                src['inner'] = round(i_ / o, 4) if o else 0.5
            if pos is not None:
                T['position'] = pos
            if rot:
                T['rotation'] = rot
            return {'source': src, 'transform': T}
        if mn == 'ADBE Vector Shape - Group':
            sp = kid(it, 'ADBE Vector Shape')
            if not sp:
                return None
            shapes = sp.get('shapes') or []
            if not shapes:
                return None
            if 'k' in sp:
                STATS['shape_path_keyed'] += 1
            sh = shapes[0]
            pts = sh.get('pts') or []
            if len(pts) < 3:
                return None
            # 並び: 頂点 0, 出の接線 0, 入りの接線 1, 頂点 1, … (閉じていれば最後は頂点 0 へ)
            n = len(pts) // 3
            P = []
            for v in range(n):
                vx, vy = pts[3 * v]
                ox, oy = pts[3 * v + 1]
                ix, iy = pts[3 * v - 1] if v > 0 else pts[-1]
                P.append([vx, vy, round(ix - vx, 3), round(iy - vy, 3), round(ox - vx, 3), round(oy - vy, 3)])
            src = {'kind': 'path', 'points': P, 'closed': bool(sh.get('closed', True))}
            if not sh.get('closed', True):
                P[0][2] = P[0][3] = 0
            return {'source': src, 'transform': T}
        return None

    def fix_point_ctrl(self, L, it, mn, val):
        """effect("ポイント制御")("ポイント") の参照はレイヤーの大きさ (= コンポ) の割合で入っている"""
        p = kid(it, mn)
        if p and (p.get('x') or '').startswith('effect("ポイント制御")') and not isinstance(val, dict):
            # 値は割合 → px に (シェイプのレイヤーの大きさ = コンポ)
            comp = self.cur_comp
            if isinstance(val, list) and max(abs(x) for x in val[:2]) <= 4:
                STATS['point_ctrl_scaled'] += 1
                return [round(val[0] * comp['width'], 2), round(val[1] * comp['height'], 2)]
        return val

    def paint(self, L, fps, st, p, lay):
        mn = p['mn']
        src = lay['source']
        if mn == 'ADBE Vector Graphic - Fill':
            col = pv(kid(p, 'ADBE Vector Fill Color'), L, st, fps, hexc, default='#ff0000')
            op = pv(kid(p, 'ADBE Vector Fill Opacity'), L, st, fps, default=None)
            src['fill'] = col
            src['stroke'] = None
            if op is not None and op != 100:
                lay.setdefault('transform', {})['opacity'] = op
        elif mn == 'ADBE Vector Graphic - Stroke':
            col = pv(kid(p, 'ADBE Vector Stroke Color'), L, st, fps, hexc, default='#ffffff')
            wd = pv(kid(p, 'ADBE Vector Stroke Width'), L, st, fps, default=2)
            op = pv(kid(p, 'ADBE Vector Stroke Opacity'), L, st, fps, default=None)
            src['fill'] = None
            src['stroke'] = col
            src['stroke_width'] = wd
            if op is not None and op != 100:
                lay.setdefault('transform', {})['opacity'] = op
            dash = kid(p, 'ADBE Vector Stroke Dashes')
            if dash and dash.get('kids'):
                STATS['stroke_dash'] += 1
        else:
            STATS['gradient_fill'] += 1
            src['fill'] = '#ffffff'
            src['stroke'] = None

    def repeater(self, L, fps, st, rp):
        n = pv(kid(rp, 'ADBE Vector Repeater Copies'), L, st, fps, default=3)
        tr = kid(rp, 'ADBE Vector Repeater Transform') or {}
        pos = pv(kid(tr, 'ADBE Vector Repeater Position'), L, st, fps, default=[100, 0])
        rot = pv(kid(tr, 'ADBE Vector Repeater Rotation'), L, st, fps, default=0)
        return {'count': n if not isinstance(n, dict) else n['k'][-1]['v'], 'mode': 'linear',
                'offset': {'position': pos, 'rotation': rot}}

    # ---------------------------------------------------------- エフェクト・マスク
    def effects(self, L, fps, size):
        out = []
        st = L['start']
        if 'effects_on' not in L['flags']:
            return out
        for e in iter_effects(L):
            mn = e['mn']
            if e.get('enabled') is False:
                STATS['fx_disabled'] += 1
                continue
            P = {q.get('mn', ''): q for q in e.get('kids', []) if 'kids' not in q}

            def g(i, default=None, fn=lambda v: v):
                return pv(P.get('%s-%04d' % (mn, i)), L, st, fps, fn, default)

            if mn in ('ADBE Color Control', 'ADBE Point Control', 'ADBE Slider Control', 'ADBE Angle Control',
                      'ADBE Point3D Control') or mn.startswith('Pseudo/'):
                continue
            if mn == 'ADBE Linear Wipe':
                out.append({'type': 'wipe', 'params': {'progress': g(1, 0), 'angle': g(2, 90), 'feather': g(3, 0)},
                            'ae': 'linear_wipe'})
            elif mn == 'ADBE Radial Wipe':
                out.append({'type': 'radial_wipe', 'params': {'progress': map_val(g(1, 0), lambda v: 100 - v),
                                                              'start': g(2, 0), 'feather': g(5, 0)}, 'ae': 'radial_wipe'})
            elif mn == 'ADBE Venetian Blinds':
                out.append({'type': 'blinds', 'params': {'ratio': g(1, 0), 'angle': g(2, 0), 'pitch': g(3, 10), 'feather': g(4, 0)},
                            'ae': 'venetian_blinds'})
            elif mn == 'ADBE Glo2':
                out.append({'type': 'glow', 'params': {'threshold': map_val(g(2, 60), lambda v: v), 'radius': g(3, 10),
                                                       'strength': g(4, 1)}, 'ae': 'glow'})
            elif mn == 'ADBE Drop Shadow':
                out.append({'type': 'drop_shadow', 'params': {'color': g(1, '#000000', hexc), 'opacity': g(2, 50),
                                                              'angle': g(3, 135), 'distance': g(4, 5), 'blur': g(5, 0)},
                            'ae': 'drop_shadow'})
            elif mn == 'ADBE Fill':
                out.append({'type': 'fill', 'params': {'color': g(2, '#ff0000', hexc), 'amount': 100}, 'ae': 'fill'})
            elif mn == 'ADBE Gaussian Blur 2':
                out.append({'type': 'blur', 'params': {'radius': g(1, 0)}, 'ae': 'gaussian_blur'})
            elif mn == 'ADBE Geometry2':
                pos = g(2, None)
                prm = {}
                if pos is not None:
                    prm['position'] = pos
                sc = g(3, None)
                if sc is not None:
                    prm['scale'] = sc
                ro = g(7, None)
                if ro is not None:
                    prm['rotation'] = ro
                op = g(9, None)
                if op is not None:
                    prm['opacity'] = op
                out.append({'type': 'offset', 'params': prm, 'ae': 'transform'})
                STATS['fx_transform'] += 1
            elif mn == 'ADBE Ramp':
                # グラデーション: 始点・終点はレイヤーの大きさの割合 (レイヤー空間)。comp-kit は箱の中心からの px と角度
                lw, lh = size if size[0] else (self.cur_comp['width'], self.cur_comp['height'])
                sp = vecn(g(1, [0.5, 0]), 2)
                ep = vecn(g(3, [0.5, 1]), 2)
                if isinstance(sp, dict) or isinstance(ep, dict) or isinstance(g(1), dict) or isinstance(g(3), dict):
                    STATS['ramp_keyed_points'] += 1
                S = [sp[0] * lw, sp[1] * lh]
                E = [ep[0] * lw, ep[1] * lh]
                radial = (g(5, 1) or 1) == 2
                c0 = [size[0] / 2, size[1] / 2]
                vx, vy = E[0] - S[0], E[1] - S[1]
                ln = math.hypot(vx, vy) or 1
                if radial:
                    cx, cy = S[0] - c0[0], S[1] - c0[1]
                    ang = 0
                else:
                    cx, cy = (S[0] + E[0]) / 2 - c0[0], (S[1] + E[1]) / 2 - c0[1]
                    ang = math.degrees(math.atan2(vx, -vy)) - 180
                blend = g(7, 0)
                out.append({'type': 'gradient_overlay', 'params': {
                    'color': g(2, '#000000', hexc), 'color2': g(4, '#ffffff', hexc), 'shape': 'radial' if radial else 'linear',
                    'angle': round(ang, 3), 'cx': round(cx, 2), 'cy': round(cy, 2), 'width': round(ln, 2),
                    'amount': map_val(blend, lambda v: 100 - v)}, 'ae': 'ramp', '_box_rel': True})
            elif mn == 'ADBE 4ColorGradient':
                # 4 色グラデーション → 4 色の直線グラデーション (左から右へ点の x の順) で代用
                lw, lh = size if size[0] else (self.cur_comp['width'], self.cur_comp['height'])
                pts = []
                for k in range(4):
                    pt = vecn(g(1 + 2 * k, [0.5, 0.5]), 2)
                    pts.append((pt[0] * lw, pt[1] * lh, g(2 + 2 * k, '#ffffff', hexc)))
                pts.sort(key=lambda q: q[0])
                c0 = [size[0] / 2, size[1] / 2]
                x0, x1 = pts[0][0], pts[-1][0]
                out.append({'type': 'gradient_overlay', 'params': {
                    'colors': [q[2] for q in pts], 'shape': 'linear', 'angle': -90,
                    'cx': round((x0 + x1) / 2 - c0[0], 2), 'cy': round(sum(q[1] for q in pts) / 4 - c0[1], 2),
                    'width': round(max(1, x1 - x0), 2), 'amount': map_val(g(10, 0), lambda v: 100 - v)}, 'ae': '4color', '_box_rel': True})
                self.missing_fx['4色グラデーション(4 色の直線で代用)'] += 1
            elif mn == 'ADBE Exposure2':
                ex = g(3, 0)
                out.append({'type': 'color', 'params': {'brightness': map_val(ex, lambda v: round((2 ** v - 1) * 100, 2))}, 'ae': 'exposure'})
            elif mn == 'ADBE Brightness & Contrast 2':
                out.append({'type': 'color', 'params': {'brightness': g(1, 0), 'contrast': g(2, 0)}, 'ae': 'brightness_contrast'})
            elif mn == 'CC Jaws':
                out.append({'type': 'wipe', 'params': {'progress': g(1, 0), 'angle': 90, 'feather': 0}, 'ae': 'cc_jaws'})
                self.missing_fx['CC Jaws(ギザギザのワイプ → 直線のワイプで代用)'] += 1
            else:
                self.missing_fx[(e.get('name') or '') + ' ' + mn] += 1
        return out

    def masks(self, L, fps, size):
        par = kids_of(L.get('props', []), 'ADBE Mask Parade')
        if not par:
            return []
        out = []
        for m in par.get('kids', []):
            if m.get('mn') != 'ADBE Mask Atom':
                continue
            sp = kid(m, 'ADBE Mask Shape')
            if not sp or not sp.get('shapes'):
                continue
            pts = sp['shapes'][0].get('pts') or []
            n = len(pts) // 3
            w, h = size
            P = []
            for v in range(n):
                vx, vy = pts[3 * v]
                ox, oy = pts[3 * v + 1]
                ix, iy = pts[3 * v - 1] if v > 0 else pts[-1]
                P.append([round(vx, 2), round(vy, 2), round(ix - vx, 2), round(iy - vy, 2), round(ox - vx, 2), round(oy - vy, 2)])
            mk = {'shape': 'path', 'points': P}
            fe = kid(m, 'ADBE Mask Feather')
            if fe and fe.get('v'):
                f = fe['v']
                mk['feather'] = f[0] if isinstance(f, list) else f
            if 'k' in sp:
                STATS['mask_keyed'] += 1
            out.append(mk)
            STATS['masks'] += 1
        return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('aep_json')
    ap.add_argument('--root', default='000')
    ap.add_argument('--out', required=True)
    ap.add_argument('--id-base', type=int, default=380000)
    ap.add_argument('--assets')
    a = ap.parse_args()
    D = json.load(open(a.aep_json, encoding='utf-8'))
    assets = json.load(open(a.assets)) if a.assets else {}
    cv = Conv(D['items'], a.id_base, assets=assets)
    root = [i for i in D['items'] if i['type'] == 'comp' and i['name'] == a.root]
    if not root:
        sys.exit('root comp not found')
    # cur_comp は形の割合の値に使う (コンポごとに入れ替える)
    orig = cv.convert_comp

    def wrapped(cid):
        prev = getattr(cv, 'cur_comp', None)
        cv.cur_comp = cv.by[cid]
        try:
            return orig(cid)
        finally:
            cv.cur_comp = prev
    cv.convert_comp = wrapped
    rid = cv.convert_comp(root[0]['id'])
    os.makedirs(a.out, exist_ok=True)
    def strip(o):
        if isinstance(o, dict):
            return {k: strip(v) for k, v in o.items() if not k.startswith('_') and k != 'parent_is_group'}
        if isinstance(o, list):
            return [strip(v) for v in o]
        return o
    for cid, doc in cv.docs.items():
        doc = strip(doc)
        with open(os.path.join(a.out, '%d.json' % doc['id']), 'w', encoding='utf-8') as fp:
            json.dump(doc, fp, ensure_ascii=False)
    rep = {'root': rid, 'comps': len(cv.docs), 'stats': dict(STATS), 'missing_fx': dict(cv.missing_fx.most_common()),
           'unresolved_expr': dict(UNRESOLVED.most_common(40)),
           'missing_fonts': dict(Conv.MISSING_FONTS.most_common()), 'footage_used': len(cv.footage_used)}
    with open(os.path.join(a.out, '_report.json'), 'w', encoding='utf-8') as fp:
        json.dump(rep, fp, ensure_ascii=False, indent=1)
    print(json.dumps(rep, ensure_ascii=False, indent=1)[:4000])


if __name__ == '__main__':
    main()
