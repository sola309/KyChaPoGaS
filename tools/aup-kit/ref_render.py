#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""取り込んだコンポジション文書を、AviUtl の決まりどおりに numpy で描く小さな参照レンダラ(2D だけ・遅い)。

ねらい: 「取り込み側の読み(文書の意味)」と「エンジンの実装」のどちらがずれているかを切り分ける。
エンジンの代わりではない。カメラ・3D・ぼかし・縁取り・動画(連番以外)などは描かない。

    PY=repo/backend/.venv/bin/python
    $PY ref_render.py --scene 36 --frames 4760,4850            # compare/sceneNN/ref_fNNNNN.png(左 = 完成動画、右 = 参照)

描くもの: solid / shape(rect・ellipse)/ image / text(おおよそ)/ comp(入れ子)/ video(連番を取り寄せた物だけ)
効果: offset / clip_line / crop / mask(rect・ellipse)/ mask_image / fill / flip / blinds / chroma_key / repeat(grid) / clip_sector
ほか: group(scope・in/out・入れ子)、matte、blend(normal・multiply・screen・add)、キーフレーム(Penner 式)

AviUtl の決まり(ここでの実装 = 取り込み側の読み):
  - 効果はオブジェクトの素の絵(拡大・回転の前)に上から順に掛かる。座標は絵の中心が原点、y は下が正。
  - clip_line: 中心 (cx, cy) を通り、角度 a の直線。法線 n = (-sin a, cos a)(a = 0 で下向き)。d = (p - c)·n。
      width = 0 → d > 0 の側(a = 0 なら下側)を消す。width > 0 → |d| <= width/2 の帯だけ残す。width < 0 → 帯を消す。
  - crop: 絵の四辺から px だけ消す(絵の位置は変えない)。
  - グループ制御: 画面の中心 C を原点に p' = G + S·R·(p - C)。対象の拡大率に S を掛け、回転に R を足す。in〜out の間だけ。
