#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""feel-kit / コンポジションの一部の区間だけを描き出して動きを測る(全編を描かずに直しを確かめる)。

  python render_window.py --comp 225 --range 2040 2150 --out win.mp4 [--project 35] [--npz win.npz] [--keep]

やること: 試験用のプロジェクト(既定 35)に「comp を start = 区間の頭 で 1 枚置いただけの comp」を API で作り、/render のジョブを待ち、
できた動画を --out に写し、(--npz があれば)motion_feat.py で測る。作った試験 comp は消す(--keep で残す)。DB には直接書かない。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

API = os.environ.get('FEEL_API', 'http://127.0.0.1:8002')


def call(method, path, body=None, timeout=300):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r) if r.status != 204 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--comp', type=int, required=True)
    ap.add_argument('--range', type=int, nargs=2, required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--project', type=int, default=35)
    ap.add_argument('--npz')
    ap.add_argument('--keep', action='store_true')
    ap.add_argument('--timeout', type=int, default=1500)
    a = ap.parse_args()
    src = call('GET', f'/api/comps/{a.comp}')
    f0, f1 = a.range
    n = f1 - f0
    W, H = src['width'], src['height']
    doc = {'project_id': a.project, 'name': f'試験: FEEL 区間 comp{a.comp} {f0}-{f1}', 'fps': src['fps'], 'duration_frames': n, 'width': W, 'height': H,
           'data': {'version': 1, 'bg': '#000000', 'layers': [{'id': 'w', 'type': 'comp', 'in': 0, 'out': n, 'start': f0, 'speed': 1.0, 'source': {'comp_id': a.comp},
                                                              'transform': {'position': [W / 2, H / 2, 0]}}]}}
    c = call('POST', '/api/comps/', doc)
    cid = c['id']
    try:
        j = call('POST', f'/api/comps/{cid}/render')
        t = time.time()
        while True:
            s = call('GET', f"/api/jobs/{j['job_id']}")
            if s['status'] in ('completed', 'failed', 'cancelled'):
                break
            if time.time() - t > a.timeout:
                raise TimeoutError('描き出しが時間切れ')
            time.sleep(2)
        if s['status'] != 'completed':
            raise RuntimeError('描き出し失敗: ' + str(s.get('error') or s.get('status')))
        aid = s['result_asset_ids'][0]
        assets = call('GET', f'/api/assets/?project_id={a.project}')
        path = next(x['file_path'] for x in assets if x['id'] == aid)
        shutil.copy(path, a.out)
        print('rendered', a.out, 'asset', aid, 'sec', round(time.time() - t, 1))
        if not a.keep:
            try:
                call('DELETE', f'/api/assets/{aid}')
            except Exception as e:      # noqa: BLE001
                print('asset の削除はできなかった(残る)', aid, e)
    finally:
        if not a.keep:
            try:
                call('DELETE', f'/api/comps/{cid}')
            except Exception as e:      # noqa: BLE001
                print('試験 comp の削除はできなかった', cid, e)
    if a.npz:
        here = os.path.dirname(os.path.abspath(__file__))
        subprocess.run([sys.executable, os.path.join(here, 'motion_feat.py'), a.out, '--out', a.npz], check=True)


if __name__ == '__main__':
    main()
