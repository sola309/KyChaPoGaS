#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""恋妹 2022 再現: 手元の comp 文書のフォルダ (aep_to_comp.py の出力 + 作り直した場面) を project 38 に登録・更新する。

    python koiimo_upload.py DIR --map comp_map.json [--project 38]

- 手元の id (380000 + AE の item id、作り直しは 3990xx) → DB の comp id の対応を comp_map.json に持ち、2 回目からは同じ comp を PATCH で更新する
  (消されていたら作り直す)。DB の書き込みは API だけ・project 38 だけ。
- 入れ子の参照 (layer.source.comp_id、mesh の texture.comp_id) は DB の id に書き換える。
"""
import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rebuild_lib as L  # noqa: E402

ALLOWED = {38}


def remap(o, m):
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k == 'comp_id' and isinstance(v, int) and v in m:
                out[k] = m[v]
            else:
                out[k] = remap(v, m)
        return out
    if isinstance(o, list):
        return [remap(v, m) for v in o]
    return o


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dir')
    ap.add_argument('--map', required=True)
    ap.add_argument('--project', type=int, default=38)
    a = ap.parse_args()
    assert a.project in ALLOWED, 'project 38 だけに書く'
    docs = {}
    for f in glob.glob(os.path.join(a.dir, '*.json')):
        if os.path.basename(f).startswith('_'):
            continue
        d = json.load(open(f, encoding='utf-8'))
        docs[int(d['id'])] = d
    cmap = {int(k): v for k, v in (json.load(open(a.map)).items() if os.path.exists(a.map) else [])}
    have = {c['id'] for c in L.call('GET', f'/api/comps/?project_id={a.project}')}
    for k in [k for k, v in cmap.items() if v not in have]:
        del cmap[k]
    for lid, d in sorted(docs.items()):
        if lid not in cmap:
            c = L.call('POST', '/api/comps/', {'project_id': a.project, 'name': d['name'], 'width': d['width'], 'height': d['height'],
                                               'fps': d['fps'], 'duration_frames': 1, 'data': {'version': 1, 'bg': None, 'layers': []}})
            cmap[lid] = c['id']
    json.dump({str(k): v for k, v in cmap.items()}, open(a.map, 'w'), indent=1)
    n = 0
    for lid, d in sorted(docs.items()):
        body = {'name': d['name'], 'width': d['width'], 'height': d['height'], 'fps': d['fps'],
                'duration_frames': max(1, int(d['duration_frames'])), 'data': remap(d['data'], cmap)}
        L.call('PATCH', f'/api/comps/{cmap[lid]}', body)
        n += 1
    print('comps', n, 'root', cmap.get(392669))


if __name__ == '__main__':
    main()
