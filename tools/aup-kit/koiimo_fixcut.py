#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""恋妹 2022 再現: 生成した絵の後処理。(1) 小さい顔の描き直し (2) 絵の端で途切れた髪・体の描き足し (3) 切り抜き → 元の大きさの画布。

(1) 顔 (11/18 ユーザー指示「生成キャラが小さいと顔が崩れやすい。予め把握して対応策を」):
- lbpcascade_animeface で顔を探し、生成した絵の中で幅 200px 未満の顔は、顔のまわり (顔の 2.2 倍の正方形) を 1024 に拡大して
  同じ決まり + 顔の言葉で描き直す (楕円の印・denoise 0.42)。縮めてぼかした印で貼り戻す。
- 何人も並ぶ絵は koiimo_gen の compose_multi で 1 人ずつ大きく描くので、ここでは 1 人ずつの絵として直る。

    python koiimo_fixcut.py --map WORK/assets_map.json --desc 'DIR/describe_*.json' --inv inv3.json --work WORK [--only 39,45]

決まり (11/18 ユーザー指示「中途半端な部分は見せないのが大前提」):
- 生成した元の絵 (白背景) を枠のまま切り抜き (crop しない) → 不透明な画素が絵の端に触れている辺 = 途切れ。
- 下の辺だけは、元の素材の置き場所が画面の下の端まで届いている (bbox の下 ≥ 1076) なら見えないので残してよい (バストアップの下など)。
- 途切れた辺を絵の 35% ぶん白で広げ、広げた所 (+ 重ね 32px) を印にして、同じプロンプトで描き足す (SDXL inpaint。ComfyUI に直接投げる。
  止める・中断・キューを消すことはしない)。2 回まで繰り返す。そのあと切り抜いて元の大きさの画布に入れ直す。
