#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""パペット(backend/data/puppets/<id>/ の manifest + 層の PNG)に、腕・脚を曲げるための関節・ボーン・頂点ウェイトを足す。

  make_bones.py <puppet_dir> [--pose keypoints.json] [--debug out.jpg] [--cell 12]

書くもの(既存の manifest・PNG には触らない):
  <puppet_dir>/bones.json   関節(canvas の px)・ボーン・層ごとの格子と頂点ウェイト(人が直せる)
  <puppet_dir>/bones.png    bones.json の写し(バイト列を RGB の画素に詰めた PNG)。いまの /api/puppet/<id>/layer/ は .png しか返さないので、
                            comp-kit の puppet.js はこちらを読む

関節の決め方:
  1. 層の形から(手続き): handwear(腕)・legwear(脚)・footwear(足)を体の中心線で左右に分け、それぞれの中心線(骨の通り道)を測る。
     肩 = 腕の付け根側の端から少し入った所、手首 = 手の手前、ひじ = 肩〜手首のまん中。股 = 脚の上端から少し下、足首 = 足(footwear)の上端、ひざ = 股〜足首のまん中。
  2. --pose があれば(pose_sdpose.py の出力 = OpenPose の 18 点)、信頼度の高い点を優先し、層の中心線の上へ寄せる(アニメ絵では姿勢推定が外へずれるため)。
