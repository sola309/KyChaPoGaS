#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「さくら」再現 2 巡目(元の素材を 1 つも使わない)の共通部品。

- 新しいプロジェクト(PROJECT = 37)へ、手続きで描いた絵・アプリで生成した絵を登録する。
- 置き換え表: reference/aviutl_mad/sakura/rebuild/replace_<担当>.json
    { "<元素材の相対パス(asset_map.json の local)>": {asset_id, w, h, kind, how, status, note} }
    kind   = proc(PIL などの手続き) / gen(アプリの生成ジョブ) / gen+proc(生成 + 手続きの加工) / placeholder(仮の板)
    status = できた / 仮 / まだ
  取り込み器(aup_to_comp.py --rebuild)が全部の replace_*.json を合わせて読む。
- 元の素材(materials/・完成版の絵)は入力にしない。大きさ(w, h)だけ index から引く。
"""
import fcntl
import glob
import json
import os
import time
import urllib.request
import uuid

PROJECT = 37
API = 'http://127.0.0.1:8002'
SAKURA = '/home/kigarashi309/workspace/projects/KyChaPoGaS/reference/aviutl_mad/sakura'
REBUILD = os.path.join(SAKURA, 'rebuild')
WORK = '/tmp/claude-1000/sakura-rebuild'
FORBIDDEN = ('reference/aviutl_mad/sakura/materials', 'final_1.05', 'original_op', 'fetched_after_stop', '/data/uploads/36/', '/generated/36/')


def call(method, path, body=None, timeout=300):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r) if r.status != 204 else None


def upload(local_path, name=None, project_id=PROJECT):
    """手元の(自分で作った)ファイルをプロジェクトへ登録 → asset の dict(id, width, height, file_path …)。"""
    ap = os.path.abspath(local_path)
    assert not any(x in ap for x in FORBIDDEN), '元の素材は登録しない: ' + ap
    boundary = uuid.uuid4().hex
    name = name or os.path.basename(local_path)
    data = open(local_path, 'rb').read()
    body = b''.join([
        f'--{boundary}\r\nContent-Disposition: form-data; name="project_id"\r\n\r\n{project_id}\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode('utf-8'),
        data, f'\r\n--{boundary}--\r\n'.encode()])
    req = urllib.request.Request(API + '/api/assets/upload', data=body, headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)


def wait_job(jid, poll=2, timeout=1800):
    t = time.time()
    while time.time() - t < timeout:
        s = call('GET', f'/api/jobs/{jid}')
        if s['status'] in ('completed', 'failed', 'cancelled'):
            return s
        time.sleep(poll)
    raise TimeoutError(jid)


WAI_POS = '1girl, sakura kyoko, mahou shoujo madoka magica, aoki ume, masterpiece, best quality, solo, '
WAI_NEG = ('nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands, '
           '(((spoken, text, word, collage, comic))), greyscale, monochrome, multiple views')


def wai(tags, seed, w=832, h=1216, pos=WAI_POS, neg=WAI_NEG, neg_extra='', wait=True, project_id=PROJECT):
    """アプリの生成ジョブ(WAI = waiIllustriousSDXL、txt2img だけ。init_asset_id は使わない)→ (job, asset_id | None)。約 22 秒。"""
    j = call('POST', '/api/generation/image', {'project_id': project_id, 'prompt': pos + tags, 'negative_prompt': neg + (', ' + neg_extra if neg_extra else ''),
                                               'model': 'waiIllustrious', 'width': w, 'height': h, 'seed': seed, 'use_lightning': False})
    if not wait:
        return j, None
    s = wait_job(j['id'])
    return s, (s['result_asset_ids'][0] if s.get('result_asset_ids') else None)


def cutout(asset_id, model='isnet-anime', crop=True, wait=True):
    """アプリの切り抜きジョブ → (job, 透過 PNG の asset_id)。"""
    j = call('POST', f'/api/assets/{asset_id}/cutout', {'model': model, 'crop': crop})
    if not wait:
        return j, None
    s = wait_job(j['id'])
    return s, (s['result_asset_ids'][0] if s.get('result_asset_ids') else None)


def asset_path(asset_id):
    for a in call('GET', f'/api/assets/?project_id={PROJECT}'):
        if a['id'] == asset_id:
            return a['file_path']
    return None


def index():
    """元素材の一覧(番号, 36 での素材番号, w, h, 相対パス)。大きさと名前だけ(絵は入力にしない)。"""
    return json.load(open(os.path.join(WORK, 'look', 'index.json'), encoding='utf-8'))


def usage():
    """元素材ごとの使われ方(ルートのコマ数・最初と最後のコマ・シーン名)。"""
    return json.load(open(os.path.join(WORK, 'usage36.json'), encoding='utf-8'))


def put(agent, key, asset_id, w, h, kind, how, status='できた', note='', **extra):
    """置き換え表に 1 行書く(担当ごとのファイル。鍵つき)。key = 元素材の相対パス(index の 5 番目)。"""
    assert kind in ('proc', 'gen', 'gen+proc', 'placeholder'), kind
    assert status in ('できた', '仮', 'まだ'), status
    os.makedirs(REBUILD, exist_ok=True)
    p = os.path.join(REBUILD, f'replace_{agent}.json')
    with open(p + '.lock', 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        d = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
        d[key] = dict({'asset_id': asset_id, 'w': w, 'h': h, 'kind': kind, 'how': how, 'status': status, 'note': note}, **extra)
        json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


def replace_table():
    d = {}
    for p in sorted(glob.glob(os.path.join(REBUILD, 'replace_*.json'))):
        d.update(json.load(open(p, encoding='utf-8')))
    return d