"""
from __future__ import annotations

import argparse
import functools
import json
import math
import os
import sys
import urllib.request

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from aup_to_comp import ease_value  # noqa: E402

SAKURA = '/home/kigarashi309/workspace/projects/KyChaPoGaS/reference/aviutl_mad/sakura'
API = 'http://127.0.0.1:8002'
FONTS = {'APJapanesefont': '/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/backend/data/fonts/APJapanesefont.ttf',
         'Noto Serif JP': '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc',
         'Noto Sans JP': '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
         'Noto Serif JP:b': '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc',
         'Noto Sans JP:b': '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'}


@functools.lru_cache(maxsize=512)
def get_font(name, weight, px):
    key = name + (':b' if (weight or 400) >= 600 and name + ':b' in FONTS else '')
    return ImageFont.truetype(FONTS.get(key, FONTS['Noto Sans JP']), max(1, round(px)))


_nocam = False
CLIP_SIGN = 1          # width = 0 のとき消す側(+1 = 法線の側)。完成動画と比べて決めた値


def ev(v, f):
    """プロパティ値を f コマ目で評価。"""
    if isinstance(v, dict) and 'k' in v:
        ks = v['k']
        if f <= ks[0]['f']:
            return ks[0]['v']
        if v.get('loop') == 'pingpong' and len(ks) >= 2:
            a, b = ks[0], ks[-1]
            span = b['f'] - a['f']
            t = ((f - a['f']) / span) % 2
            t = t if t <= 1 else 2 - t
            return lerp(a['v'], b['v'], ease_value(a.get('e', 'linear'), t))
        for a, b in zip(ks, ks[1:]):
            if f < b['f']:
                e = a.get('e', 'linear')
                t = (f - a['f']) / (b['f'] - a['f'])
                return lerp(a['v'], b['v'], ease_value(e, t) if isinstance(e, str) else t)
        return ks[-1]['v']
    return v


def lerp(a, b, t):
    if isinstance(a, list):
        return [x + (y - x) * t for x, y in zip(a, b)]
    return a + (b - a) * t


def rgb(c):
    c = (c or '#ffffff').lstrip('#')
    return [int(c[i:i + 2], 16) / 255 for i in (0, 2, 4)]


class Ref:
    def __init__(self, project_id=36, ss=0.5):
        self.ss = ss            # 描く倍率(0.5 = 960×540)
        am = json.load(open(os.path.join(SAKURA, 'asset_map.json'), encoding='utf-8'))
        self.asset = {v['asset_id']: v for v in am.values() if v.get('project_id') == project_id}
        self.comps = {}

    def comp(self, cid):
        if cid not in self.comps:
            self.comps[cid] = json.load(urllib.request.urlopen(f'{API}/api/comps/{cid}'))
        return self.comps[cid]

    @functools.lru_cache(maxsize=256)
    def image(self, aid):
        e = self.asset.get(aid)
        if not e or e.get('kind') not in ('image',):
            return None
        im = Image.open(os.path.join(SAKURA, 'materials', e['local'])).convert('RGBA')
        if self.ss != 1:
            im = im.resize((max(1, round(im.width * self.ss)), max(1, round(im.height * self.ss))), Image.BILINEAR)
        a = np.asarray(im).astype(np.float32) / 255
        return a

    def seq_frame(self, aid, n):
        e = self.asset.get(aid)
        if not e or e.get('kind') != 'seq':
            return None
        import subprocess
        import io
        p = os.path.join(SAKURA, 'materials', e['local'])
        n = max(0, min(e['count'] - 1, int(n)))
        r = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{n / e["fps"]:.5f}', '-i', p, '-frames:v', '1',
                            '-vf', f'scale=iw*{self.ss}:ih*{self.ss}', '-pix_fmt', 'rgba', '-f', 'image2pipe', '-c:v', 'png', '-'],
                           capture_output=True)
        if not r.stdout:
            return None
        return np.asarray(Image.open(io.BytesIO(r.stdout)).convert('RGBA')).astype(np.float32) / 255

    # ---- 素の絵 ----
    def base(self, L, f, comp):
        s = self.ss
        src = L.get('source') or {}
        t = L['type']
        W, H = comp['width'], comp['height']
        if t == 'solid':
            a = np.ones((round(H * s), round(W * s), 4), np.float32)
            a[..., :3] = rgb(src.get('color'))
            return a
        if t == 'shape':
            w, h = ev(src.get('width', 100), f), ev(src.get('height', 100), f)
            sw = src.get('stroke_width', 0) if src.get('stroke') else 0
            w2, h2 = max(1, round((w + sw) * s)), max(1, round((h + sw) * s))
            im = Image.new('L', (w2 * 2, h2 * 2), 0)
            d = ImageDraw.Draw(im)
            box = [0, 0, w2 * 2 - 1, h2 * 2 - 1]
            fn = d.ellipse if src.get('kind') == 'ellipse' else d.rectangle
            if src.get('stroke'):
                fn(box, outline=255, width=max(1, round(sw * s * 2)))
            else:
                fn(box, fill=255)
            al = np.asarray(im.resize((w2, h2), Image.BILINEAR)).astype(np.float32) / 255
            a = np.zeros((h2, w2, 4), np.float32)
            a[..., :3] = rgb(src.get('stroke') or src.get('fill'))
            a[..., 3] = al
            return a
        if t == 'image':
            return self.image(src.get('asset_id'))
        if t == 'video':
            if src.get('asset_id') is None or L.get('guide'):
                return None
            n = (f - L['in']) * L.get('speed', 1) + L.get('start', 0)
            if 'time_remap' in src:
                n = ev(src['time_remap'], f)
            return self.seq_frame(src['asset_id'], n)
        if t == 'comp':
            cid = src.get('comp_id')
            if not cid:
                return None
            n = (f - L['in']) * L.get('speed', 1) + L.get('start', 0)
            if 'time_remap' in src:
                n = ev(src['time_remap'], f)
            return self.render(cid, int(round(n)), nested=True)
        if t == 'text':
            return self.text(src, f)
        return None

    def text(self, src, f):
        s = self.ss
        size = max(2, ev(src.get('size', 50), f) * s)
        font = get_font(src.get('font') or 'Noto Sans JP', src.get('weight'), size)
        txt = src.get('text') or ''
        if not txt.strip():
            return None
        tr = (src.get('tracking') or 0) * s
        cell = (src.get('size_aviutl') or src.get('size')) * s if not isinstance(src.get('size'), dict) else size
        lines = txt.split('\n')
        if src.get('writing') == 'vertical':
            cols = lines
            w = int(len(cols) * cell + 4)
            h = int(max(len(c) for c in cols) * (cell + tr) + 4)
            im = Image.new('L', (max(1, w), max(1, h)), 0)
            d = ImageDraw.Draw(im)
            for ci, col in enumerate(cols):
                x = w - (ci + 1) * cell
                for i, ch in enumerate(col):
                    d.text((x + cell / 2, i * (cell + tr) + cell / 2), ch, font=font, fill=255, anchor='mm')
        else:
            # runs(文の途中のサイズ・書体替え)を 1 文字ずつの (字, フォント, サイズ) に開く
            runs = src.get('runs') or [{'text': txt, 'font': src.get('font'), 'weight': src.get('weight'), 'size': ev(src.get('size', 50), f)}]
            chars = []
            for r in runs:
                fnt = get_font(r.get('font') or 'Noto Sans JP', r.get('weight'), r['size'] * s)
                chars += [(ch, fnt, r['size'] * s) for ch in r['text']]
            rows, cur = [], []
            for ch in chars:
                if ch[0] == '\n':
                    rows.append(cur)
                    cur = []
                else:
                    cur.append(ch)
            rows.append(cur)
            ws = [sum(c[1].getlength(c[0]) + tr for c in row) for row in rows]
            w = int(max(ws) + 4)
            mx = max([c[2] for c in chars] + [cell])
            lead = (src.get('leading') or mx / s) * s if len(rows) > 1 else mx
            h = int(lead * (len(rows) - 1) + mx * 1.25 + 4)
            im = Image.new('L', (max(1, w), max(1, h)), 0)
            d = ImageDraw.Draw(im)
            for li, row in enumerate(rows):
                x = {'left': 0, 'center': (w - ws[li]) / 2, 'right': w - ws[li]}.get(src.get('align', 'left'), 0)
                for ch, fnt, sz in row:
                    d.text((x, li * lead + mx), ch, font=fnt, fill=255, anchor='ls')
                    x += fnt.getlength(ch) + tr
        a = np.zeros((im.height, im.width, 4), np.float32)
        a[..., :3] = rgb(src.get('fill'))
        a[..., 3] = np.asarray(im).astype(np.float32) / 255
        return a

    # ---- 効果 ----
    def apply_fx(self, img, fxs, f, st, comp):
        s = self.ss
        for fx in fxs:
            if fx.get('enabled') is False or img is None:
                continue
            p = {k: ev(v, f) for k, v in (fx.get('params') or {}).items()}
            t = fx['type']
            h, w = img.shape[:2]
            if t == 'offset':
                if 'position' in p:
                    st['pos'] = [st['pos'][0] + p['position'][0], st['pos'][1] + p['position'][1]]
                    st['z'] = st.get('z', 0) + (p['position'][2] if len(p['position']) > 2 else 0)
                if 'scale' in p:
                    st['scale'] = [st['scale'][0] * p['scale'][0] / 100, st['scale'][1] * p['scale'][1] / 100]
                if 'rotation' in p:
                    st['rot'] += p['rotation'][2]
                if 'opacity' in p:
                    st['op'] *= p['opacity'] / 100
                continue
            yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
            xx = (xx + 0.5 - w / 2) / s
            yy = (yy + 0.5 - h / 2) / s
            img = img.copy()
            if t == 'clip_line':
                a = math.radians(p.get('angle', 0))
                d = (xx - p.get('cx', 0)) * -math.sin(a) + (yy - p.get('cy', 0)) * math.cos(a)
                wd = p.get('width', 0)
                ft = max(p.get('feather', 0), 1 / s) / 2
                if wd == 0:
                    m = np.clip(0.5 - CLIP_SIGN * d / (2 * ft), 0, 1)
                elif wd > 0:
                    m = np.clip(0.5 + (wd / 2 - np.abs(d)) / (2 * ft), 0, 1)
                else:
                    m = np.clip(0.5 - (-wd / 2 - np.abs(d)) / (2 * ft), 0, 1)
                img[..., 3] *= m
            elif t == 'crop':
                x0, y0 = xx + w / 2 / s, yy + h / 2 / s
                m = (y0 >= p.get('top', 0)) & (y0 <= h / s - p.get('bottom', 0)) & (x0 >= p.get('left', 0)) & (x0 <= w / s - p.get('right', 0))
                img[..., 3] *= m
            elif t == 'mask':
                size, asp = p.get('size', 100), p.get('aspect', 0)
                hw, hh = size / 2 * (1 - max(0, asp) / 100), size / 2 * (1 + min(0, asp) / 100)
                r = math.radians(-p.get('rotation', 0))
                dx, dy = xx - p.get('x', 0), yy - p.get('y', 0)
                lx, ly = dx * math.cos(r) - dy * math.sin(r), dx * math.sin(r) + dy * math.cos(r)
                if p.get('shape') == 'ellipse':
                    m = ((lx / max(hw, 1e-3)) ** 2 + (ly / max(hh, 1e-3)) ** 2 <= 1)
                else:
                    m = (np.abs(lx) <= hw) & (np.abs(ly) <= hh)
                m = m.astype(np.float32)
                img[..., 3] *= (1 - m) if p.get('invert') else m
            elif t == 'mask_image':
                mi = self.image(p.get('asset_id')) if p.get('asset_id') else None
                if mi is not None:
                    mh, mw = mi.shape[:2]
                    k = 1.0
                    if p.get('size') and not p.get('fit_original'):
                        k = p['size'] * s / max(mw, mh)
                    ix = np.round((xx - p.get('x', 0)) * s / k + mw / 2 - 0.5).astype(int)
                    iy = np.round((yy - p.get('y', 0)) * s / k + mh / 2 - 0.5).astype(int)
                    ok = (ix >= 0) & (ix < mw) & (iy >= 0) & (iy < mh)
                    m = np.zeros((h, w), np.float32)
                    m[ok] = mi[iy[ok], ix[ok], 3]
                    img[..., 3] *= (1 - m) if p.get('invert') else m
            elif t == 'fill':
                amt = p.get('amount', 100) / 100
                c = np.array(rgb(p.get('color')), np.float32)
                if p.get('keep_luma'):
                    y = (img[..., :3] @ np.array([0.299, 0.587, 0.114], np.float32))[..., None]
                    tgt = np.clip(c * y * 2, 0, 1) if True else c
                else:
                    tgt = c
                img[..., :3] = img[..., :3] * (1 - amt) + tgt * amt
            elif t == 'stroke_outline' and p.get('variant') != 'T':
                from PIL import ImageFilter
                r = max(1, int(round(p.get('width', 1) * s)))
                pad = r + 2
                big = np.zeros((h + pad * 2, w + pad * 2, 4), np.float32)
                big[pad:-pad, pad:-pad] = img
                al = Image.fromarray((big[..., 3] * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(r * 2 + 1))
                oa = np.asarray(al).astype(np.float32) / 255
                c = np.array(rgb(p.get('color')), np.float32)
                a0 = big[..., 3:4]
                out = np.zeros_like(big)
                out[..., :3] = big[..., :3] * a0 + c * (1 - a0)
                out[..., 3] = np.maximum(oa, big[..., 3])
                img = out
            elif t == 'blur' and not p.get('variant'):
                from PIL import ImageFilter
                r = p.get('radius', 0) * s / 2
                if r > 0.3:
                    pad = int(r * 3) + 1
                    big = np.zeros((h + pad * 2, w + pad * 2, 4), np.float32)
                    big[pad:-pad, pad:-pad] = img
                    big[..., :3] *= big[..., 3:4]
                    ch = [np.asarray(Image.fromarray((np.clip(big[..., i], 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r))).astype(np.float32) / 255 for i in range(4)]
                    big = np.dstack(ch)
                    big[..., :3] = np.where(big[..., 3:4] > 1e-5, big[..., :3] / np.maximum(big[..., 3:4], 1e-5), 0)
                    img = big
            elif t == 'color':
                c = img[..., :3]
                y = (c @ np.array([0.299, 0.587, 0.114], np.float32))[..., None]
                c = y + (c - y) * (1 + p.get('saturation', 0) / 100)
                c = (c - 0.5) * (1 + p.get('contrast', 0) / 100) + 0.5
                c = c * (p.get('luminance', 100) / 100) + p.get('brightness', 0) / 100
                img[..., :3] = np.clip(c, 0, 1)
            elif t == 'flip':
                if p.get('h'):
                    img = img[:, ::-1]
                if p.get('v'):
                    img = img[::-1]
            elif t == 'blinds':
                a = math.radians(p.get('angle', 0))
                pitch = max(1e-3, p.get('pitch', 100))
                d = xx * -math.sin(a) + yy * math.cos(a)
                ph = np.mod(d / pitch + 0.5, 1.0)
                img[..., 3] *= (ph < p.get('ratio', 50) / 100)
            elif t == 'chroma_key':
                c = np.array(rgb(p.get('color')), np.float32)
                dist = np.abs(img[..., :3] - c).sum(-1)
                img[..., 3] *= (dist > 0.6)
            elif t == 'repeat' and p.get('mode') == 'grid':
                nx, ny = int(max(1, p.get('count_x', 1))), int(max(1, p.get('count_y', 1)))
                gx, gy = p.get('gap_x', 100) / 100, p.get('gap_y', 100) / 100
                tw, th = int(w * gx), int(h * gy)
                out = np.zeros((th * (ny - 1) + h, tw * (nx - 1) + w, 4), np.float32)
                for j in range(ny):
                    for i in range(nx):
                        reg = out[j * th:j * th + h, i * tw:i * tw + w]
                        reg[...] = over(reg, img)
                img = out
        return img

    # ---- 1 レイヤーを画面に置く ----
    def place(self, img, mat, W, H):
        """img(RGBA・ストレート)を 3×3 行列 mat(素の絵の中心原点 px → 画面 px、どちらも元の解像度)で置く。"""
        s = self.ss
        h, w = img.shape[:2]
        # 画面(縮小後)px → 絵(縮小後)px
        if abs(np.linalg.det(mat)) < 1e-9:
            return np.zeros((round(H * s), round(W * s), 4), np.float32)
        to_local = np.linalg.inv(mat)
        A = np.array([[1 / s, 0, 0], [0, 1 / s, 0], [0, 0, 1]])          # 縮小画面 → 元の画面
        B = np.array([[s, 0, w / 2], [0, s, h / 2], [0, 0, 1]])          # 元の絵(中心原点)→ 縮小絵
        M = B @ to_local @ A
        pm = img.copy()
        pm[..., :3] *= pm[..., 3:4]
        chans = []
        for c in range(4):
            ch = Image.fromarray(pm[..., c], 'F').transform((round(W * s), round(H * s)), Image.AFFINE,
                                                              (M[0, 0], M[0, 1], M[0, 2] , M[1, 0], M[1, 1], M[1, 2]), Image.BILINEAR)
            chans.append(np.asarray(ch))
        return np.dstack(chans)       # 乗算済み

    def layer_screen(self, L, f, comp, groups):
        img = self.base(L, f, comp)
        if img is None:
            return None, 1
        W, H = comp['width'], comp['height']
        tr = L.get('transform') or {}
        pos = ev(tr.get('position', [W / 2, H / 2, 0]), f)
        sc = ev(tr.get('scale', [100, 100]), f)
        rot = ev(tr.get('rotation', [0, 0, 0]), f)
        anc = ev(tr.get('anchor', [0, 0, 0]), f)
        st = {'z': pos[2] if len(pos) > 2 else 0, 'pos': [pos[0], pos[1]], 'scale': [sc[0] / 100, sc[1] / 100], 'rot': rot[2] if isinstance(rot, list) else rot,
              'op': ev(tr.get('opacity', 100), f) / 100}
        img = self.apply_fx(img, L.get('effects') or [], f, st, comp)
        mats = []
        for g in groups:          # 内側(近いグループ)→ 外側
            if L['id'] in g.get('scope', []) and g['in'] <= f < g['out'] and g.get('visible', True):
                img = self.apply_fx(img, g.get('effects') or [], f, st, comp)
                gt = g.get('transform') or {}
                gp = ev(gt.get('position', [W / 2, H / 2, 0]), f)
                gs = ev(gt.get('scale', [100, 100]), f)
                gr = ev(gt.get('rotation', [0, 0, 0]), f)
                mats.append((gp, gs[0] / 100, gr[2]))
                st['z'] = st['z'] * gs[0] / 100 + (gp[2] if len(gp) > 2 else 0)
        if img is None:
            return None, 1
        if L['type'] == 'text':
            # そろえ方 = 基準点が箱のどこか
            src = L.get('source') or {}
            h, w = img.shape[:2]
            ax = {'left': w / 2, 'center': 0, 'right': -w / 2}.get(src.get('align', 'center'), 0) / self.ss
            ay = {'top': h / 2, 'middle': 0, 'bottom': -h / 2}.get(src.get('valign', 'middle'), 0) / self.ss
            anc = [anc[0] - ax, anc[1] - ay, 0]
        r = math.radians(st['rot'])
        c, s_ = math.cos(r), math.sin(r)
        M = np.array([[c * st['scale'][0], -s_ * st['scale'][1], st['pos'][0]],
                      [s_ * st['scale'][0], c * st['scale'][1], st['pos'][1]], [0, 0, 1]])
        M = M @ np.array([[1, 0, -anc[0]], [0, 1, -anc[1]], [0, 0, 1]])
        for gp, gs, gr in mats:
            r = math.radians(gr)
            c, s_ = math.cos(r), math.sin(r)
            G = np.array([[c * gs, -s_ * gs, gp[0]], [s_ * gs, c * gs, gp[1]], [0, 0, 1]]) @ np.array([[1, 0, -W / 2], [0, 1, -H / 2], [0, 0, 1]])
            M = G @ M
        cam = self.camera_for(L, f, comp, groups)
        if cam is not None and not _nocam:
            # まっすぐ奥を見るカメラだけ: 画面 = 中心 + (p - カメラ)·D / (z - カメラz)
            cx, cy, cz, D = cam
            k = D / max(1e-3, st['z'] - cz)
            P = np.array([[k, 0, W / 2 - cx * k], [0, k, H / 2 - cy * k], [0, 0, 1]])
            M = P @ M
        self.last_state = dict(st, x=float((M @ np.array([0, 0, 1]))[0]), y=float((M @ np.array([0, 0, 1]))[1]))
        out = self.place(img, M, W, H)
        return out, st['op']

    def camera_for(self, L, f, comp, groups):
        for C in comp['data']['layers']:
            if C['type'] != 'camera' or not (C['in'] <= f < C['out']) or L['id'] not in C.get('scope', []):
                continue
            src = C.get('source') or {}
            pos = ev(C['transform']['position'], f)
            D = src.get('zoom', 1024)
            return pos[0], pos[1], pos[2], D
        return None

    def world_pos(self, T, f, comp, groups):
        W, H = comp['width'], comp['height']
        p = list(ev((T.get('transform') or {}).get('position', [W / 2, H / 2, 0]), f))
        for fx in T.get('effects') or []:
            if fx['type'] == 'offset' and 'position' in fx['params']:
                o = ev(fx['params']['position'], f)
                p = [p[0] + o[0], p[1] + o[1], p[2] + o[2]]
        for g in groups:
            if T['id'] in g.get('scope', []) and g['in'] <= f < g['out']:
                gt = g.get('transform') or {}
                gp = ev(gt.get('position', [W / 2, H / 2, 0]), f)
                gs = ev(gt.get('scale', [100, 100]), f)[0] / 100
                r = math.radians(ev(gt.get('rotation', [0, 0, 0]), f)[2])
                x, y = (p[0] - W / 2) * gs, (p[1] - H / 2) * gs
                p = [gp[0] + x * math.cos(r) - y * math.sin(r), gp[1] + x * math.sin(r) + y * math.cos(r), p[2] * gs + gp[2]]
        return p

    def render(self, cid, f, nested=False):
        comp = self.comp(cid)
        data = comp['data']
        W, H = comp['width'], comp['height']
        s = self.ss
        canvas = np.zeros((round(H * s), round(W * s), 4), np.float32)
        if data.get('bg') and not nested:
            canvas[..., :3] = rgb(data['bg'])
            canvas[..., 3] = 1
        layers = data['layers']
        byid = {L['id']: L for L in layers}
        groups = [L for L in layers if L['type'] == 'group']      # 配列の先頭が手前 = レイヤー番号が大きい = 内側
        if f < 0 or f >= comp['duration_frames']:
            return ungroup(canvas)
        for L in reversed(layers):
            if L['type'] in ('group', 'camera', 'null') or L.get('visible') is False or L.get('guide'):
                continue
            if not (L['in'] <= f < L['out']) or L['id'].endswith('_m'):
                continue
            if L['type'] == 'adjustment':
                continue
            px, op = self.layer_screen(L, f, comp, groups)
            if px is None:
                continue
            px = px * op
            m = L.get('matte')
            if m and m['layer'] in byid:
                ML = byid[m['layer']]
                mp = self.layer_screen(ML, f, comp, groups)[0] if ML['in'] <= f < ML['out'] else None
                px = px * (mp[..., 3:4] if mp is not None else 0)
            b = L.get('blend', 'normal')
            if b == 'normal':
                canvas = px + canvas * (1 - px[..., 3:4])
            else:
                a = px[..., 3:4]
                src = np.where(a > 1e-6, px[..., :3] / np.maximum(a, 1e-6), 0)
                dst = np.where(canvas[..., 3:4] > 1e-6, canvas[..., :3] / np.maximum(canvas[..., 3:4], 1e-6), 0)
                if b == 'multiply':
                    mix = src * dst
                elif b == 'screen':
                    mix = 1 - (1 - src) * (1 - dst)
                elif b == 'add':
                    mix = np.clip(src + dst, 0, 1)
                else:
                    mix = src
                ca = canvas[..., 3:4]
                # 下に絵がある所だけ合成モードが効く(AviUtl と同じ)
                canvas[..., :3] = canvas[..., :3] * (1 - a) + (mix * ca + src * (1 - ca)) * a
                canvas[..., 3:4] = a + ca * (1 - a)
        return ungroup(canvas) if nested else canvas


def ungroup(pm):
    out = pm.copy()
    a = np.maximum(pm[..., 3:4], 1e-6)
    out[..., :3] = np.where(pm[..., 3:4] > 1e-6, pm[..., :3] / a, 0)
    return out


def over(dst, src):
    a = src[..., 3:4]
    out = dst.copy()
    out[..., :3] = src[..., :3] * a + dst[..., :3] * (1 - a)
    out[..., 3:4] = a + dst[..., 3:4] * (1 - a)
    return out


def main():
    from compare import final_frame, parse_frames, ssim, CW, CH
    ap = argparse.ArgumentParser()
    ap.add_argument('--scene', type=int)
    ap.add_argument('--comp', type=int)
    ap.add_argument('--frames', required=True)
    ap.add_argument('--no-final', action='store_true')
    ap.add_argument('--bg', default='#808080')
    a = ap.parse_args()
    cid = a.comp or json.load(open(os.path.join(SAKURA, 'comp_map.json')))['36'][str(a.scene)]
    name = f'scene{a.scene:02d}' if a.scene is not None else f'comp{cid}'
    out = os.path.join(SAKURA, 'compare', name)
    os.makedirs(out, exist_ok=True)
    R = Ref()
    for f in parse_frames(a.frames):
        pm = R.render(cid, f)
        bg = np.array(rgb(a.bg), np.float32)
        img = pm[..., :3] + bg * (1 - pm[..., 3:4])
        im = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).resize((CW, CH))
        if a.no_final:
            sheet = im
        else:
            fin = final_frame(f)
            sheet = Image.new('RGB', (CW * 2, CH))
            sheet.paste(fin, (0, 0))
            sheet.paste(im, (CW, 0))
            A, B = np.asarray(fin).astype(np.float32), np.asarray(im).astype(np.float32)
            print(f, 'MAD', round(float(np.abs(A - B).mean()), 3))
        p = os.path.join(out, f'ref_f{f:05d}.png')
        sheet.save(p)
        print(p)


if __name__ == '__main__':
    main()
