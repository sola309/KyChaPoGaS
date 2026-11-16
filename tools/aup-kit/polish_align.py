#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""置き換えた絵の「顔の位置」を、元の絵で顔があった場所へ合わせる(project 37 の comp を API で直す)。

なぜ要るか: 取り込み器は置き換えた絵を「元の絵と同じ位置・同じ拡大率」で置く。置き換えた絵は元と同じ画素の大きさだが、
絵の中の顔の位置・大きさは違うので、帯・丸窓・カードの切り抜きに顔が入らない、画面の端で顔が切れる、が起きる(2026-11-16 v8 の欠点 D01〜D12)。

やり方: 表 `reference/aviutl_mad/sakura/rebuild/polish_align_37.json` に、絵(asset)ごとの
    o = 元の絵での顔の中心(幅・高さに対する割合。目で読んだ値。元の絵そのものは使わない = 数値だけ)
    n = 置き換えた絵での顔の中心(同じく割合)
    k = 置き換えた絵に掛ける拡大(1 = そのまま)
  を書く。レイヤーの `transform.anchor` を  an = (n − 0.5)·size − (o − 0.5)·size / k  にし、scale を k 倍する。
  こうすると、レイヤーの位置・グループ・カメラ・キーフレームがどう動いても、置き換えた絵の顔が、元の絵の顔があった所に来る。
  左右反転のエフェクト(flip h)があるレイヤーは x を逆にする。
  `layers`(["comp:layer", …])を書くとそのレイヤーだけ、`skip` を書くとそのレイヤーは除く。`an` を直接書けばそれを使う(px)。
  `pos`(px)を書くと position に足す(キーフレームにも)。

何度流しても同じ結果(レイヤーに `polish` の印と元の値を残し、流し直すときは元へ戻してから掛ける)。
取り込み直し(imp.sh)・作り直し(rec.sh)のあとは、このスクリプトを流し直す:
    python3 repo/tools/aup-kit/polish_align.py            # 適用
    python3 repo/tools/aup-kit/polish_align.py --revert   # 元へ戻す
    python3 repo/tools/aup-kit/polish_align.py --dry      # 変わるレイヤーの一覧だけ
