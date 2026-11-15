#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""feel-kit / 自作の comp の「動きの気持ちよさ」の検査。

  # 描き出した動画を測って調べる(音は動画の音声か --audio)
  python lint.py --video render.mp4 [--audio song.wav | audio.json] [--out lint.json] [--md lint.md]
  # comp の文書(JSON)を読んで調べる(描き出さない。キーの書き方の誤りを見つける)
  python lint.py --doc comp.json            # または --comp-id 123 [--api http://127.0.0.1:8002]

動画から見つける物:
  linear     8 コマ以上つづく、速さが一定の動き(直線のまま)。完成版の癖では位置の動きの 85% は加減速つき
  kink       動きの途中で速さが段になって変わる(直線のキーのつぎはぎ。interp: "spline" か 1 本の加減速に)
  short_hold 止めが 1〜3 コマしかない(止まったように見えず、引っかかりに見える。0 コマ = 流すか、6 コマ以上止める)
  dup        動きの途中で前と同じ絵(コマ落ち)
  off_beat   動き出し・速さのピーク・着地のどれも半拍の格子(±2 コマ)に乗っていない大きい動き(音があるとき。情報)
  cut_off    切り替わりが強いドラムの立ち上がり(±2 コマ)から外れている(情報)
文書から見つける物:
  ease_on_last_key  最後のキーに書いた加減速(効かない。「着地の側に書く」つもりなら 1 区間ずれている)
  unknown_ease      エンジンに無い名前(黙って直線になる)
  linear_chain      位置・拡大・回転のキーが 3 個以上、全部直線(折れる)→ interp: "spline"
  linear_move       2 キーの直線の動き(12 コマ以上・位置/拡大/回転)
  ease_no_change    加減速を書いた区間の両端が同じ値(効いていない = 1 区間ずれの印)
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from feel_lib import EASE, Beats, events, fit_easing, load_motion, smooth   # noqa: E402

KNOWN = set(EASE) | {'hold', 'easeIn', 'easeOut', 'easeInOut', 'snap', 'snapHard', 'whipIn', 'whipInHard', 'pass', 'settle', 'overshoot', 'pop', 'spring', 'accelDecel'} | \
    {'ease' + d + k for k in ('Quad', 'Cubic', 'Quart', 'Quint', 'Sine', 'Expo', 'Circ', 'Elastic', 'Back', 'Bounce') for d in ('In', 'Out', 'InOut', 'OutIn')}
MOVE_KEYS = {'position', 'scale', 'rotation', 'anchor', 'target', 'offset', 'zoom'}


# ---------------------------------------------------------------- 文書の検査

def lint_doc(doc):
    data = doc.get('data', doc)
    out = []

    def walk(node, path, name):
        if isinstance(node, dict):
            k = node.get('k')
            if isinstance(k, list) and k and isinstance(k[0], dict) and 'f' in k[0]:
                check(node, k, path, name)
                return
            for key, v in node.items():
                walk(v, path + '.' + key, key)
        elif isinstance(node, list):
            for i, x in enumerate(node):
                lid = x.get('id') if isinstance(x, dict) else None
                walk(x, f'{path}[{lid if lid is not None else i}]', name if not (isinstance(x, dict) and ('type' in x or 'geometry' in x)) else None)

    def check(p, k, path, name):
        n = len(k)
        if n >= 2 and k[-1].get('e') and k[-1]['e'] != 'hold':
            out.append({'kind': 'ease_on_last_key', 'path': path, 'f': k[-1]['f'], 'detail': f"最後のキーの e = {k[-1]['e']} は効かない"})
        for a in k:
            e = a.get('e')
            if isinstance(e, str) and e not in KNOWN:
                out.append({'kind': 'unknown_ease', 'path': path, 'f': a['f'], 'detail': f'{e} はエンジンに無い(直線になる)'})
        for a, b in zip(k, k[1:]):
            if a.get('e') and a['e'] not in ('hold', 'linear') and a.get('v') == b.get('v'):
                out.append({'kind': 'ease_no_change', 'path': path, 'f': a['f'], 'detail': f"{a['f']}→{b['f']} は値が同じなのに e = {a['e']}(1 区間ずれていないか)"})
        if name in MOVE_KEYS and p.get('interp') != 'spline' and not p.get('ignore_mid'):
            lin = [(a, b) for a, b in zip(k, k[1:]) if not a.get('e') and a.get('v') != b.get('v') and b['f'] - a['f'] >= 0.5]
            if n >= 3 and len(lin) >= 2:
                out.append({'kind': 'linear_chain', 'path': path, 'f': k[0]['f'], 'detail': f'キー {n} 個のうち直線の区間 {len(lin)} 個(キーで速さが折れる)→ "interp": "spline"'})
            elif n == 2 and lin and k[1]['f'] - k[0]['f'] >= 12:
                out.append({'kind': 'linear_move', 'path': path, 'f': k[0]['f'], 'detail': f"{k[0]['f']}→{k[1]['f']} が直線({k[1]['f'] - k[0]['f']} コマ)。ゆっくり流す動きでなければ加減速を"})
    walk(data, 'data', None)
    return out


