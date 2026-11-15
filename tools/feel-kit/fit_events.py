#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""feel-kit / 測った動き(motion_feat.py の npz)から「動きの出来事」を切り出し、どのイージングに当たるかを推定する。

  python fit_events.py final.npz [--range 3380 3640] [--chan auto|gtx|gty|gscale|grot|mag] [--audio audio.json] [--base 3389] [--json out.json]

1 行 = 1 つの出来事(止まり → 動き → 止まり、または切り替わりまで):
  コマ(始まり〜終わり・ピーク)/ 長さ / 量(px・倍・度)/ 当てはまる式(次点)/ t50(半分まで進む時刻の割合。0.5 = 対称、小さい = 頭が速い)/
  行き過ぎ(%)と戻りのコマ / 残り 10% にかけたコマ / (--audio)始まり・終わりがいちばん近い半拍から何コマか
--chan auto は 平行移動(主な向きに射影)・拡大・回転 のうち、その区間でいちばん大きく動いた成分を使う。--base を付けると comp の中のコマ(= 全体のコマ - base)も出す。
"""
import argparse
import json

import numpy as np

from feel_lib import Beats, events, fit_easing, load_motion, smooth


def channel(M, a, b, chan):
    """→ (名前, 1 コマごとの符号つきの速さ, 単位)"""
    W = float(M['width'])
    tx, ty = M['gtx'][a:b].astype(float), M['gty'][a:b].astype(float)
    sc = np.log(np.clip(M['gscale'][a:b].astype(float), 0.5, 2.0))
    rot = M['grot'][a:b].astype(float)
    # 平行移動は主な向きへ射影
    v = np.stack([tx, ty], 1)
    if np.abs(v).sum() > 0:
        u, s, vt = np.linalg.svd(v - 0 * v.mean(0), full_matrices=False)
        d = vt[0]
        if (v @ d).sum() < 0:
            d = -d
        tr = v @ d
    else:
        d, tr = np.array([1.0, 0.0]), tx
    c = {'move': (tr, 'px'), 'gtx': (tx, 'px'), 'gty': (ty, 'px'), 'gscale': (sc * 100, '%'), 'grot': (rot, '度'), 'mag': (M['mag'][a:b] * np.sqrt(M['area'][a:b]), 'px')}
    if chan == 'auto':
        # 画面の端での見かけの動きに直して比べる
        amt = {'move': np.abs(tr).sum(), 'gscale': np.abs(sc).sum() * W / 2, 'grot': np.abs(np.radians(rot)).sum() * W / 2}
        chan = max(amt, key=amt.get)
    x, unit = c[chan]
    return chan, x, unit, d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('npz')
    ap.add_argument('--range', type=int, nargs=2)
    ap.add_argument('--chan', default='auto')
    ap.add_argument('--audio')
    ap.add_argument('--base', type=int, default=None)
    ap.add_argument('--floor', type=float, default=None)
    ap.add_argument('--whole', action='store_true', help='区間をまるごと 1 つの出来事として当てはめる')
    ap.add_argument('--json')
    a = ap.parse_args()
    M = load_motion(a.npz)
    f0, f1 = a.range or (0, len(M['mag']))
    chan, x, unit, d = channel(M, f0, f1, a.chan)
    cut = M['cut'][f0:f1]
    x = np.where(cut > 0.5, 0, x)
    B = Beats(a.audio) if a.audio else None
    sp = smooth(np.abs(x), 3)
    floor = a.floor if a.floor is not None else max(0.6 if unit == 'px' else 0.08, float(np.percentile(sp, 60)) * 0.5)
    ev = [(0, f1 - f0 - 1, int(np.argmax(sp)), float(sp.max()))] if a.whole else events(sp, cut, floor=floor, rel=0.1, min_len=4, gap=2)
    print(f'成分 = {chan}({unit})' + (f' 向き = [{d[0]:.2f}, {d[1]:.2f}]' if chan == 'move' else '') + f' しきい値 {floor:.2f} 出来事 {len(ev)}')
    rows = []
    for s, e, pk, pv in ev:
        seg = x[s:e + 1]
        sign = 1 if seg.sum() >= 0 else -1
        p = np.concatenate([[0], np.cumsum(seg)])
        fit = fit_easing(p)
        if not fit:
            continue
        cutend = bool(e + 1 < len(cut) and cut[min(len(cut) - 1, e + 1):e + 3].any())
        cutstart = bool(cut[max(0, s - 2):s + 1].any())
        r = {'f0': f0 + s, 'f1': f0 + e, 'peak': f0 + pk, 'n': e - s + 1, 'amount': round(float(seg.sum()), 1), 'peak_speed': round(pv, 1), 'ends_at_cut': cutend, 'starts_at_cut': cutstart, **fit}
        if B is not None:
            r['start_to_half'] = round(B.to_grid(f0 + s), 1)
            r['end_to_half'] = round(B.to_grid(f0 + e), 1)
            r['peak_to_half'] = round(B.to_grid(f0 + pk), 1)
        rows.append(r)
        base = f' (comp {f0 + s - a.base}〜{f0 + e - a.base})' if a.base is not None else ''
        print(f"{r['f0']}〜{r['f1']}{base} ピーク {r['peak']} | {r['n']} コマ 量 {r['amount']}{unit} 最高 {r['peak_speed']}/コマ | {fit['name']}({fit['rmse']}) 次点 {fit['second']}({fit['rmse2']}) 直線 {fit['linear_rmse']} | t50 {fit['t50']} 行き過ぎ {fit['overshoot'] * 100:.0f}% 戻り {fit['return_frames']} 残り10% {fit['settle_frames']} コマ"
              + (' | 頭が切り替わり' if cutstart else '') + (' | 切り替わりで終わる' if cutend else '')
              + (f" | 半拍から 始 {r['start_to_half']:+.0f} 終 {r['end_to_half']:+.0f} ピーク {r['peak_to_half']:+.0f}" if B is not None else ''))
    if a.json:
        json.dump({'chan': chan, 'unit': unit, 'events': rows}, open(a.json, 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
