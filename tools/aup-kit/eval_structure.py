#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""完成版と再現版を「絵の中身」でなく「構図・動き・タイミング・切り替わり」で比べる。

素材を新しく作り直した再現では、人物の絵も柄も別物なので SSIM / 画素の差は当てにならない。代わりに次を測る(全コマ・小さく縮めて):

 1. 切り替わりの時刻   … 隣のコマとの差(動きの量)の時系列。大きな山(カット・フラッシュ・拭い)の位置が ±2 コマで合うか(適合率・再現率)。
 2. 動きの量の流れ     … 上の時系列どうしの相関(区間ごと)。動く所で動き、止まる所で止まっているか。
 3. 動きの場所         … 画面を 16×9 に分け、各マスの「隣のコマとの差」の地図どうしの相関。どこが動いているか。
 4. 構図(明暗の配置)   … 32×18 に縮めた明るさの地図の相関(大きな形の位置)。
 5. 構図(輪郭の配置)   … 輪郭の強さを 32×18 にまとめた地図の相関(物の縁・字・図形のある場所)。
 6. 色の配分           … 色相 12 分割 × 彩度の重みのヒストグラムの重なり(場面の色の調子)。

出力: 区間(既定 120 コマ)ごとの表(JSON と Markdown)、悪い区間の一覧(目で見る場所の案内)。
数値は「見る場所を決める」ための物で、合否は横並びを目で見て決める。

    python3 eval_structure.py --ref final.mp4 --test repro.mp4 --out eval.json --md eval.md [--offset 0] [--seg 120]
