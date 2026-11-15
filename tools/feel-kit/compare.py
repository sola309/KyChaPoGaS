#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""feel-kit / 手本と再現の動きを区間ごとに比べ、「ぎこちない順」の一覧を作る。

  python compare.py --ref final.npz --test v4.npz --audio audio.json --out cmp_v4.json [--md cmp_v4.md] [--by bar|cut|N]

区間(既定 = 小節。--by cut = 手本の切り替わりごと / 数 = そのコマ数ごと)ごとに:
  corr      速さの曲線(動きの量 = 速さ × 面積)の相関。1 = 同じ形
  lag       ピークのずれ(コマ。正 = 再現が遅い)。相互相関の最大の位置(±15)
  amount    動きの量の比(再現 / 手本)
  cen_d     動きの重心の時刻の差(コマ。正 = 再現のほうが後ろ寄り = 入りが遅い・抜きが短い)
  jerk      速さの毎コマのがたつき(|2 階の差| の平均 / 速さの平均)。手本と再現
  dup       動きの途中の「前と同じ絵」のコマ数(コマ落ち)
  cut_d     切り替わりの時刻のずれ(手本の各カットにいちばん近い再現のカットまでのコマ)
  score     ぎこちなさ = 手本の動きの量の重み × (1 - corr) + |lag|/15 + がたつきの超過 + コマ落ち
