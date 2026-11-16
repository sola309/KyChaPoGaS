#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解像度の粗さの直し(v14・POLISH6)を project 37 の comp に API で掛ける。

なぜ要るか: 2 巡目の素材(生成絵)は 832×1216 などで作って、元の素材と同じ画素数(2560×3584 など)へ引き伸ばして登録してある。
画素数は足りて見えるが中身は 2〜3 倍に伸ばした絵で、画面でさらに 1.2〜3 倍に拡大される所が粗く見えた。
取り込み器・作り直し comp は「元と同じ画素数の素材」を前提に位置・拡大率を決めているので、素材の画素数は変えられない。そこで:

  1. 絵の差し替え: 表 `reference/aviutl_mad/sakura/rebuild/polish6_hires.json` の "assets"({古い素材 id: {new, w0, h0, …}})に従い、
     image レイヤーの source.asset_id を高い解像度の素材へ替え、`source.fit = {width: w0, height: h0, mode: "stretch"}` を付ける
     (箱 = 元の画素数のまま。位置・anchor・マスク・切り抜きは 1px も動かない。中身だけ細かくなる)。もともと fit のあるレイヤーは id だけ替える。
  2. 描き出す倍率: 表の "raster"({"comp:layer": 倍率})に従い、レイヤーに `raster_scale` を書く
     (親で拡大して映す入れ子の comp・カメラの寄りで大きく映る文字や図形。comp-kit の scene.js が読む)。

何度流しても同じ結果。**imp.sh / rec.sh / polish_align.py のあとは、必ずこれを流し直す**(順番: rec → polish_align → polish6_hires)。
    python3 repo/tools/aup-kit/polish6_hires.py            # 適用
    python3 repo/tools/aup-kit/polish6_hires.py --revert   # 元へ戻す
    python3 repo/tools/aup-kit/polish6_hires.py --dry
高い解像度の素材そのものは POLISH6/batch_hires.py(realesr-animevideov3)が作る。元の素材は使っていない。
"""
import argparse
import json
import os
import urllib.request

API = 'http://127.0.0.1:8002'
HERE = os.path.dirname(os.path.abspath(__file__))
TABLE = os.path.normpath(os.path.join(HERE, '../../../reference/aviutl_mad/sakura/rebuild/polish6_hires.json'))
PROJECT = 37


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def load():
    t = json.load(open(TABLE, encoding='utf-8'))
    assets = t.get('assets', t)                     # 古い形(素材の表だけ)も読む
    assets = {int(k): v for k, v in assets.items() if str(k).isdigit()}
    return assets, t.get('raster', {}) if 'assets' in t else {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--revert', action='store_true')
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--only', default=None, help='comp id(カンマ区切り)')
    a = ap.parse_args()
    assets, raster = load()
    back = {v['new']: k for k, v in assets.items()}
    only = set(int(x) for x in a.only.split(',')) if a.only else None
    n_l = n_c = n_r = 0
    for c0 in call('GET', f'/api/comps/?project_id={PROJECT}'):
        if only and c0['id'] not in only:
            continue
        c = call('GET', f"/api/comps/{c0['id']}")
        data = c['data']
        before = json.dumps(data, ensure_ascii=False, sort_keys=True)
        for L in data.get('layers', []):
            key = f"{c['id']}:{L['id']}"
            s = L.get('source') or {}
            # 1) 元へ戻す(印 p6 = {from: 古い id, fit: 付けたか})
            m = L.pop('p6', None)
            if m:
                if 'from' in m and s.get('asset_id') == assets.get(m['from'], {}).get('new', s.get('asset_id')):
                    s['asset_id'] = m['from']
                elif 'from' in m and s.get('asset_id') in back:
                    s['asset_id'] = back[s['asset_id']]
                if m.get('fit'):
                    s.pop('fit', None)
                if 'rs' in m:
                    if m['rs'] is None:
                        L.pop('raster_scale', None)
                    else:
                        L['raster_scale'] = m['rs']
            elif s.get('asset_id') in back and L.get('type') == 'image':      # 印が消えた(polish_align が source を書き戻した等)とき
                s['asset_id'] = back[s['asset_id']]
            if a.revert:
                continue
            mark = {}
            r = assets.get(s.get('asset_id')) if L.get('type') == 'image' else None
            if r and not s.get('sequence') and not s.get('url'):
                mark['from'] = s['asset_id']
                s['asset_id'] = r['new']
                if s.get('fit') is None:
                    s['fit'] = {'width': r['w0'], 'height': r['h0'], 'mode': 'stretch'}
                    mark['fit'] = True
                n_l += 1
            if key in raster:
                mark['rs'] = L.get('raster_scale')
                L['raster_scale'] = raster[key]
                n_r += 1
            if mark:
                L['p6'] = mark
        after = json.dumps(data, ensure_ascii=False, sort_keys=True)
        if after != before:
            n_c += 1
            if not a.dry:
                call('PATCH', f"/api/comps/{c['id']}", {'data': data})
    print(f'変えた comp {n_c} 個・絵を替えたレイヤー {n_l} 個・raster_scale {n_r} 個' + (' (dry)' if a.dry else '') + (' (revert)' if a.revert else ''))


if __name__ == '__main__':
    main()