"""
import argparse
import json
import subprocess

import numpy as np

W, H = 96, 54


def read(path, n=None):
    """動画を 96×54 の RGB で全部読む → (N, H, W, 3) uint8"""
    cmd = ['ffmpeg', '-v', 'error', '-i', path, '-vf', f'scale={W}:{H}:flags=area', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    a = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)
    return a[:n] if n else a


def luma(a):
    return (0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]).astype(np.float32)


def pool(x, bh, bw):
    n, h, w = x.shape
    return x.reshape(n, bh, h // bh, bw, w // bw).mean(axis=(2, 4))


def corr_rows(a, b):
    """行ごと(コマごと)の相関係数。平らな地図どうしは 1、片方だけ平らは 0。"""
    a = a.reshape(len(a), -1).astype(np.float64)
    b = b.reshape(len(b), -1).astype(np.float64)
    a = a - a.mean(1, keepdims=True)
    b = b - b.mean(1, keepdims=True)
    sa, sb = np.sqrt((a * a).sum(1)), np.sqrt((b * b).sum(1))
    den = sa * sb
    out = np.where(den > 1e-6, (a * b).sum(1) / np.maximum(den, 1e-6), np.where((sa < 1e-3) & (sb < 1e-3), 1.0, 0.0))
    return out


def edges(y):
    gx = np.abs(np.diff(y, axis=2, prepend=y[:, :, :1]))
    gy = np.abs(np.diff(y, axis=1, prepend=y[:, :1, :]))
    return gx + gy


def hue_hist(a):
    r, g, b = [a[..., i].astype(np.float32) / 255 for i in range(3)]
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    d = mx - mn
    hue = np.zeros_like(mx)
    m = d > 1e-4
    rr = m & (mx == r)
    gg = m & (mx == g) & ~rr
    bb = m & ~rr & ~gg
    hue[rr] = ((g - b)[rr] / d[rr]) % 6
    hue[gg] = (b - r)[gg] / d[gg] + 2
    hue[bb] = (r - g)[bb] / d[bb] + 4
    binx = np.minimum((hue * 2).astype(np.int32), 11)
    n = len(a)
    hist = np.zeros((n, 15), np.float32)
    flat_b = binx.reshape(n, -1)
    flat_s = d.reshape(n, -1)
    for k in range(12):
        hist[:, k] = (flat_s * (flat_b == k)).sum(1)
    yv = mx.reshape(n, -1)
    lows = flat_s < 0.12
    hist[:, 12] = ((yv < 0.33) & lows).sum(1) * 0.3      # 無彩色: 暗・中・明
    hist[:, 13] = ((yv >= 0.33) & (yv < 0.66) & lows).sum(1) * 0.3
    hist[:, 14] = ((yv >= 0.66) & lows).sum(1) * 0.3
    hist /= np.maximum(hist.sum(1, keepdims=True), 1e-6)
    return hist


def peaks(e, thr_k=4.0, win=30):
    """動きの量の山(まわり ±win コマの中央値の thr_k 倍を超え、かつ局所最大)。カット・フラッシュ・速い拭い。"""
    n = len(e)
    out = []
    for i in range(1, n - 1):
        lo, hi = max(0, i - win), min(n, i + win + 1)
        med = np.median(e[lo:hi])
        if e[i] > max(thr_k * med, 6.0) and e[i] >= e[i - 1] and e[i] >= e[i + 1]:
            if out and i - out[-1] < 3:
                if e[i] > e[out[-1]]:
                    out[-1] = i
            else:
                out.append(i)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True)
    ap.add_argument('--test', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--md', default=None)
    ap.add_argument('--offset', type=int, default=0, help='ref のコマ = test のコマ + offset')
    ap.add_argument('--seg', type=int, default=120)
    ap.add_argument('--tol', type=int, default=2)
    a = ap.parse_args()
    R, T = read(a.ref), read(a.test)
    if a.offset > 0:
        R = R[a.offset:]
    elif a.offset < 0:
        T = T[-a.offset:]
    n = min(len(R), len(T))
    R, T = R[:n], T[:n]
    yr, yt = luma(R), luma(T)
    dr = np.abs(np.diff(yr, axis=0, prepend=yr[:1]))
    dt = np.abs(np.diff(yt, axis=0, prepend=yt[:1]))
    er, et = dr.mean(axis=(1, 2)), dt.mean(axis=(1, 2))
    pr, pt = peaks(er), peaks(et)
    hit_r = [p for p in pr if any(abs(p - q) <= a.tol for q in pt)]
    hit_t = [q for q in pt if any(abs(p - q) <= a.tol for p in pr)]
    comp_l = corr_rows(pool(yr, 18, 32), pool(yt, 18, 32))
    comp_e = corr_rows(pool(edges(yr), 18, 32), pool(edges(yt), 18, 32))
    mot = corr_rows(pool(dr, 9, 16), pool(dt, 9, 16))
    hr, ht = hue_hist(R), hue_hist(T)
    col = np.minimum(hr, ht).sum(1)
    segs = []
    for s in range(0, n, a.seg):
        e = min(n, s + a.seg)
        x, y = er[s:e], et[s:e]
        mc = float(np.corrcoef(x, y)[0, 1]) if x.std() > 1e-6 and y.std() > 1e-6 else (1.0 if x.std() < 1e-6 and y.std() < 1e-6 else 0.0)
        moving = (er[s:e] > 0.5) | (et[s:e] > 0.5)
        segs.append({'a': s, 'b': e, 'motion_amount_corr': round(mc, 3),
                     'motion_where': round(float(mot[s:e][moving].mean()) if moving.any() else 1.0, 3),
                     'layout_luma': round(float(comp_l[s:e].mean()), 3), 'layout_edge': round(float(comp_e[s:e].mean()), 3),
                     'color': round(float(col[s:e].mean()), 3),
                     'cuts_ref': [p for p in pr if s <= p < e], 'cuts_test': [q for q in pt if s <= q < e],
                     'cuts_missed': [p for p in pr if s <= p < e and p not in hit_r], 'cuts_extra': [q for q in pt if s <= q < e and q not in hit_t]})
    moving = (er > 0.5) | (et > 0.5)
    res = {'frames': n, 'offset': a.offset,
           'cuts': {'ref': len(pr), 'test': len(pt), 'recall': round(len(hit_r) / max(1, len(pr)), 3), 'precision': round(len(hit_t) / max(1, len(pt)), 3), 'tol': a.tol},
           'motion_amount_corr': round(float(np.corrcoef(er, et)[0, 1]), 3), 'motion_where': round(float(mot[moving].mean()), 3),
           'layout_luma': round(float(comp_l.mean()), 3), 'layout_edge': round(float(comp_e.mean()), 3), 'color': round(float(col.mean()), 3),
           'segments': segs}
    json.dump(res, open(a.out, 'w'), ensure_ascii=False, indent=1)
    if a.md:
        L = ['# 構図・動き・タイミングの見比べ(絵の中身に頼らない評価)', '',
             f'- 完成版 {a.ref} / 再現版 {a.test} / {n} コマ / offset {a.offset}',
             f"- 切り替わり(動きの山): 完成版 {len(pr)} 個・再現版 {len(pt)} 個。±{a.tol} コマで合った割合 = 完成版の山のうち {res['cuts']['recall']:.0%}(再現率)、再現版の山のうち {res['cuts']['precision']:.0%}(適合率)",
             f"- 動きの量の流れの相関 {res['motion_amount_corr']} / 動きの場所の相関 {res['motion_where']} / 明暗の配置 {res['layout_luma']} / 輪郭の配置 {res['layout_edge']} / 色の配分の重なり {res['color']}",
             '- 読み方: 1 に近いほど合う。絵(人物・柄)が別物でも、同じ場所に同じ大きさの物があり、同じ時に同じ所が動けば高くなる。合否は横並びを目で見て決める。', '',
             '| コマ | 動きの量 | 動きの場所 | 明暗の配置 | 輪郭の配置 | 色 | 合わなかった切り替わり(完成版にあって再現に無い) | 余分(再現だけ) |', '|---|---|---|---|---|---|---|---|']
        for s in segs:
            L.append(f"| {s['a']}–{s['b']} | {s['motion_amount_corr']} | {s['motion_where']} | {s['layout_luma']} | {s['layout_edge']} | {s['color']} | {s['cuts_missed']} | {s['cuts_extra']} |")
        bad = sorted(segs, key=lambda s: s['layout_edge'] + s['layout_luma'] + s['motion_where'])[:10]
        L += ['', '## 目で見るべき区間(合わない順)', ''] + [f"- {s['a']}–{s['b']}: 輪郭 {s['layout_edge']}・明暗 {s['layout_luma']}・動きの場所 {s['motion_where']}" for s in bad]
        open(a.md, 'w', encoding='utf-8').write('\n'.join(L) + '\n')
    print(json.dumps({k: v for k, v in res.items() if k != 'segments'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