左右の名前: _l = 本人の左 = 画面の右(comp-kit のマネキンと同じ)。
依存: PIL + numpy だけ。
"""
import argparse
import json
import os
import struct

import numpy as np
from PIL import Image, ImageDraw


def sstep(u):
    u = np.clip(u, 0.0, 1.0)
    return u * u * (3 - 2 * u)


def load_alpha(pdir, layer):
    return np.array(Image.open(os.path.join(pdir, layer['file'])).convert('RGBA'))[..., 3] > 96


def medial(mask, start_hint):
    """マスクの中心線。主軸に沿って並べた点の列 [(x, y, 幅)]。start_hint に近い端が先頭。"""
    ys, xs = np.nonzero(mask)
    if len(xs) < 40:
        return None
    pts = np.stack([xs, ys], 1).astype(float)
    c = pts.mean(0)
    w, v = np.linalg.eigh(np.cov((pts - c).T))
    ax = v[:, 1]
    perp = np.array([-ax[1], ax[0]])
    t = (pts - c) @ ax
    u = (pts - c) @ perp
    n = max(8, int((t.max() - t.min()) / 4))
    edges = np.linspace(t.min(), t.max() + 1e-6, n + 1)
    idx = np.clip(np.digitize(t, edges) - 1, 0, n - 1)
    out = []
    for i in range(n):
        m = idx == i
        if m.sum() < 3:
            continue
        tm, um = t[m].mean(), np.median(u[m])
        p = c + ax * tm + perp * um
        out.append((p[0], p[1], u[m].max() - u[m].min() + 1))
    out = np.array(out)
    # なめらかに
    k = np.ones(5) / 5
    if len(out) > 8:
        pad = np.pad(out, ((2, 2), (0, 0)), mode='edge')
        out = np.stack([np.convolve(pad[:, j], k, mode='valid') for j in range(3)], 1)
    if np.hypot(*(out[0, :2] - start_hint)) > np.hypot(*(out[-1, :2] - start_hint)):
        out = out[::-1]
    return out


def at(line, f):
    """中心線の長さの割合 f(0〜1)の点"""
    d = np.r_[0, np.cumsum(np.hypot(np.diff(line[:, 0]), np.diff(line[:, 1])))]
    s = f * d[-1]
    return np.array([np.interp(s, d, line[:, 0]), np.interp(s, d, line[:, 1])])


def snap(line, p, lo=0.0, hi=1.0):
    """点 p にいちばん近い中心線の上の点(割合 lo〜hi の範囲)→ (点, 割合)"""
    fs = np.linspace(lo, hi, 200)
    pts = np.array([at(line, f) for f in fs])
    i = np.argmin(np.hypot(pts[:, 0] - p[0], pts[:, 1] - p[1]))
    return pts[i], fs[i]


def chain_param(P, joints):
    """点 P(n×2)を折れ線 joints(k×2)に射影 → (どの節か + 節の中の割合) の通し番号 t。
    先頭の節は手前へ(t < 0)、最後の節は先へ(t > k-1)のばして測る。"""
    k = len(joints) - 1
    best_d = np.full(len(P), 1e18)
    best_t = np.zeros(len(P))
    for i in range(k):
        a, b = joints[i], joints[i + 1]
        ab = b - a
        L2 = max(1e-6, ab @ ab)
        u = ((P - a) @ ab) / L2
        uc = np.clip(u, -1e9 if i == 0 else 0, 1e9 if i == k - 1 else 1)
        q = a + uc[:, None] * ab
        d = np.hypot(*(P - q).T)
        m = d < best_d
        best_d[m] = d[m]
        best_t[m] = i + uc[m]
    return best_t


def limb_weights(P, joints, width):
    """腕・脚 1 本ぶんの頂点ウェイト。ボーン = [親, 節 0, 節 1, 節 2]。関節の前後 width×0.5 の幅でなめらかに混ぜる。"""
    k = len(joints) - 1
    t = chain_param(P, joints)
    lens = [np.hypot(*(joints[i + 1] - joints[i])) for i in range(k)]
    W = np.zeros((len(P), k + 1))
    # 付け根: 関節 0 の手前(体の中)は親に付く
    b0 = 0.5 * width / max(1.0, lens[0])
    wp = 1 - sstep((t + b0) / (1.3 * b0))
    cur = np.ones(len(P))
    for i in range(1, k):
        b = 0.5 * width / max(1.0, 0.5 * (lens[i - 1] + lens[i]))
        up = sstep((t - (i - b)) / (2 * b))
        W[:, i] = cur * (1 - up)
        cur = cur * up
    W[:, k] = cur
    W[:, 1:] *= (1 - wp)[:, None]
    W[:, 0] = wp
    return W


def grid(box, cell, canvas):
    l, t, r, b = max(0, box[0] - 4), max(0, box[1] - 4), min(canvas[0], box[2] + 4), min(canvas[1], box[3] + 4)
    nx = int(np.clip(round((r - l) / cell) + 1, 4, 28))
    ny = int(np.clip(round((b - t) / cell) + 1, 4, 64))
    xs, ys = np.linspace(l, r, nx), np.linspace(t, b, ny)
    P = np.array([[x, y] for y in ys for x in xs])
    return {'nx': nx, 'ny': ny, 'box': [float(l), float(t), float(r), float(b)]}, P


def bbox_of(mask):
    ys, xs = np.nonzero(mask)
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def pack(pdir, js):
    """bones.json の写し: 長さ(4 バイト・ビッグエンディアン)+ UTF-8 の JSON を RGB の画素に詰める(幅 256)"""
    json.loads(js)
    raw = js.encode('utf-8')
    data = struct.pack('>I', len(raw)) + raw
    w = 256
    h = (len(data) + w * 3 - 1) // (w * 3)
    data += b'\0' * (w * h * 3 - len(data))
    Image.frombytes('RGB', (w, h), data).save(os.path.join(pdir, 'bones.png'), optimize=True)
    print(f'bones.json {len(raw)} bytes → bones.png {w}x{h}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('puppet_dir')
    ap.add_argument('--pose', help='pose_sdpose.py の出力(OpenPose 18 点)')
    ap.add_argument('--debug', help='関節と中心線を重ねた確認用の絵')
    ap.add_argument('--cell', type=float, default=12, help='格子の 1 升の大きさ(px)')
    ap.add_argument('--repack', action='store_true', help='手で直した bones.json を bones.png に詰め直すだけ')
    a = ap.parse_args()
    pdir = a.puppet_dir.rstrip('/')
    if a.repack:
        pack(pdir, open(os.path.join(pdir, 'bones.json'), encoding='utf-8').read())
        return
    man = json.load(open(os.path.join(pdir, 'manifest.json'), encoding='utf-8'))
    cw, ch = man['canvas']
    L = {l['name']: l for l in man['layers']}
    piv = man.get('pivots', {})
    neck = np.array(piv.get('head', [cw / 2, ch * 0.28]), float)
    notes = []

    # 体の中心線(x)。胴(topwear)があればその中心、無ければ首
    cx = neck[0]
    if 'topwear' in L:
        bb = L['topwear']['bbox']
        cx = 0.5 * (cx + (bb[0] + bb[2]) / 2)
    X, Y = np.meshgrid(np.arange(cw), np.arange(ch))

    kp = None
    if a.pose:
        kd = json.load(open(a.pose, encoding='utf-8'))
        kp = {k: (np.array(v[:2], float), float(v[2])) for k, v in kd['points'].items()}
    # 姿勢推定の点(信頼度 0.3 以上)を取る。画像の左右 → 本人の左右は入れ替わる(OpenPose の R = 本人の右 = 画面の左)
    def est(name):
        if not kp or name not in kp or kp[name][1] < 0.3:
            return None
        return kp[name][0]

    J = {'neck': neck}
    lines = {}
    skins = []

    # ---- 腕(handwear)----
    arm = load_alpha(pdir, L['handwear']) if 'handwear' in L else None
    for side, sgn in (('l', 1), ('r', -1)):
        if arm is None:
            break
        m = arm & ((X - cx) * sgn > 0)
        if m.sum() < 200:
            notes.append(f'腕 {side}: handwear のこの側に絵が無い')
            continue
        line = medial(m, neck + np.array([sgn * 60, 20]))
        lines['arm_' + side] = line
        width = float(np.median(line[:, 2]))
        sh, el, wr = at(line, 0.07), None, at(line, 0.86)
        e_sh, e_el, e_wr = est('shoulder_' + side), est('elbow_' + side), est('wrist_' + side)
        used = []
        if e_sh is not None and np.hypot(*(e_sh - sh)) < 0.25 * np.hypot(*(wr - sh)):
            sh, _ = snap(line, e_sh, 0.0, 0.25); used.append('肩')
        if e_wr is not None:
            wr, _ = snap(line, e_wr, 0.6, 0.95); used.append('手首')
        if e_el is not None:
            el, f = snap(line, e_el, 0.3, 0.7); used.append('ひじ')
        if el is None:
            # ひじ = 肩〜手首の中心線のまん中(上腕と前腕はほぼ同じ長さ)
            _, f0 = snap(line, sh, 0, 0.3); _, f1 = snap(line, wr, 0.6, 1)
            el = at(line, f0 + (f1 - f0) * 0.5)
        tip = at(line, 1.0)
        J.update({'shoulder_' + side: sh, 'elbow_' + side: el, 'wrist_' + side: wr, 'hand_' + side: tip})
        notes.append(f'腕 {side}: 層の中心線' + (' + 姿勢推定(' + '・'.join(used) + ')' if used else ''))
        g, P = grid(bbox_of(m), a.cell, (cw, ch))
        W = limb_weights(P, np.array([sh, el, wr, tip]), width)
        skins.append({'layer': 'handwear', 'side': side, 'clip': [sgn, 0, -sgn * cx], 'bones': ['chest', 'upper_arm_' + side, 'forearm_' + side, 'hand_' + side],
                      'grid': g, 'width': round(width, 1), 'weights': np.round(W, 3).flatten().tolist()})

    # ---- 脚(legwear)+ 足(footwear)----
    leg = load_alpha(pdir, L['legwear']) if 'legwear' in L else None
    foot = load_alpha(pdir, L['footwear']) if 'footwear' in L else None
    both = None if leg is None else (leg | foot if foot is not None else leg)
    split = [0.0, cx]  # x = a·y + b(左右の脚の間の線)
    if both is not None:
        gy, gx = [], []
        bb = bbox_of(both)
        for y in range(bb[1], bb[3], 3):
            xs = np.nonzero(both[y])[0]
            if len(xs) < 4:
                continue
            gaps = np.nonzero(np.diff(xs) > 2)[0]
            if len(gaps) == 1:
                gy.append(y); gx.append((xs[gaps[0]] + xs[gaps[0] + 1]) / 2)
        if len(gy) >= 8:
            sa, sb = np.polyfit(gy, gx, 1)
            split = [float(sa), float(sb)]
        else:
            split = [0.0, float((bb[0] + bb[2]) / 2)]
            notes.append('脚: 左右のすき間が見つからない(長いスカートなど)→ まん中で分けた')
        for side, sgn in (('l', 1), ('r', -1)):
            m = both & ((X - split[0] * Y - split[1]) * sgn > 0)
            if m.sum() < 200:
                notes.append(f'脚 {side}: この側に絵が無い')
                continue
            top_hint = np.array([cx + sgn * 40, bb[1]])
            line = medial(m, top_hint)
            lines['leg_' + side] = line
            width = float(np.median(line[:, 2]))
            hip, an = at(line, 0.10), at(line, 0.90)
            if foot is not None:
                fm = foot & ((X - split[0] * Y - split[1]) * sgn > 0)
                if fm.sum() > 50:
                    fb = bbox_of(fm)
                    an, _ = snap(line, np.array([(fb[0] + fb[2]) / 2, fb[1] + 0.15 * (fb[3] - fb[1])]), 0.6, 1.0)
            used = []
            e_hip, e_kn, e_an = est('hip_' + side), est('knee_' + side), est('ankle_' + side)
            if e_hip is not None:
                hip, _ = snap(line, e_hip, 0.0, 0.3); used.append('股')
            if e_an is not None:
                an, _ = snap(line, e_an, 0.7, 1.0); used.append('足首')
            _, f0 = snap(line, hip, 0, 0.35); _, f1 = snap(line, an, 0.6, 1)
            kn = at(line, f0 + (f1 - f0) * 0.5)
            if e_kn is not None:
                kn, _ = snap(line, e_kn, f0 + (f1 - f0) * 0.3, f0 + (f1 - f0) * 0.7); used.append('ひざ')
            # つま先 = この側のいちばん下
            ys, xs = np.nonzero(m)
            lowest = ys.max()
            toe = np.array([xs[ys > lowest - 6].mean(), float(lowest)])
            J.update({'hip_' + side: hip, 'knee_' + side: kn, 'ankle_' + side: an, 'toe_' + side: toe})
            notes.append(f'脚 {side}: 層の中心線' + (' + 姿勢推定(' + '・'.join(used) + ')' if used else ''))
            clip = [sgn, -sgn * split[0], -sgn * split[1]]
            for lname, mk in (('legwear', leg), ('footwear', foot)):
                if mk is None:
                    continue
                mm = mk & ((X - split[0] * Y - split[1]) * sgn > 0)
                if mm.sum() < 30:
                    continue
                g, P = grid(bbox_of(mm), a.cell, (cw, ch))
                W = limb_weights(P, np.array([hip, kn, an, toe]), width)
                skins.append({'layer': lname, 'side': side, 'clip': clip, 'bones': ['pelvis', 'thigh_' + side, 'shin_' + side, 'foot_' + side],
                              'grid': g, 'width': round(width, 1), 'weights': np.round(W, 3).flatten().tolist()})

    # ---- 腰(上半身を曲げる軸)----
    if 'hip_l' in J and 'hip_r' in J:
        hipc = (J['hip_l'] + J['hip_r']) / 2
    else:
        hipc = np.array([cx, neck[1] + 0.33 * (ch - neck[1])])
    waist = np.array([cx, neck[1] + 0.72 * (hipc[1] - neck[1])])
    e_w = None
    J['waist'] = waist
    J['pelvis'] = hipc
    band = 0.16 * (hipc[1] - neck[1])

    # 胴(topwear): 上は胸、下は腰に付く
    if 'topwear' in L:
        g, P = grid(L['topwear']['bbox'], a.cell * 1.5, (cw, ch))
        wp = sstep((P[:, 1] - (waist[1] - band)) / (2 * band))
        skins.append({'layer': 'topwear', 'side': None, 'clip': None, 'bones': ['chest', 'pelvis'], 'grid': g,
                      'weights': np.round(np.stack([1 - wp, wp], 1), 3).flatten().tolist()})
    # 腰の服(bottomwear): 上は腰、下は左右のももについて行く
    if 'bottomwear' in L and 'hip_l' in J and 'hip_r' in J:
        bb = L['bottomwear']['bbox']
        g, P = grid(bb, a.cell, (cw, ch))
        hy = hipc[1]
        down = sstep((P[:, 1] - hy) / max(1.0, bb[3] - hy)) * 0.9
        bw = max(4.0, 0.12 * abs(J['hip_l'][0] - J['hip_r'][0]))
        sl = sstep((P[:, 0] - split[0] * P[:, 1] - split[1] + bw) / (2 * bw))
        W = np.stack([1 - down, down * sl, down * (1 - sl)], 1)
        skins.append({'layer': 'bottomwear', 'side': None, 'clip': None, 'bones': ['pelvis', 'thigh_l', 'thigh_r'], 'grid': g,
                      'weights': np.round(W, 3).flatten().tolist()})

    bones = [{'name': 'pelvis', 'parent': None, 'joint': 'pelvis'}, {'name': 'chest', 'parent': 'pelvis', 'joint': 'waist', 'angle': 'waist'}]
    for s in ('l', 'r'):
        if 'shoulder_' + s in J:
            bones += [{'name': 'upper_arm_' + s, 'parent': 'chest', 'joint': 'shoulder_' + s, 'to': 'elbow_' + s, 'angle': 'shoulder_' + s},
                      {'name': 'forearm_' + s, 'parent': 'upper_arm_' + s, 'joint': 'elbow_' + s, 'to': 'wrist_' + s, 'angle': 'elbow_' + s},
                      {'name': 'hand_' + s, 'parent': 'forearm_' + s, 'joint': 'wrist_' + s, 'to': 'hand_' + s, 'angle': 'wrist_' + s}]
        if 'hip_' + s in J:
            bones += [{'name': 'thigh_' + s, 'parent': 'pelvis', 'joint': 'hip_' + s, 'to': 'knee_' + s, 'angle': 'hip_' + s},
                      {'name': 'shin_' + s, 'parent': 'thigh_' + s, 'joint': 'knee_' + s, 'to': 'ankle_' + s, 'angle': 'knee_' + s},
                      {'name': 'foot_' + s, 'parent': 'shin_' + s, 'joint': 'ankle_' + s, 'to': 'toe_' + s, 'angle': 'ankle_' + s}]
    # 腰から上に乗る層(それ以外は腰 = いままでどおりの体)
    lower = [n for n in ('legwear', 'footwear', 'bottomwear') if n in L]
    out = {'version': 1, 'puppet_id': man.get('id'), 'canvas': [cw, ch],
           'source': {'tool': 'tools/pose-kit/make_bones.py', 'pose': os.path.basename(a.pose) if a.pose else None, 'notes': notes},
           'joints': {k: [round(float(v[0]), 1), round(float(v[1]), 1)] for k, v in J.items()},
           'bones': bones, 'lower_layers': lower, 'skins': skins}
    js = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(pdir, 'bones.json'), 'w', encoding='utf-8') as f:
        f.write(js)
    pack(pdir, js)
    print(f'関節 {len(J)} / skin {len(skins)}')
    for n in notes:
        print('  ' + n)

    if a.debug:
        im = Image.new('RGBA', (cw, ch), (120, 150, 120, 255))
        for l in sorted(man['layers'], key=lambda x: x['z']):
            im.alpha_composite(Image.open(os.path.join(pdir, l['file'])).convert('RGBA'))
        d = ImageDraw.Draw(im)
        for line in lines.values():
            d.line([(p[0], p[1]) for p in line], fill=(255, 255, 0, 255), width=2)
        d.line([(split[0] * 0 + split[1], 0), (split[0] * ch + split[1], ch)], fill=(0, 255, 255, 120), width=1)
        for b in bones:
            if 'to' in b:
                d.line([tuple(J[b['joint']]), tuple(J[b['to']])], fill=(0, 80, 255, 255), width=3)
        for k, v in J.items():
            d.ellipse([v[0] - 5, v[1] - 5, v[0] + 5, v[1] + 5], fill=(255, 40, 40, 255), outline=(255, 255, 255, 255))
        if kp:
            for k, (p, s) in kp.items():
                d.rectangle([p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4], outline=(255, 0, 255, 255), width=2)
        im.convert('RGB').save(a.debug, quality=92)


if __name__ == '__main__':
    main()
