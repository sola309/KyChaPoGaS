#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""パペットの重ねた絵から、姿勢(OpenPose の 18 点)を推定する。

  pose_sdpose.py <puppet_dir> <out.json> [--comfy http://127.0.0.1:8188]

この機械に既にある ComfyUI の標準ノード(SDPoseKeypointExtractor)と models/checkpoints/sdpose_wholebody_fp16.safetensors を、
ComfyUI の API(/upload/image・/prompt・/history)から使う。新しいモデル・カスタムノードは要らない。ComfyUI のキューに 1 件積むだけ(止めない・消さない)。
出力: {"points": {"shoulder_l": [x, y, 信頼度], …}, "canvas": [w, h]}。_l = 本人の左 = 画面の右(OpenPose の L)。make_bones.py --pose に渡す。
"""
import argparse
import io
import json
import os
import time
import urllib.request
import uuid

from PIL import Image

OP18 = ['nose', 'neck', 'shoulder_r', 'elbow_r', 'wrist_r', 'shoulder_l', 'elbow_l', 'wrist_l', 'hip_r', 'knee_r', 'ankle_r', 'hip_l', 'knee_l', 'ankle_l', 'eye_r', 'eye_l', 'ear_r', 'ear_l']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('puppet_dir')
    ap.add_argument('out')
    ap.add_argument('--comfy', default='http://127.0.0.1:8188')
    ap.add_argument('--ckpt', default='sdpose_wholebody_fp16.safetensors')
    a = ap.parse_args()
    pdir = a.puppet_dir.rstrip('/')
    man = json.load(open(os.path.join(pdir, 'manifest.json'), encoding='utf-8'))
    cw, ch = man['canvas']
    im = Image.new('RGBA', (cw, ch), (236, 236, 236, 255))
    for l in sorted(man['layers'], key=lambda x: x['z']):
        im.alpha_composite(Image.open(os.path.join(pdir, l['file'])).convert('RGBA'))
    buf = io.BytesIO()
    im.convert('RGB').save(buf, 'PNG')
    name = f"posekit_{man.get('id', 'puppet')}.png"
    b = uuid.uuid4().hex
    body = b''.join([
        f'--{b}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\nContent-Type: image/png\r\n\r\n'.encode(), buf.getvalue(),
        f'\r\n--{b}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{b}--\r\n'.encode()])
    r = json.load(urllib.request.urlopen(urllib.request.Request(a.comfy + '/upload/image', data=body, headers={'Content-Type': f'multipart/form-data; boundary={b}'}), timeout=60))
    img = (r.get('subfolder') + '/' if r.get('subfolder') else '') + r['name']
    wf = {'1': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': a.ckpt}},
          '2': {'class_type': 'LoadImage', 'inputs': {'image': img}},
          '3': {'class_type': 'SDPoseKeypointExtractor', 'inputs': {'model': ['1', 0], 'vae': ['1', 2], 'image': ['2', 0], 'batch_size': 1}},
          '4': {'class_type': 'PreviewAny', 'inputs': {'source': ['3', 0]}}}
    r = json.load(urllib.request.urlopen(urllib.request.Request(a.comfy + '/prompt', data=json.dumps({'prompt': wf}).encode(), headers={'Content-Type': 'application/json'}), timeout=60))
    pid = r['prompt_id']
    t0 = time.time()
    while True:
        h = json.load(urllib.request.urlopen(f'{a.comfy}/history/{pid}', timeout=30))
        if pid in h:
            break
        if time.time() - t0 > 1800:
            raise TimeoutError('ComfyUI の順番待ちが 30 分を超えた')
        time.sleep(2)
    h = h[pid]
    if h.get('status', {}).get('status_str') != 'success':
        raise RuntimeError('SDPose 失敗: ' + json.dumps(h.get('status'), ensure_ascii=False)[:800])
    txt = h['outputs']['4']['text'][0]
    kp = json.loads(txt)
    fr = kp[0] if isinstance(kp, list) else kp
    W, H = fr.get('canvas_width', cw), fr.get('canvas_height', ch)
    people = fr.get('people') or []
    if not people:
        raise RuntimeError('人物が見つからなかった')
    v = people[0]['pose_keypoints_2d']
    pts = [(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]) for i in range(len(v) // 3)]
    norm = max(max(p[0], p[1]) for p in pts) <= 2.0
    out = {}
    for n, (x, y, c) in zip(OP18, pts):
        if norm:
            x, y = x * W, y * H
        out[n] = [round(x * cw / W, 1) if not norm else round(x * cw / W, 1), round(y * ch / H, 1), round(float(c), 3)]
    json.dump({'points': out, 'canvas': [cw, ch], 'model': a.ckpt, 'secs': round(time.time() - t0, 1)}, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'{len(out)} 点 / {time.time() - t0:.1f} 秒 → {a.out}')


if __name__ == '__main__':
    main()
