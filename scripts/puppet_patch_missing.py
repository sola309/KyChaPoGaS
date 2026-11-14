#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分解(See-Through)で消えた部分をパペットに足し戻す。

See-Through は黒いリボン・口の線・手に持った小物などを、どの層にも入れずに落とすことがある。
元の立ち絵(分解の出力の src_img.png = キャンバスと同じ大きさ)と「全部の層を重ねた絵」を比べ、
欠けた部分を元の絵から切り出して、別の層として manifest に足す。rig_compiler.py のあとに流す。

  足す層(中身があるときだけ):
    patch head       … 頭のまわりで「どの層にも無い」部分(リボンなど)。group = head、z は前髪の上
    patch mouthline  … 口のあたりで元の絵のほうがずっと暗い線(口の線・八重歯の輪郭)。group = head、z は mouth のすぐ下
    体の欠け          … 「どの層にも無い」所だけ(色の差は --body-color を付けたときだけ)。既定(--body merge)では、いちばん近い体の層(handwear・topwear・legwear …)の PNG に描き足す
                        (腕・脚のボーン(tools/pose-kit)はその層ごとに曲げるので、別の層にすると置いて行かれる)。
                        元の PNG は <名前>.prepatch.png に控える。--body layer なら別の層 patch body(group = body)にする

  元の manifest は manifest.json.bak に 1 回だけ控える。何度流しても同じ結果(前に足した patch 層は消してから作り直す)。

使い方:
  python puppet_patch_missing.py <puppet_dir> <src_img.png> [--preview out.png] [--dry]