# ---------------------------------------------------------------- 動画の検査

def lint_video(M, B=None, min_px=6.0):
    n = len(M['mag'])
    e = M['mag'] * np.sqrt(M['area'])
    cut = M['cut']
    sp = smooth(e, 3)
    out = []
    ev = events(sp, cut, floor=max(1.5, float(np.percentile(sp, 50)) * 0.4), rel=0.12, min_len=4, gap=1)
    for s, t, pk, pv in ev:
        seg = e[s:t + 1]
        if pv < min_px:
            continue
        fit = fit_easing(np.concatenate([[0], np.cumsum(seg)]))
        if not fit:
            continue
        ends_cut = bool(cut[min(n - 1, t + 1):min(n, t + 3)].any())
        starts_cut = bool(cut[max(0, s - 2):s + 1].any())
        # 直線: 速さのばらつきが小さい
        cv = float(seg.std() / max(1e-6, seg.mean()))
        if t - s + 1 >= 8 and cv < 0.22 and not (starts_cut and ends_cut):
            out.append({'kind': 'linear', 'f0': int(s), 'f1': int(t), 'detail': f'{t - s + 1} コマ、速さ {seg.mean():.0f}px/コマ でほぼ一定(ばらつき {cv:.2f})'})
        # 段: 速さが一定の区間が 2 つ以上、段差で切り替わる
        d = np.diff(seg)
        big = np.nonzero(np.abs(d) > max(4.0, 0.45 * seg.mean()))[0]
        flat = [i for i in big if 3 <= i < len(seg) - 4 and seg[i - 3:i + 1].std() < 0.18 * seg[i - 3:i + 1].mean() + 1 and seg[i + 1:i + 5].std() < 0.18 * seg[i + 1:i + 5].mean() + 1]
        if flat:
            out.append({'kind': 'kink', 'f0': int(s), 'f1': int(t), 'detail': '速さが段で変わる: コマ ' + ', '.join(str(int(s + i + 1)) for i in flat[:6])})
        if B is not None and pv >= 20:
            a, b, c = B.to_grid(s), B.to_grid(t), B.to_grid(pk)
            if min(abs(a), abs(b), abs(c)) > 2.5 and not starts_cut and not ends_cut:
                out.append({'kind': 'off_beat', 'f0': int(s), 'f1': int(t), 'detail': f'半拍から: 動き出し {a:+.0f}・ピーク {c:+.0f}・着地 {b:+.0f} コマ(どれも ±2 の外)'})
    # 短い止め
    for (s0, t0, _, v0), (s1, t1, _, v1) in zip(ev, ev[1:]):
        gap = s1 - t0 - 1
        if 1 <= gap <= 3 and min(v0, v1) >= min_px and not cut[t0:s1 + 1].any() and e[t0 + 1:s1].max() < 0.25 * min(v0, v1):
            out.append({'kind': 'short_hold', 'f0': int(t0), 'f1': int(s1), 'detail': f'止めが {gap} コマ(流すか、6 コマ以上止める)'})
    # コマ落ち
    mv = M['mag'] > 1.5
    dup = M['dup'] > 0.5
    for i in range(2, n - 2):
        if dup[i] and mv[i - 2:i].any() and mv[i + 1:i + 3].any():
            out.append({'kind': 'dup', 'f0': i, 'f1': i, 'detail': '動きの途中で前と同じ絵'})
    if B is not None and 'drums' in B.on and len(B.on['drums']):
        o = B.on['drums']
        strong = o[o[:, 1] >= np.percentile(o[:, 1], 40)][:, 0]
        for c in np.nonzero(cut > 0.5)[0]:
            dd = float(c - strong[np.argmin(np.abs(strong - c))])
            if abs(dd) > 2.5:
                out.append({'kind': 'cut_off', 'f0': int(c), 'f1': int(c), 'detail': f'いちばん近い強いドラムの立ち上がりから {dd:+.0f} コマ'})
    return sorted(out, key=lambda r: r['f0']), ev


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--video')
    ap.add_argument('--npz')
    ap.add_argument('--audio')
    ap.add_argument('--doc')
    ap.add_argument('--comp-id', type=int)
    ap.add_argument('--api', default='http://127.0.0.1:8002')
    ap.add_argument('--out')
    ap.add_argument('--md')
    a = ap.parse_args()
    res = {}
    if a.doc or a.comp_id:
        doc = json.load(open(a.doc)) if a.doc else json.load(urllib.request.urlopen(f'{a.api}/api/comps/{a.comp_id}', timeout=60))
        res['doc'] = lint_doc(doc)
    if a.video or a.npz:
        tmp = tempfile.mkdtemp()
        npz = a.npz
        if not npz:
            npz = os.path.join(tmp, 'm.npz')
            subprocess.run([sys.executable, os.path.join(HERE, 'motion_feat.py'), a.video, '--out', npz], check=True, stdout=subprocess.DEVNULL)
        B = None
        aud = a.audio or a.video
        if aud:
            aj = aud
            if not aud.endswith('.json'):
                aj = os.path.join(tmp, 'a.json')
                r = subprocess.run([sys.executable, os.path.join(HERE, 'audio_feat.py'), aud, '--out', aj], capture_output=True, text=True)
                aj = aj if r.returncode == 0 and os.path.exists(aj) else None
            B = Beats(aj) if aj else None
        res['video'], ev = lint_video(load_motion(npz), B)
        res['events'] = len(ev)
    kinds = {}
    for part in ('doc', 'video'):
        for r in res.get(part, []):
            kinds[r['kind']] = kinds.get(r['kind'], 0) + 1
    res['summary'] = kinds
    print(json.dumps(kinds, ensure_ascii=False))
    if a.out:
        json.dump(res, open(a.out, 'w'), ensure_ascii=False, indent=1)
    lines = ['# 動きの検査(feel-kit lint)', '', '数: ' + ' / '.join(f'{k} {v}' for k, v in kinds.items()), '']
    if res.get('doc'):
        lines += ['## 文書', '| 種類 | 場所 | コマ | 内容 |', '|---|---|---|---|'] + [f"| {r['kind']} | {r['path']} | {r['f']} | {r['detail']} |" for r in res['doc']] + ['']
    if res.get('video'):
        lines += ['## 動画', '| 種類 | コマ | 内容 |', '|---|---|---|'] + [f"| {r['kind']} | {r['f0']}〜{r['f1']} | {r['detail']} |" for r in res['video']]
    if a.md:
        open(a.md, 'w').write('\n'.join(lines) + '\n')
    elif not a.out:
        print('\n'.join(lines[:60]))


if __name__ == '__main__':
    main()