"""
import argparse
import json

import numpy as np

from feel_lib import Beats, events, fit_easing, load_motion, smooth


def energy(m):
    return m['mag'] * np.sqrt(m['area'])


def window_metrics(R, T, a, b):
    er, et = energy(R)[a:b], energy(T)[a:b]
    out = {'f0': int(a), 'f1': int(b)}
    sr, st = smooth(er, 3), smooth(et, 3)
    if sr.std() < 1e-6 or st.std() < 1e-6:
        out.update(corr=0.0 if (sr.mean() > 0.3 or st.mean() > 0.3) else 1.0, lag=0)
    else:
        out['corr'] = round(float(np.corrcoef(sr, st)[0, 1]), 3)
        best, bl = -2, 0
        for L in range(-15, 16):
            x = sr[max(0, -L):len(sr) - max(0, L)]
            y = st[max(0, L):len(st) - max(0, -L)]
            if len(x) > 8 and x.std() > 1e-6 and y.std() > 1e-6:
                c = float(np.corrcoef(x, y)[0, 1])
                if c > best + 0.02 or (abs(c - best) <= 0.02 and abs(L) < abs(bl)):
                    best, bl = c, L
        out['lag'], out['corr_lag'] = int(bl), round(best, 3)
    out['ref_amount'] = round(float(er.mean()), 2)
    out['test_amount'] = round(float(et.mean()), 2)
    out['amount'] = round(float(et.mean() / max(0.05, er.mean())), 2)
    idx = np.arange(b - a)
    cr = float((idx * er).sum() / max(1e-6, er.sum()))
    ct = float((idx * et).sum() / max(1e-6, et.sum()))
    out['cen_d'] = round(ct - cr, 1)

    def jerk(e):
        return round(float(np.abs(np.diff(e, 2)).mean() / max(0.2, e.mean())), 3)
    out['jerk_ref'], out['jerk_test'] = jerk(er), jerk(et)
    mvt = T['mag'][a:b] > 1.5
    dup = T['dup'][a:b] > 0.5
    # 動きの途中のコマ落ち: 前後 2 コマが動いているのに同じ絵
    k = 0
    for i in range(2, b - a - 2):
        if dup[i] and (mvt[i - 2:i].any() and mvt[i + 1:i + 3].any()):
            k += 1
    out['dup'] = k
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True)
    ap.add_argument('--test', required=True)
    ap.add_argument('--audio', default=None)
    ap.add_argument('--by', default='bar')
    ap.add_argument('--out', required=True)
    ap.add_argument('--md', default=None)
    ap.add_argument('--label', default='再現')
    a = ap.parse_args()
    R, T = load_motion(a.ref), load_motion(a.test)
    n = min(len(R['mag']), len(T['mag']))
    B = Beats(a.audio) if a.audio else None
    if a.by == 'cut':
        edges = [0] + [int(i) for i in np.nonzero(R['cut'][:n] > 0.5)[0]] + [n]
    elif a.by == 'bar' and B is not None:
        edges = [0] + [int(round(x)) for x in B.down if 0 < x < n] + [n]
    else:
        st = int(a.by) if a.by.isdigit() else 96
        edges = list(range(0, n, st)) + [n]
    edges = sorted(set(edges))
    rc = np.nonzero(R['cut'][:n] > 0.5)[0]
    tc = np.nonzero(T['cut'][:n] > 0.5)[0]
    tot = float(energy(R)[:n].mean()) or 1
    rows = []
    for i in range(len(edges) - 1):
        f0, f1 = edges[i], edges[i + 1]
        if f1 - f0 < 8:
            continue
        w = window_metrics(R, T, f0, f1)
        cd = []
        for c in rc[(rc >= f0) & (rc < f1)]:
            d = tc - c
            j = int(np.argmin(np.abs(d))) if len(d) else None
            if j is None or abs(int(d[j])) > 30:
                cd.append([int(c), None])
            elif d[j] != 0:
                cd.append([int(c), int(d[j])])
        w['cut_d'] = cd
        extra = [int(c) for c in tc[(tc >= f0) & (tc < f1)] if len(rc) == 0 or np.min(np.abs(rc - c)) > 30]
        w['cut_extra'] = extra
        wt = min(3.0, w['ref_amount'] / tot)
        w['score'] = round(wt * (1 - max(0.0, w['corr'])) + abs(w['lag']) / 15 * min(1, wt) + max(0.0, w['jerk_test'] - w['jerk_ref']) * min(1, wt)
                           + 0.15 * w['dup'] + 0.2 * len([c for c in cd if c[1] is None or abs(c[1]) >= 3]) + 0.1 * len(extra), 3)
        if B is not None:
            w['bar'] = B.bar_of(f0 + 1)
        rows.append(w)
    rank = sorted(rows, key=lambda r: -r['score'])
    summ = {'frames': n, 'windows': len(rows),
            'corr_all': round(float(np.corrcoef(smooth(energy(R)[:n]), smooth(energy(T)[:n]))[0, 1]), 3),
            'corr_median': round(float(np.median([r['corr'] for r in rows])), 3),
            'corr_weighted': round(float(sum(r['corr'] * r['ref_amount'] for r in rows) / max(1e-6, sum(r['ref_amount'] for r in rows))), 3),
            'bad_windows(corr<0.5)': sum(1 for r in rows if r['corr'] < 0.5),
            'abs_lag_mean': round(float(np.mean([abs(r['lag']) for r in rows])), 2),
            'dup_total': int(sum(r['dup'] for r in rows)), 'score_sum': round(float(sum(r['score'] for r in rows)), 2),
            'jerk_ref': round(float(np.mean([r['jerk_ref'] for r in rows])), 3), 'jerk_test': round(float(np.mean([r['jerk_test'] for r in rows])), 3),
            'cut_shift': sum(len(r['cut_d']) for r in rows), 'cut_extra': sum(len(r['cut_extra']) for r in rows)}
    json.dump({'summary': summ, 'rows': rows, 'rank': [[r['f0'], r['f1'], r['score']] for r in rank]}, open(a.out, 'w'), ensure_ascii=False, indent=0)
    print(json.dumps(summ, ensure_ascii=False))
    if a.md:
        L = [f'# ぎこちない順の一覧({a.label} と 手本)', '', '全体: ' + ' / '.join(f'{k} = {v}' for k, v in summ.items()), '',
             '| 順 | コマ | 小節 | score | 速さ曲線の相関 | ピークのずれ | 動きの量の比 | 重心の差 | がたつき 手本→再現 | コマ落ち | 切り替わりのずれ |', '|---|---|---|---|---|---|---|---|---|---|---|']
        for i, r in enumerate(rank):
            cd = ' '.join(f"{c}:{'無' if d is None else f'{d:+d}'}" for c, d in r['cut_d']) + (' 余分 ' + ','.join(map(str, r['cut_extra'])) if r['cut_extra'] else '')
            L.append(f"| {i + 1} | {r['f0']}〜{r['f1']} | {r.get('bar', '')} | {r['score']} | {r['corr']} | {r['lag']:+d} | {r['amount']} | {r['cen_d']:+.1f} | {r['jerk_ref']}→{r['jerk_test']} | {r['dup']} | {cd} |")
        open(a.md, 'w').write('\n'.join(L) + '\n')


if __name__ == '__main__':
    main()