"""
import argparse
import glob
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import uuid

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rebuild_lib as L  # noqa: E402
import koiimo_gen as G  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'backend'))
from app.services.workflow_builder import build_sdxl_inpaint  # noqa: E402

COMFY = 'http://127.0.0.1:8188'
CKPT = 'waiIllustriousSDXL_v170.safetensors'
PROJECT = 38
CUT_KINDS = {'stand', 'chibi', 'object'}
FACE_KINDS = {'stand', 'chibi', 'bust', 'scene', 'sketch'}
CASCADE = os.path.join(REPO, 'outputs/pocky2026/wai/lbpcascade_animeface.xml')
FACE_MAX = 200      # これより小さい顔は描き直す (生成した絵の画素)
FACE_DENOISE = 0.42


def comfy_upload(img, name):
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    b = uuid.uuid4().hex
    body = (f'--{b}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\nContent-Type: image/png\r\n\r\n').encode() + \
        buf.getvalue() + f'\r\n--{b}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{b}--\r\n'.encode()
    req = urllib.request.Request(COMFY + '/upload/image', data=body, headers={'Content-Type': f'multipart/form-data; boundary={b}'})
    return json.load(urllib.request.urlopen(req, timeout=60))['name']


def comfy_run(wf, timeout=600):
    req = urllib.request.Request(COMFY + '/prompt', data=json.dumps({'prompt': wf, 'client_id': 'koiimo_fixcut'}).encode(),
                                 headers={'Content-Type': 'application/json'})
    pid = json.load(urllib.request.urlopen(req, timeout=60))['prompt_id']
    t = time.time()
    while time.time() - t < timeout:
        h = json.load(urllib.request.urlopen(f'{COMFY}/history/{pid}', timeout=30))
        if pid in h and h[pid].get('outputs'):
            for node in h[pid]['outputs'].values():
                for im in node.get('images', []):
                    q = urllib.parse.urlencode({'filename': im['filename'], 'subfolder': im.get('subfolder', ''), 'type': im.get('type', 'output')})
                    return Image.open(io.BytesIO(urllib.request.urlopen(f'{COMFY}/view?{q}', timeout=60).read())).convert('RGB')
        time.sleep(2)
    raise TimeoutError(pid)


def cut_sides(alpha, thr=0.004):
    """不透明な画素が端に触れている辺 (割合 thr 以上)"""
    w, h = alpha.size
    px = alpha.load()
    sides = []
    for name, pts in (('top', [(x, 0) for x in range(w)]), ('bottom', [(x, h - 1) for x in range(w)]),
                      ('left', [(0, y) for y in range(h)]), ('right', [(w - 1, y) for y in range(h)])):
        n = sum(1 for p in pts if px[p] > 128)
        if n / len(pts) > thr:
            sides.append(name)
    return sides


def full_alpha(aid):
    _, cut = L.cutout(aid, crop=False)
    return Image.open(G.asset_file(cut)).convert('RGBA'), cut


def outpaint(img, sides, prompt, neg, seed, frac=0.35):
    w, h = img.size
    dl = int(w * frac) if 'left' in sides else 0
    dr = int(w * frac) if 'right' in sides else 0
    dt = int(h * frac) if 'top' in sides else 0
    db = int(h * frac) if 'bottom' in sides else 0
    W, H = w + dl + dr, h + dt + db
    # SDXL の画素数に収める (長い辺 1536 まで)
    s = min(1.0, 1536 / max(W, H))
    W8, H8 = int(W * s) // 8 * 8, int(H * s) // 8 * 8
    canvas = Image.new('RGB', (W, H), (255, 255, 255))
    canvas.paste(img, (dl, dt))
    mask = Image.new('RGB', (W, H), (255, 255, 255))
    ov = 32
    mask.paste((0, 0, 0), (dl + (ov if dl else 0), dt + (ov if dt else 0), dl + w - (ov if dr else 0), dt + h - (ov if db else 0)))
    canvas, mask = canvas.resize((W8, H8), Image.LANCZOS), mask.resize((W8, H8), Image.NEAREST)
    iname = comfy_upload(canvas, f'koiimo_fix_{seed}.png')
    mname = comfy_upload(mask, f'koiimo_fixm_{seed}.png')
    wf = build_sdxl_inpaint(CKPT, iname, mname, prompt, neg, seed=seed, steps=28, cfg=6.0, denoise=1.0, grow_mask=8)
    return comfy_run(wf)


def find_faces(img):
    import cv2
    import numpy as np
    cas = cv2.CascadeClassifier(CASCADE)
    g = cv2.equalizeHist(cv2.cvtColor(np.asarray(img.convert('RGB')), cv2.COLOR_RGB2GRAY))
    fs = cas.detectMultiScale(g, scaleFactor=1.05, minNeighbors=4, minSize=(18, 18))
    return [tuple(int(v) for v in f) for f in fs]


def fix_faces(img, prompt, neg, seed):
    """小さい顔を拡大して描き直し、貼り戻す → (絵, 直した数)"""
    from PIL import ImageDraw, ImageFilter
    img = img.convert('RGB')
    n = 0
    for i, (x, y, w, h) in enumerate(sorted(find_faces(img), key=lambda f: -f[2])):
        if w >= FACE_MAX:
            continue
        cx, cy, side = x + w / 2, y + h / 2, int(max(w, h) * 2.2)
        x0, y0 = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
        x1, y1 = int(min(img.width, x0 + side)), int(min(img.height, y0 + side))
        crop = img.crop((x0, y0, x1, y1))
        S = 1024
        big = crop.resize((S, int(S * crop.height / crop.width) // 8 * 8), Image.LANCZOS)
        sx, sy = big.width / crop.width, big.height / crop.height
        mask = Image.new('RGB', big.size, (0, 0, 0))
        ImageDraw.Draw(mask).ellipse(((x - x0 - w * 0.25) * sx, (y - y0 - h * 0.35) * sy, (x - x0 + w * 1.25) * sx, (y - y0 + h * 1.25) * sy),
                                     fill=(255, 255, 255))
        iname = comfy_upload(big, f'koiimo_face_{seed}_{i}.png')
        mname = comfy_upload(mask, f'koiimo_facem_{seed}_{i}.png')
        wf = build_sdxl_inpaint(CKPT, iname, mname, prompt + ', face focus, detailed face, beautiful detailed eyes, clean lineart',
                                neg, seed=seed + i, steps=26, cfg=6.0, denoise=FACE_DENOISE, grow_mask=16)
        out = comfy_run(wf).resize(crop.size, Image.LANCZOS)
        soft = mask.convert('L').resize(crop.size, Image.LANCZOS).filter(ImageFilter.GaussianBlur(max(2, w * 0.06)))
        img.paste(out, (x0, y0), soft)
        n += 1
    return img, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--map', required=True)
    ap.add_argument('--desc', nargs='+', required=True)
    ap.add_argument('--inv', required=True)
    ap.add_argument('--work', required=True)
    ap.add_argument('--only', default='')
    ap.add_argument('--dry', action='store_true', help='途切れの判定だけ')
    a = ap.parse_args()
    amap = json.load(open(a.map))
    rows = {}
    for pat in a.desc:
        for f in glob.glob(pat):
            for r in json.load(open(f, encoding='utf-8')):
                rows[int(r['fid'])] = r
    inv = {int(r['fid']): r for r in json.load(open(a.inv))}
    only = {int(x) for x in a.only.split(',') if x}
    os.makedirs(os.path.join(a.work, 'fix'), exist_ok=True)
    report = []
    for key, v in list(amap.items()):
        fid = int(key)
        if only and fid not in only:
            continue
        if v.get('kind') not in (CUT_KINDS | FACE_KINDS) or not v.get('gen_asset') or fid not in rows or v.get('post_done'):
            continue
        r = rows[fid]
        src = Image.open(G.asset_file(v['gen_asset'])).convert('RGB')
        faces = [f for f in find_faces(src) if f[2] < FACE_MAX] if v['kind'] in FACE_KINDS else []
        body0, kneg0 = G.kyoko_tags(r['tags'], v['kind'], bool(r.get('multi')))
        if faces and not a.dry:
            pos0 = ('1girl, solo, ' if not r.get('multi') else '') + 'masterpiece, best quality, mahou shoujo madoka magica, aoki ume, ' + body0
            src, nf = fix_faces(src, pos0, ', '.join((L.WAI_NEG, kneg0)), v.get('seed', 1) + 500)
            fp = os.path.join(a.work, 'fix', f'{fid}_face.png')
            src.save(fp)
            v['gen_asset'] = L.upload(fp, name=f'koiimo_{fid}_facefix.png', project_id=PROJECT)['id']
            v['faces_fixed'] = nf
            print(f'  顔を描き直した {nf}', flush=True)
        if v['kind'] not in CUT_KINDS:
            if not a.dry and faces:
                out = G.fit_canvas(src, v.get('w'), v.get('h'), v['kind'])
                op = os.path.join(a.work, 'gen', f'{fid}.png')
                out.save(op)
                v['asset_id'] = L.upload(op, name=f'koiimo_{fid}_{v["kind"]}_post.png', project_id=PROJECT)['id']
            v['post_done'] = True
            report.append({'fid': fid, 'kind': v['kind'], 'faces': len(faces)})
            json.dump(amap, open(a.map + '.tmp', 'w'), ensure_ascii=False, indent=1)
            os.replace(a.map + '.tmp', a.map)
            continue
        alpha, _ = full_alpha(v['gen_asset'])
        sides = cut_sides(alpha.split()[3])
        bb = inv.get(fid, {}).get('bbox')
        if 'bottom' in sides and bb and bb[3] >= 1076:
            sides.remove('bottom')   # 画面の下の端まで届く置き方 = 下の切れ目は見えない
        report.append({'fid': fid, 'kind': v['kind'], 'sides': sides, 'faces': len(faces)})
        print(fid, v['kind'], 'cut', sides, 'small faces', len(faces), flush=True)
        if a.dry:
            continue
        if not sides:
            if faces:   # 顔だけ直した: 切り抜き直す
                _, cropped = L.cutout(v['gen_asset'], crop=True)
                out = G.fit_canvas(Image.open(G.asset_file(cropped)), v.get('w'), v.get('h'), v['kind'])
                op = os.path.join(a.work, 'gen', f'{fid}.png')
                out.save(op)
                v['asset_id'] = L.upload(op, name=f'koiimo_{fid}_{v["kind"]}_post.png', project_id=PROJECT)['id']
            v['post_done'] = True
            json.dump(amap, open(a.map + '.tmp', 'w'), ensure_ascii=False, indent=1)
            os.replace(a.map + '.tmp', a.map)
            continue
        body, kneg = G.kyoko_tags(r['tags'], 'stand' if v['kind'] != 'object' else 'object', False)
        pos = ('1girl, solo, ' if v['kind'] != 'object' else '') + 'masterpiece, best quality, mahou shoujo madoka magica, aoki ume, ' + \
            body + ', full body, entire hair visible, simple background, white background'
        neg = ', '.join(x for x in (L.WAI_NEG, kneg, 'cropped, out of frame, cut off, background objects') if x)
        img = src
        for t in range(2):
            img = outpaint(img, sides, pos, neg, v.get('seed', 1) + 100 + t)
            buf = os.path.join(a.work, 'fix', f'{fid}_op{t}.png')
            img.save(buf)
            up = L.upload(buf, name=f'koiimo_{fid}_outpaint{t}.png', project_id=PROJECT)
            alpha, cut_id = full_alpha(up['id'])
            sides = [s for s in cut_sides(alpha.split()[3]) if not (s == 'bottom' and bb and bb[3] >= 1076)]
            if not sides:
                break
        _, cropped = L.cutout(up['id'], crop=True)
        it_w, it_h = v.get('w'), v.get('h')
        out = G.fit_canvas(Image.open(G.asset_file(cropped)), it_w, it_h, v['kind'])
        op = os.path.join(a.work, 'gen', f'{fid}.png')
        out.save(op)
        up2 = L.upload(op, name=f'koiimo_{fid}_{v["kind"]}_fixcut.png', project_id=PROJECT)
        v.update(asset_id=up2['id'], outpainted=True, outpaint_src=up['id'], cut_left=sides, post_done=True)
        json.dump(amap, open(a.map + '.tmp', 'w'), ensure_ascii=False, indent=1)
        os.replace(a.map + '.tmp', a.map)
        print('  → 描き足し', up2['id'], '残った途切れ', sides, flush=True)
    json.dump(report, open(os.path.join(a.work, 'fixcut_report.json'), 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
