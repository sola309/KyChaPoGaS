#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""取り込んだコンポジションを描いて、完成動画の同じコマと並べる。

    PY=repo/backend/.venv/bin/python
    $PY compare.py --scene 36 --frames 4700,4760,4820            # comp_map.json からシーン → comp を引く
    $PY compare.py --comp 12 --frames 100-400:60 --name scene01  # comp id を直接。範囲は a-b:刻み
    $PY compare.py --scene 14 --frames 1250 --no-final --bg '#ffffff'   # 完成動画と比べない(描くだけ)

出力: reference/aviutl_mad/sakura/compare/sceneNN/fNNNNN.png(左 = 完成動画、中 = エンジン、右 = 差の絵)
       と metrics.json(コマごとの mean abs diff 0〜255・SSIM)。--tag を付けると metrics に履歴として残る。
描くのは 1920×1080、比べるのは 960×540 に縮めてから。
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image, ImageDraw

SAKURA = '/home/kigarashi309/workspace/projects/KyChaPoGaS/reference/aviutl_mad/sakura'
FINAL = os.path.join(SAKURA, 'final_1.05.mp4')
CHROME_ARGS = ["--force-color-profile=srgb", "--use-gl=angle", "--use-angle=swiftshader",
               "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
CW, CH = 960, 540


def parse_frames(s):
    out = []
    for part in s.split(','):
        part = part.strip()
        if not part:
            continue
        if '-' in part:
            rng, _, step = part.partition(':')
            a, b = rng.split('-')
            out += list(range(int(a), int(b) + 1, int(step or 1)))
        else:
            out.append(int(part))
    return out


def final_frame(f, fps=60.0):
    # f = 完成動画の何枚目か(0 始まり)。この mp4 の映像は start_time = 1/60 秒(1 コマ遅れて始まる)なので、f 枚目の時刻は (f+1)/fps。
    # -ss は「その時刻以降の最初のコマ」を返すので、半コマ手前の (f+0.5)/fps を指す。
    # (前は f/fps を渡していて f-1 枚目が返っていた → 「エンジンの f コマ目 = 完成動画の f+1」に見えていた。枚数で数えればずれは 0)
    d = os.path.join(SAKURA, 'compare', '_final_idx')
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, f'{f:05d}.png')
    if not os.path.exists(p):
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-ss', f'{(f + 0.5) / fps:.6f}', '-i', FINAL, '-frames:v', '1',
                        '-vf', f'scale={CW}:{CH}:flags=area', p], check=True)
    return Image.open(p).convert('RGB')


def ssim(a, b):
    """輝度の SSIM(8×8 の箱平均)。a, b は 0〜255 の float 配列。"""
    def box(x):
        h, w = x.shape
        return x[:h // 8 * 8, :w // 8 * 8].reshape(h // 8, 8, w // 8, 8).mean(axis=(1, 3))
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    ma, mb = box(a), box(b)
    va, vb = box(a * a) - ma * ma, box(b * b) - mb * mb
    cov = box(a * b) - ma * mb
    s = ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))
    return float(s.mean())