"""
import argparse
import json
import os
import shutil

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

PATCH_PREFIX = 'patch '


def load_rgba(p, size=None):
    im = Image.open(p).convert('RGBA')
    if size and im.size != tuple(size):
        im = im.resize(tuple(size), Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255.0


def composite(pdir, layers, size):
    W, H = size
    out = np.zeros((H, W, 4), np.float32)
    for ly in sorted(layers, key=lambda l: l.get('z', 0)):
        fp = os.path.join(pdir, ly['file'])
        if not os.path.exists(fp):
            continue
        s = load_rgba(fp, size)
        a = s[..., 3:4]
        out[..., :3] = s[..., :3] * a + out[..., :3] * (1 - a)
        out[..., 3:4] = a + out[..., 3:4] * (1 - a)
    return out


def foreground(src, matte=None):
    """元の絵の人物の範囲。
    matte(元の絵と同じ構図の切り抜き PNG)があれば、src の「絵のある四角」に合わせて伸ばしてそのアルファを使う。
    無ければ、絵の四角の縁から地の色をたどって外側だけを除く(白い服の内側は線で囲まれているので残る)。"""
    a = src[..., 3] > 0.5
    H, W = a.shape
    ys, xs = np.where(a)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    if matte is not None:
        m = np.asarray(Image.open(matte).convert('RGBA').resize((x1 - x0, y1 - y0), Image.LANCZOS))[..., 3] > 127
        out = np.zeros((H, W), bool); out[y0:y1, x0:x1] = m
        return out & a
    full = (x1 - x0) * (y1 - y0)
    if a.sum() < 0.97 * full:          # もともと透過の絵
        return a
    rgb = np.ascontiguousarray((src[y0:y1, x0:x1, :3] * 255).astype(np.uint8))
    h, w = rgb.shape[:2]
    outside = np.zeros((h, w), bool)
    step = max(8, min(h, w) // 40)
    seeds = [(x, y) for x in range(0, w, step) for y in (0, h - 1)] + [(x, y) for y in range(0, h, step) for x in (0, w - 1)]
    for sx, sy in seeds:
        if outside[sy, sx]:
            continue
        mask = np.zeros((h + 2, w + 2), np.uint8)
        # 少しずつ変わる地(グラデーション)もたどる。線(急な変化)で止まる
        cv2.floodFill(rgb.copy(), mask, (sx, sy), (0, 0, 0), (3, 3, 3), (3, 3, 3), 4 | cv2.FLOODFILL_MASK_ONLY | (255 << 8))
        reg = mask[1:-1, 1:-1] > 0
        seed = rgb[sy, sx].astype(np.int32)
        outside |= reg & (np.abs(rgb.astype(np.int32) - seed).max(axis=2) <= 48)
    out = np.zeros((H, W), bool); out[y0:y1, x0:x1] = ~outside
    return out & a


def clean(mask, min_area, open_px=1):
    m = mask.astype(np.uint8)
    if open_px:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * open_px + 1, 2 * open_px + 1))
        opened = cv2.morphologyEx(m, cv2.MORPH_OPEN, k)
        # 開いた芯につながる元の画素は残す(輪郭を削らない)
        lab, n = ndimage.label(m)
        keep = np.unique(lab[opened > 0])
        m = np.isin(lab, keep[keep > 0]).astype(np.uint8)
    lab, n = ndimage.label(m)
    if n == 0:
        return np.zeros_like(mask, bool), []
    areas = ndimage.sum(m, lab, range(1, n + 1))
    comps = []
    out = np.zeros_like(mask, bool)
    for i, ar in enumerate(areas, 1):
        if ar >= min_area:
            c = lab == i
            ys, xs = np.where(c)
            comps.append(dict(area=int(ar), bbox=[int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1], cx=float(xs.mean()), cy=float(ys.mean()), mask=c))
            out |= c
    return out, comps


def save_layer(pdir, fname, src, mask, feather=1.2):
    a = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), feather) if feather else mask.astype(np.float32)
    a = np.clip(a * 1.6, 0, 1) * (cv2.dilate(mask.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
    out = np.dstack([src[..., :3], a])
    Image.fromarray((out * 255 + 0.5).astype(np.uint8), 'RGBA').save(os.path.join(pdir, fname))
    ys, xs = np.where(a > 0.06)
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('puppet_dir'); ap.add_argument('src_img')
    ap.add_argument('--preview'); ap.add_argument('--dry', action='store_true')
    ap.add_argument('--min-area', type=float, default=0.00012, help='欠けとみなす最小の面積(キャンバスの面積比)')
    ap.add_argument('--no-mouth', action='store_true')
    ap.add_argument('--body', choices=('merge', 'layer'), default='merge', help='体の欠けの足し方')
    ap.add_argument('--body-color', action='store_true', help='体でも「色の差」を直す(手の小物など)。既定は直さない: 分解は隠れた腕・脚を描き足すので、\n元の絵との色の差は欠けではなく、直すと腕の層に服の柄が混ざる(腕を曲げたときに見える)')
    ap.add_argument('--matte', help='元の絵と同じ構図の切り抜き PNG(人物の範囲に使う)')
    ap.add_argument('--color-diff', type=float, default=0.30, help='層はあるが色が大きく違う所(髪に埋もれたリボンなど)を欠けとみなす差')
    a = ap.parse_args()
    pdir = a.puppet_dir
    mp = os.path.join(pdir, 'manifest.json')
    man = json.load(open(mp, encoding='utf-8'))
    W, H = man['canvas']
    layers = [l for l in man['layers'] if not str(l['name']).startswith(PATCH_PREFIX)]
    for l in layers:                                  # 前に描き足した層を元に戻す
        bak = os.path.join(pdir, os.path.splitext(l['file'])[0] + '.prepatch.png')
        if os.path.exists(bak) and not a.dry:
            shutil.copy2(bak, os.path.join(pdir, l['file']))
            if l.get('bbox_prepatch'): l['bbox'] = l.pop('bbox_prepatch')
    src = load_rgba(a.src_img, (W, H))
    comp = composite(pdir, layers, (W, H))
    fg = foreground(src, a.matte)
    min_area = max(24, a.min_area * W * H)

    # ── 1. どの層にも無い部分 ──
    miss, comps = clean(fg & (comp[..., 3] < 0.35), min_area, open_px=1)
    # 層はあるが中身が違う所(リボンが髪で埋められた・小物が服で埋められた)。細い線の差は開いて捨てる
    cdiff = fg & (comp[..., 3] >= 0.35) & (np.abs(comp[..., :3] - src[..., :3]).max(axis=2) > a.color_diff)
    cmiss, ccomps = clean(cdiff, min_area * 2.5, open_px=3)
    # 縁を広げる(ヒステリシス): 芯のまわり 4px で、弱い差(半分)でもつながっていれば入れる。縁のぎざぎざを減らす
    weak = fg & (np.abs(comp[..., :3] - src[..., :3]).max(axis=2) > a.color_diff * 0.4)
    k9 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    for c in ccomps:
        grown = (cv2.dilate(c['mask'].astype(np.uint8), k9) > 0) & weak
        lab, n = ndimage.label(grown | c['mask'])
        keep = np.unique(lab[c['mask']])
        c['mask'] = np.isin(lab, keep[keep > 0])
        c['area'] = int(c['mask'].sum()); c['color'] = True
    comps = comps + ccomps
    piv = man.get('pivots', {})
    by = {l['name']: l for l in layers}
    hb = [W, H, 0, 0]
    for l in layers:
        if (l['group'] in ('head', 'eyes', 'mouth', 'fronthair') and l['name'] != 'neck'):
            b = l['bbox']; hb = [min(hb[0], b[0]), min(hb[1], b[1]), max(hb[2], b[2]), max(hb[3], b[3])]
    hw = max(1, hb[2] - hb[0])
    neck_y = float(piv.get('head', [0, hb[3]])[1])
    head_m = np.zeros((H, W), bool); body_m = np.zeros((H, W), bool)
    rep = []; body_comps = []; skipped_color = []
    for c in comps:
        eye_y = float(piv.get('eyes', [0, hb[1] + 0.45 * (hb[3] - hb[1])])[1])
        on_head = (c['cy'] < neck_y or (c['bbox'][1] < eye_y and not c.get('color'))) and hb[0] - 0.45 * hw < c['cx'] < hb[2] + 0.45 * hw
        if c.get('color') and not on_head and not a.body_color:
            rep.append(('body(色の差・直さない)', c['area'], c['bbox'])); skipped_color.append(c); continue
        (head_m if on_head else body_m)[c['mask']] = True
        if not on_head: body_comps.append(c)
        rep.append((('head' if on_head else 'body') + ('(色の差)' if c.get('color') else ''), c['area'], c['bbox']))

    # ── 2. 口の線(顔の層が肌で埋めてしまい、線だけ消える) ──
    mouth_m = np.zeros((H, W), bool)
    rig = man.get('rig', {})
    if not a.no_mouth and (rig.get('eye') or {}).get('left') and (rig.get('eye') or {}).get('right') and piv.get('mouth'):
        el, er = rig['eye']['left'], rig['eye']['right']
        ed = max(8.0, abs(er[0] - el[0]))
        mx, my = piv['mouth']
        eye_y = (el[1] + er[1]) / 2
        x0, x1 = int(mx - 0.75 * ed), int(mx + 0.75 * ed)
        y0, y1 = int(max(eye_y + 0.38 * ed, my - 0.42 * ed)), int(my + 0.5 * ed)
        lum = lambda x: x[..., 0] * 0.299 + x[..., 1] * 0.587 + x[..., 2] * 0.114
        box = np.zeros((H, W), bool); box[max(0, y0):y1, max(0, x0):x1] = True
        face = by.get('face')
        if face is not None:
            fa = load_rgba(os.path.join(pdir, face['file']), (W, H))[..., 3] > 0.5
            fa = cv2.erode(fa.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0   # 顔の輪郭線は拾わない
            box &= fa
        dark = (lum(comp) - lum(src) > 0.22) & (comp[..., 3] > 0.5)
        mouth_m, mc = clean(box & dark, max(6, 0.000008 * W * H), open_px=0)
        # 口の中の色(牙・舌)も少し拾う: 線の近くで色が大きく違う所
        near = cv2.dilate(mouth_m.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
        diff = np.abs(comp[..., :3] - src[..., :3]).max(axis=2) > 0.16
        mouth_m |= box & near & diff
        for c in mc: rep.append(('mouthline', c['area'], c['bbox']))

    print(f'[patch] canvas {W}x{H}  欠け(層に無い) {int(miss.sum())}px  頭 {int(head_m.sum())}px  体 {int(body_m.sum())}px  口の線 {int(mouth_m.sum())}px')
    for r in rep: print('   ', r)

    new_layers = list(layers)
    added = []
    def add(name, fname, mask, group, after=None, before=None, depth=0.5, feather=1.2):
        if mask.sum() < 6: return
        bbox = save_layer(pdir, fname, src, mask, feather) if not a.dry else None
        ly = dict(name=name, file=fname, group=group, z=0, bbox=bbox, depth=depth, patch=True)
        idx = len(new_layers)
        names = [l['name'] for l in new_layers]
        if before and before in names: idx = names.index(before)
        elif after:
            hit = [i for i, l in enumerate(new_layers) if l['name'] in after or l['group'] in after]
            idx = (max(hit) + 1) if hit else len(new_layers)
        new_layers.insert(idx, ly); added.append(name)

    new_layers.sort(key=lambda l: l.get('z', 0))
    fdepth = float(by.get('face', {}).get('depth', 0.3))
    merged = {}
    if a.body == 'layer':
        add(PATCH_PREFIX + 'body', 'patch_body.png', body_m, 'body', after=('body',), depth=float(by.get('topwear', {}).get('depth', 0.5)))
    elif body_comps:
        blayers = [l for l in new_layers if l['group'] == 'body' and os.path.exists(os.path.join(pdir, l['file']))]
        rgbs = {l['name']: load_rgba(os.path.join(pdir, l['file']), (W, H)) for l in blayers}
        alph = {n: v[..., 3] > 0.35 for n, v in rgbs.items()}
        rgbs = {n: v[..., :3] for n, v in rgbs.items()}
        k13 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13))
        target = {}; erase = {}
        # (a) どの層にも無い成分 → まわりでいちばん重なる体の層へ
        big_m = np.zeros((H, W), bool)
        for c in body_comps:
            if c.get('color'): continue
            if c['area'] >= 0.005 * W * H:              # 大きい欠け(スカートが丸ごと無い など)は別の層にする(腕の層に混ぜない)
                big_m |= c['mask']; continue
            ring = (cv2.dilate(c['mask'].astype(np.uint8), k13) > 0) & ~c['mask']
            want = np.median(src[..., :3][c['mask']], axis=0)
            best, bd = None, 9.0
            for l in blayers:                          # まわりの色が近い層へ(同じくらいなら重なりの多い層)
                rr = ring & alph[l['name']]
                if rr.sum() < 12: continue
                dist = float(np.abs(np.median(rgbs[l['name']][rr], axis=0) - want).max()) - 0.00002 * float(rr.sum())
                if dist < bd: best, bd = l, dist
            if best is not None: target.setdefault(best['name'], np.zeros((H, W), bool))[c['mask']] = True
        if big_m.any():
            touch = cv2.dilate(big_m.astype(np.uint8), k13) > 0
            for c in skipped_color:
                if (c['mask'] & touch).any(): big_m |= c['mask']
            big_m = ndimage.binary_fill_holes(big_m) & fg
            names = [l['name'] for l in new_layers]
            add(PATCH_PREFIX + 'body', 'patch_body.png', big_m, 'body', before=('handwear' if 'handwear' in names else None), after=('body',),
                depth=float(by.get('topwear', {}).get('depth', 0.5)))
        # (b) 色の差の成分 → 画素ごとに「そこでいちばん上の層」を調べる。
        #     その層を外した下の重ねが元の絵と合うなら、その層がはみ出しているだけ → その層を消す(下の層が見える)。
        #     合わないなら、その層の中身が違う → その層に元の絵を描く。
        cm = np.zeros((H, W), bool)
        for c in body_comps:
            if c.get('color'): cm |= c['mask']
        if cm.any():
            zs = sorted(new_layers, key=lambda l: l.get('z', 0))
            top = np.full((H, W), -1, np.int32); under = np.zeros((H, W, 4), np.float32); unders = {}
            for i, l in enumerate(zs):
                fp = os.path.join(pdir, l['file'])
                if not os.path.exists(fp): continue
                im = load_rgba(fp, (W, H)); al = im[..., 3:4]
                if l['group'] == 'body': unders[i] = under.copy()
                under[..., :3] = im[..., :3] * al + under[..., :3] * (1 - al); under[..., 3:4] = al + under[..., 3:4] * (1 - al)
                top[im[..., 3] >= 0.35] = i
            for i, u in unders.items():
                l = zs[i]; S = cm & (top == i)
                if not S.any(): continue
                ok_under = (u[..., 3] >= 0.35) & (np.abs(u[..., :3] - src[..., :3]).max(axis=2) < 0.16)
                e = S & ok_under; pnt = S & ~ok_under
                if e.any(): erase.setdefault(l['name'], np.zeros((H, W), bool))[e] = True
                if not pnt.any(): continue
                # 描く先: まわりの色が元の絵の色にいちばん近い体の層(上の層がはみ出して下の層に穴がある場合は、上を消して下に描く)
                lab, n = ndimage.label(pnt)
                for ci in range(1, n + 1):
                    cmk = lab == ci
                    ring = (cv2.dilate(cmk.astype(np.uint8), k13) > 0) & ~cm
                    want = np.median(src[..., :3][cmk], axis=0)
                    best, bd = l, 9.0
                    for j, l2 in enumerate(zs[:i + 1]):
                        if l2['group'] != 'body' or l2['name'] not in alph: continue
                        rr = ring & alph[l2['name']] & (top == j)       # 見えている所の色で比べる
                        if rr.sum() < 12: continue
                        dist = float(np.abs(np.median(rgbs[l2['name']][rr], axis=0) - want).max())
                        if dist < bd - (0.03 if l2 is l else 0): best, bd = l2, dist
                    if best is not l: erase.setdefault(l['name'], np.zeros((H, W), bool))[cmk] = True
                    target.setdefault(best['name'], np.zeros((H, W), bool))[cmk] = True
            rest = cm & ~np.isin(top, list(unders.keys()))      # いちばん上が体の層でない所(髪など)は触らない
        erased = {}
        for name, m in erase.items():
            l = by[name]; fp = os.path.join(pdir, l['file']); erased[name] = int(m.sum())
            if a.dry: continue
            bak = os.path.splitext(fp)[0] + '.prepatch.png'
            if not os.path.exists(bak): shutil.copy2(fp, bak)
            if name in target: m = m & ~target[name]
            im = load_rgba(fp, (W, H)); im[..., 3][m] = 0
            Image.fromarray((im * 255 + 0.5).astype(np.uint8), 'RGBA').save(fp)
        if erased: print('[patch] はみ出しを消した層:', erased)
        for name, m in target.items():
            l = by[name]; fp = os.path.join(pdir, l['file'])
            merged[name] = int(m.sum())
            if a.dry: continue
            bak = os.path.splitext(fp)[0] + '.prepatch.png'
            if not os.path.exists(bak): shutil.copy2(fp, bak)
            im = load_rgba(fp, (W, H))
            al = np.clip(cv2.GaussianBlur(m.astype(np.float32), (0, 0), 1.0) * 1.6, 0, 1) * (cv2.dilate(m.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
            im[..., :3] = src[..., :3] * al[..., None] + im[..., :3] * (1 - al[..., None])
            im[..., 3] = np.maximum(im[..., 3], al)
            Image.fromarray((im * 255 + 0.5).astype(np.uint8), 'RGBA').save(fp)
            ys, xs = np.where(im[..., 3] > 0.06)
            nb = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
            if nb != l['bbox']: l['bbox_prepatch'] = l['bbox']; l['bbox'] = nb
        print('[patch] 体の欠けを描き足した層:', merged)
    add(PATCH_PREFIX + 'mouthline', 'patch_mouthline.png', mouth_m, 'head', before='mouth', depth=fdepth, feather=0.6)
    add(PATCH_PREFIX + 'head', 'patch_head.png', head_m, 'head', after=('fronthair', 'head', 'eyes', 'mouth'), depth=min(0.6, fdepth + 0.2))
    for i, l in enumerate(new_layers): l['z'] = i
    print('[patch] 足した層:', added or 'なし', ' z順:', ' < '.join(l['name'] for l in new_layers))

    if not a.dry:
        if not os.path.exists(mp + '.bak'):
            shutil.copy2(mp, mp + '.bak')
        man['layers'] = new_layers
        man['patched'] = {'tool': 'puppet_patch_missing.py', 'added': added, 'merged': merged, 'erased': (erased if a.body == 'merge' and body_comps else {}), 'src': os.path.basename(a.src_img)}
        json.dump(man, open(mp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    if a.preview:
        after = composite(pdir, new_layers, (W, H)) if not a.dry else comp
        def on_grey(x):
            return (x[..., :3] * x[..., 3:4] + 0.82 * (1 - x[..., 3:4]))
        vis = np.concatenate([on_grey(src), on_grey(comp), on_grey(after)], axis=1)
        mk = np.zeros((H, W, 3), np.float32) + 0.82
        mk[head_m] = (0.9, 0.1, 0.1); mk[body_m] = (0.1, 0.3, 0.9); mk[mouth_m] = (0.1, 0.7, 0.1)
        vis = np.concatenate([vis, mk], axis=1)
        Image.fromarray((vis * 255 + 0.5).astype(np.uint8)).save(a.preview)


if __name__ == '__main__':
    main()
