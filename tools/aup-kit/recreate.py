#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""手元に無い連番(Blender などで作っていた素材)を、KyChaPoGaS のコンポジションの機能で作り直す。

    python3 recreate.py --project-id 36                 # 全部作る(同じキーは同じ comp を書き換える)
    python3 recreate.py --project-id 36 --only B13,B28  # 台帳の ID でしぼる
    python3 recreate.py --list

- 1 個の連番(フォルダ)= 1 個のコンポジション。comp の n コマ目 = 連番の n+1 番(fps は連番と同じ 60)。背景は透明。
- 対応は sakura/recreate_map.json({project_id: {連番フォルダの相対パス: {comp_id, id, how}}})。
  aup_to_comp.py が、素材の無い連番をこの comp の入れ子に置き換える(video_source の recreate)。
- 完成動画の絵は素材にしない(見て真似るだけ)。使うのは particles / pattern / shape / text / mesh / camera と、手元にある元素材だけ。
- 人物の 3D モデルなど「元絵が要る」物は、同じ位置・大きさ・動きの仮の板(影絵)にしてある(PLACEHOLDER)。
"""
import argparse
import json
import math
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aup_materials as AM   # noqa: E402
import urllib.request   # noqa: E402
from recreate_lib import BUILDERS, SAKURA   # noqa: E402
import importlib   # noqa: E402
for _m in ('recreate_g1', 'recreate_g2', 'recreate_g3', 'recreate_g4'):     # 作り直しの本体(シーンの組ごと)
    try:
        importlib.import_module(_m)
    except ModuleNotFoundError as _e:
        if _e.name != _m:
            raise


# ---------------------------------------------------------------- 登録

class Api:
    def __init__(self, base):
        self.base = base

    def call(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r) if r.status != 204 else None


class Ctx:
    """作り直しの関数に渡す物: 手元の元素材の素材番号(asset_map)など。"""
    def __init__(self, project_id):
        self.project_id = project_id
        self.amap = json.load(open(os.path.join(SAKURA, 'asset_map.json'), encoding='utf-8'))
        self.rmap = {}

    def asset(self, part):
        """元素材(PC のパスの一部で引く)→ asset_map の項目。無ければ None。"""
        for k, v in self.amap.items():
            if part in k and v.get('project_id') == self.project_id:
                return v
        return None

    def comp(self, key):
        e = self.rmap.get(key)
        return e and e.get('comp_id')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project-id', type=int, default=36)
    ap.add_argument('--api', default='http://127.0.0.1:8002')
    ap.add_argument('--only', default=None, help='台帳の ID(B13,B28 …)')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--dump', default=None, help='API を使わず文書をこのフォルダへ書く')
    a = ap.parse_args()
    if a.list:
        for k, b in sorted(BUILDERS.items(), key=lambda kv: kv[1]['id']):
            print(b['id'], '仮の板' if b['placeholder'] else '      ', k, '←', b['how'])
        return
    mp = os.path.join(SAKURA, 'recreate_map.json')
    allmap = json.load(open(mp, encoding='utf-8')) if os.path.exists(mp) else {}
    rmap = allmap.setdefault(str(a.project_id), {})
    api = Api(a.api)
    ctx = Ctx(a.project_id)
    ctx.rmap = rmap
    only = set(a.only.split(',')) if a.only else None
    have = {c['id'] for c in api.call('GET', f'/api/comps/?project_id={a.project_id}')} if not a.dump else set()
    for key, b in sorted(BUILDERS.items(), key=lambda kv: kv[1]['id']):
        if only and b['id'] not in only:
            continue
        d = b['fn'](ctx)
        if a.dump:
            os.makedirs(a.dump, exist_ok=True)
            json.dump(d, open(os.path.join(a.dump, b['id'] + '_' + key.replace('/', '_') + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            continue
        e = rmap.get(key)
        body = {'name': d['name'], 'width': d['width'], 'height': d['height'], 'fps': d['fps'], 'duration_frames': d['duration_frames'], 'data': d['data']}
        if e and e.get('comp_id') in have:
            api.call('PATCH', f"/api/comps/{e['comp_id']}", body)
            cid = e['comp_id']
        else:
            cid = api.call('POST', '/api/comps/', dict(body, project_id=a.project_id))['id']
        rmap[key] = {'comp_id': cid, 'id': b['id'], 'how': b['how'], 'placeholder': b['placeholder']}
        json.dump(allmap, open(mp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(b['id'], '→ comp', cid, d['name'], f"({len(d['data']['layers'])} レイヤー)")


if __name__ == '__main__':
    main()