async def render(comp_id, frames, api, fps, log):
    from playwright.async_api import async_playwright
    out = {}
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=CHROME_ARGS)
        page = await browser.new_page(viewport={'width': 1920, 'height': 1080})
        msgs = {}
        page.on('console', lambda m: msgs.__setitem__(m.text[:300], msgs.get(m.text[:300], 0) + 1)
                if m.type in ('warning', 'error') else None)
        page.on('pageerror', lambda e: msgs.__setitem__('pageerror: ' + str(e)[:300], 1))
        await page.goto(f'{api}/api/comps/{comp_id}/player.html?mode=capture', wait_until='load')
        await page.evaluate('window.__madAssetsReady')
        for f in frames:
            t0 = time.time()
            try:
                url = await asyncio.wait_for(page.evaluate(
                    '''async (ms) => { await window.seek(ms); return document.querySelector('canvas').toDataURL('image/png') }''',
                    (f + 0.01) * 1000.0 / fps), timeout=600)
                out[f] = Image.open(io.BytesIO(base64.b64decode(url.split(',', 1)[1]))).convert('RGBA')
            except Exception as e:
                msgs[f'frame {f}: {type(e).__name__} {str(e)[:200]}'] = 1
            log.append((f, round(time.time() - t0, 2)))
        await browser.close()
    return out, msgs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scene', type=int)
    ap.add_argument('--comp', type=int)
    ap.add_argument('--project-id', type=int, default=36)
    ap.add_argument('--frames', required=True)
    ap.add_argument('--api', default='http://127.0.0.1:8002')
    ap.add_argument('--name', default=None)
    ap.add_argument('--bg', default=None, help='アルファつきの絵の下に敷く色(既定は市松)。"final" = 完成動画の上に重ねる')
    ap.add_argument('--no-final', action='store_true')
    ap.add_argument('--tag', default=None, help='metrics.json の履歴に付ける名前')
    ap.add_argument('--ref', action='store_true', help='参照レンダラ(ref_render.py)の絵も並べ、エンジンとの差も出す')
    ap.add_argument('--offset', default='0', help='完成動画のコマ = コンポジションのコマ + offset。auto = -1〜2 のうち差が最小のもの\n'
                    '(ルートに置いた書き出し AVI が 1 コマ遅れて映るシーンがある)')
    a = ap.parse_args()
    comp_id = a.comp
    if comp_id is None:
        cm = json.load(open(os.path.join(SAKURA, 'comp_map.json'), encoding='utf-8'))
        comp_id = cm[str(a.project_id)][str(a.scene)]
    name = a.name or (f'scene{a.scene:02d}' if a.scene is not None else f'comp{comp_id}')
    outdir = os.path.join(SAKURA, 'compare', name)
    os.makedirs(outdir, exist_ok=True)
    frames = parse_frames(a.frames)
    info = json.load(__import__('urllib.request').request.urlopen(f'{a.api}/api/comps/{comp_id}'))
    fps = info['fps']
    log = []
    imgs, msgs = asyncio.run(render(comp_id, frames, a.api, fps, log))
    if a.offset == 'auto' and not a.no_final and imgs:
        def mad_at(off):
            tot = 0.0
            for f, im in imgs.items():
                e = np.asarray(Image.alpha_composite(Image.new('RGBA', (CW, CH), '#808080'), im.resize((CW, CH), Image.BILINEAR)).convert('RGB')).astype(np.float32)
                tot += float(np.abs(np.asarray(final_frame(max(0, f + off))).astype(np.float32) - e).mean())
            return tot / len(imgs)
        cand = {o: round(mad_at(o), 3) for o in (-1, 0, 1, 2)}
        a.offset = min(cand, key=cand.get)
        print('offset auto:', cand, '→', a.offset)
    else:
        a.offset = int(a.offset) if a.offset != 'auto' else 0
    res = {}
    R = None
    if a.ref:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import ref_render
        R = ref_render.Ref(project_id=a.project_id)
    for f, im in imgs.items():
        ff = f + a.offset
        fin = None if a.no_final else final_frame(ff)
        im = im.resize((CW, CH), Image.LANCZOS)
        if a.bg == 'final' and fin is not None:
            base = fin.copy().convert('RGBA')
        elif a.bg:
            base = Image.new('RGBA', (CW, CH), a.bg)
        else:
            yy, xx = np.mgrid[0:CH, 0:CW]
            chk = (((xx // 16) + (yy // 16)) % 2 * 40 + 150).astype(np.uint8)
            base = Image.fromarray(np.dstack([chk, chk, chk, np.full_like(chk, 255)]), 'RGBA')
        alpha_cov = float(np.asarray(im)[..., 3].mean() / 255)
        eng = Image.alpha_composite(base, im).convert('RGB')
        refim = None
        if R is not None:
            try:
                pm = R.render(comp_id, f)
                ra = Image.fromarray((np.clip(ref_render.ungroup(pm), 0, 1) * 255).astype(np.uint8), 'RGBA').resize((CW, CH))
                refim = Image.alpha_composite(base, ra).convert('RGB')
            except Exception as e:
                print('ref failed', f, repr(e)[:200])
        sheet = Image.new('RGB', (CW * ((1 if fin is None else 3) + (1 if refim is not None else 0)), CH + 28), (20, 20, 20))
        d = ImageDraw.Draw(sheet)
        x = 0
        m = {'alpha_coverage': round(alpha_cov, 4)}
        if fin is not None:
            sheet.paste(fin, (0, 28))
            d.text((6, 8), f'final_1.05.mp4  f{ff}', fill=(255, 255, 120))
            x = CW
            A, B = np.asarray(fin).astype(np.float32), np.asarray(eng).astype(np.float32)
            diff = np.abs(A - B)
            m['mad'] = round(float(diff.mean()), 3)
            ya, yb = A @ np.array([0.299, 0.587, 0.114], np.float32), B @ np.array([0.299, 0.587, 0.114], np.float32)
            m['ssim'] = round(ssim(ya, yb), 4)
            sheet.paste(Image.fromarray(np.clip(diff * 2, 0, 255).astype(np.uint8)), (CW * 2, 28))
            d.text((CW * 2 + 6, 8), f'|diff|x2   MAD {m["mad"]}  SSIM {m["ssim"]}', fill=(255, 255, 120))
        sheet.paste(eng, (x, 28))
        if refim is not None:
            rx = sheet.width - CW
            sheet.paste(refim, (rx, 28))
            E, Rf = np.asarray(eng).astype(np.float32), np.asarray(refim).astype(np.float32)
            m['mad_vs_ref'] = round(float(np.abs(E - Rf).mean()), 3)
            if fin is not None:
                m['ref_mad'] = round(float(np.abs(np.asarray(fin).astype(np.float32) - Rf).mean()), 3)
            d.text((rx + 6, 8), f'ref_render (AviUtl semantics)  engine-vs-ref MAD {m["mad_vs_ref"]}' + (f'  ref-vs-final {m["ref_mad"]}' if 'ref_mad' in m else ''), fill=(180, 255, 160))
        d.text((x + 6, 8), f'engine comp {comp_id} ({name})  f{f}', fill=(120, 255, 255))
        p = os.path.join(outdir, f'f{f:05d}.png')
        sheet.save(p)
        m['image'] = p
        res[f] = m
        print(f, m.get('mad'), m.get('ssim'), 'vs_ref', m.get('mad_vs_ref'), p)
    mp = os.path.join(outdir, 'metrics.json')
    hist = json.load(open(mp)) if os.path.exists(mp) else {'runs': []}
    run = {'tag': a.tag or time.strftime('%H:%M:%S'), 'comp_id': comp_id, 'offset': a.offset, 'frames': {str(k): {kk: vv for kk, vv in v.items() if kk != 'image'} for k, v in res.items()},
           'render_sec': log, 'engine_messages': msgs}
    vals = [v['mad'] for v in res.values() if 'mad' in v]
    if vals:
        run['mad_mean'] = round(sum(vals) / len(vals), 3)
        run['ssim_mean'] = round(sum(v['ssim'] for v in res.values()) / len(vals), 4)
        print('mean MAD', run['mad_mean'], 'SSIM', run['ssim_mean'])
    vr = [v['mad_vs_ref'] for v in res.values() if 'mad_vs_ref' in v]
    if vr:
        run['mad_vs_ref_mean'] = round(sum(vr) / len(vr), 3)
        print('mean engine-vs-ref MAD', run['mad_vs_ref_mean'])
    hist['runs'].append(run)
    json.dump(hist, open(mp, 'w'), ensure_ascii=False, indent=1)
    if msgs:
        print('--- engine messages ---')
        for k, v in sorted(msgs.items(), key=lambda kv: -kv[1])[:25]:
            print(f'  x{v} {k}')
    print('render sec/frame:', [t for _, t in log])


if __name__ == '__main__':
    main()