"""
import argparse
import copy
import json
import os
import urllib.request

API = 'http://127.0.0.1:8002'
HERE = os.path.dirname(os.path.abspath(__file__))
TABLE = os.path.normpath(os.path.join(HERE, '../../../reference/aviutl_mad/sakura/rebuild/polish_align_37.json'))
PROJECT = 37


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def mul_scale(v, k):
    """scale の値(定数・全体のキー・要素ごとのキー)を k 倍する。"""
    if v is None:
        return [100.0 * k, 100.0 * k]
    if isinstance(v, (int, float)):
        return v * k
    if isinstance(v, dict):
        v = dict(v)
        if 'k' in v:
            v['k'] = [dict(q, v=mul_scale(q['v'], k)) for q in v['k']]
        elif 'v' in v:
            v['v'] = mul_scale(v['v'], k)
        return v
    if isinstance(v, list):
        return [mul_scale(x, k) if i < 2 else x for i, x in enumerate(v)]
    return v


def add_pos(v, d):
    if v is None:
        return v
    if isinstance(v, dict):
        v = dict(v)
        if 'k' in v:
            v['k'] = [dict(q, v=add_pos(q['v'], d)) for q in v['k']]
        elif 'v' in v:
            v['v'] = add_pos(v['v'], d)
        return v
    if isinstance(v, list) and len(v) >= 2 and all(isinstance(x, (int, float)) for x in v[:2]):
        return [v[0] + d[0], v[1] + d[1]] + list(v[2:])
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--revert', action='store_true')
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--bak', default=None, help='直す前の comp を書き出すフォルダ(無ければ書かない)')
    a = ap.parse_args()
    table = json.load(open(TABLE, encoding='utf-8'))
    rules = {int(k): v for k, v in table['assets'].items()}
    edits = table.get('layer_edits', {})          # "comp:layer" → {"set": {"a.b.c": 値}, "add_effects": [...]}(顔合わせ以外の小さな直し)
    comps = call('GET', f'/api/comps/?project_id={PROJECT}')
    n_l = n_c = 0
    for c0 in comps:
        c = call('GET', f"/api/comps/{c0['id']}")
        data = c['data']
        before = json.dumps(data, ensure_ascii=False, sort_keys=True)
        # 0) 重なり順の直し(表の "reorder": {"comp": [["動かす id", "この id のすぐ前(手前)へ"], …]})。まず前回の分を元の場所へ戻す
        Ls = data.get('layers', [])
        for L in [x for x in Ls if 'polish_after' in x]:
            aft = L.pop('polish_after')
            Ls.remove(L)
            i = next((j for j, y in enumerate(Ls) if y['id'] == aft), -1)
            Ls.insert(i + 1, L)
        if not a.revert:
            for mv, before_id in (table.get('reorder') or {}).get(str(c['id']), []):
                i = next((j for j, y in enumerate(Ls) if y['id'] == mv), None)
                if i is None or not any(y['id'] == before_id for y in Ls):
                    continue
                L = Ls.pop(i)
                L['polish_after'] = Ls[i - 1]['id'] if i > 0 else None
                Ls.insert(next(j for j, y in enumerate(Ls) if y['id'] == before_id), L)
        for L in data.get('layers', []):
            key = f"{c['id']}:{L['id']}"
            # 1) 元へ戻す
            p = L.pop('polish', None)
            if p:
                t = L.setdefault('transform', {})
                for name in ('anchor', 'scale', 'position'):
                    if name in p:
                        if p[name] is None:
                            t.pop(name, None)
                        else:
                            t[name] = p[name]
                for path, old in (p.get('set') or {}).items():
                    put(L, path, old)
                if p.get('fx_n'):
                    L['effects'] = (L.get('effects') or [])[p['fx_n']:]
            if a.revert:
                continue
            mark = {}
            # 2) 顔合わせ
            aid = (L.get('source') or {}).get('asset_id')
            r = rules.get(aid) if L.get('type') == 'image' else None
            if r and (not r.get('layers') or key in r['layers']) and key not in (r.get('skip') or []):
                rr = dict(r, **(r.get('per_layer') or {}).get(key, {}))
                w, h = rr['size']
                k = float(rr.get('k', 1))
                if 'an' in rr:
                    an = list(rr['an'])
                else:
                    o, n = rr['o'], rr['n']
                    an = [(n[0] - 0.5) * w - (o[0] - 0.5) * w / k, (n[1] - 0.5) * h - (o[1] - 0.5) * h / k]
                fl = [e for e in (L.get('effects') or []) if e.get('type') == 'flip' and e.get('enabled') is not False]
                if sum(1 for e in fl if (e.get('params') or {}).get('h')) % 2:
                    an[0] = -an[0]
                if sum(1 for e in fl if (e.get('params') or {}).get('v')) % 2:
                    an[1] = -an[1]
                t = L.setdefault('transform', {})
                mark['anchor'] = copy.deepcopy(t.get('anchor'))
                mark['scale'] = copy.deepcopy(t.get('scale'))
                t['anchor'] = [round(an[0], 1), round(an[1], 1), 0]
                if k != 1:
                    t['scale'] = mul_scale(t.get('scale'), k)
                if rr.get('pos'):
                    mark['position'] = copy.deepcopy(t.get('position'))
                    t['position'] = add_pos(t.get('position', [c['width'] / 2, c['height'] / 2, 0]), rr['pos'])
            # 3) 小さな直し
            e = edits.get(key)
            if e:
                mark['set'] = {}
                for path, val in (e.get('set') or {}).items():
                    mark['set'][path] = get(L, path)
                    put(L, path, val)
                if e.get('add_effects'):      # エフェクトの列の先頭に足す(戻すときは先頭から同じ数を外す)
                    L['effects'] = copy.deepcopy(e['add_effects']) + (L.get('effects') or [])
                    mark['fx_n'] = len(e['add_effects'])
            if mark:
                L['polish'] = mark
                n_l += 1
        after = json.dumps(data, ensure_ascii=False, sort_keys=True)
        if after != before:
            n_c += 1
            print(('(dry) ' if a.dry else '') + f"comp {c['id']} {c['name']}: " + ', '.join(L['id'] for L in data['layers'] if L.get('polish')))
            if not a.dry:
                if a.bak:
                    os.makedirs(a.bak, exist_ok=True)
                    bp = os.path.join(a.bak, f"comp_{c['id']}.json")
                    if not os.path.exists(bp):
                        json.dump(json.loads(before), open(bp, 'w', encoding='utf-8'), ensure_ascii=False)
                call('PATCH', f"/api/comps/{c['id']}", {'data': data})
    print(f'直した comp {n_c} 個・印のあるレイヤー {n_l} 個' + (' (dry)' if a.dry else ''))


_MISSING = '__none__'


def get(L, path):
    cur = L
    for p in path.split('.'):
        if isinstance(cur, list):
            p = int(p)
            cur = cur[p] if p < len(cur) else _MISSING
        else:
            cur = cur.get(p, _MISSING) if isinstance(cur, dict) else _MISSING
        if cur == _MISSING:
            return _MISSING
    return copy.deepcopy(cur)


def put(L, path, val):
    ps = path.split('.')
    cur = L
    for p in ps[:-1]:
        if isinstance(cur, list):
            cur = cur[int(p)]
        else:
            cur = cur.setdefault(p, {})
    last = ps[-1]
    if isinstance(cur, list):
        cur[int(last)] = val
    elif val == _MISSING:
        cur.pop(last, None)
    else:
        cur[last] = val


if __name__ == '__main__':
    main()
