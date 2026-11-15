#!/usr/bin/env python3
"""REF3D: 出力を feel-kit の motion_feat で測り、手本(同じカットの灰色人形 B)と比べる → metrics.json
指標(コマ = 24fps):
  corr      速さの曲線(動きの量 = mag × √area)の相関(全 124 コマ、ずらしなし)
  lag       相関が最大になるずれ(±8 コマ。正 = 出力が遅い)と、そのときの相関 corr_lag
  速い出来事ごと(腕の振り上げ・振り下ろし / カメラの振り): 止まるコマのずれ stop_d(出力 − 手本。正 = 止まるのが遅い)、山の高さの比 peak_r
  hold      止めの区間(止まって 2 コマ後から)の残りの動き: 出力の平均 ÷ 手本の動きの山(%)。手本は 0
  bg_after  カメラの止まりのあと 2〜8 コマの画面全体の流れ(|gtx,gty| px/コマ。カット 2・3)
"""
import json, os, sys, subprocess, glob
import numpy as np
R = '/tmp/claude-1000/sakura-rebuild/REF3D'
PY = '/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/backend/.venv/bin/python'
K = '/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/tools/feel-kit'
EV = json.load(open(f'{R}/events.json'))


def load(p):
    z = np.load(p, allow_pickle=True)
    e = z['mag'] * np.sqrt(z['area']); g = np.hypot(z['gtx'], z['gty'])
    return dict(e=e, g=g, d=z['diff'])


def corr(a, b):
    return float(np.corrcoef(a, b)[0, 1]) if a.std() > 1e-9 and b.std() > 1e-9 else 0.0


def stop_frame(e, a, b, peak, search=14):
    """出来事 a〜b の山のあと、動きが山の 15% を下回って 2 コマ続く最初のコマ(b − 4 から探す)"""
    th = 0.15 * peak
    for f in range(max(a + 1, b - 5), min(len(e) - 1, b + search)):
        if e[f] < th and e[f + 1] < th: return f
    return None


def metrics(cut, T, G):
    n = min(len(T['e']), len(G['e'])); te, ge = T['e'][:n], G['e'][:n]
    m = dict(corr=round(corr(te, ge), 3))
    box = lambda x: np.convolve(x, np.ones(3) / 3, mode='same')
    m['corr3'] = round(corr(box(te), box(ge)), 3)   # 3 コマでならした相関(2 コマ打ち = 1 コマおきに止まる作画の影響を外す)
    mv = [f for f in range(1, n - 1) if ge[f] > 0.25 * ge.max()]
    m['twos'] = round(float(np.mean([te[f] < 0.3 * max(te[f - 1], te[f + 1], 1e-6) for f in mv])), 2) if mv else None   # 手本が動いているコマのうち、出力が前後より止まっている割合
    te_raw = te; ts = np.maximum(te, np.r_[te[1:], te[-1]])   # 止まりの判定は 2 コマの大きい方で(2 コマ打ちで早く止まったと数えない)
    best = max(range(-8, 9), key=lambda L: corr(te[max(0, L):n + min(0, L)], ge[max(0, -L):n - max(0, L)]))
    m['lag'] = best; m['corr_lag'] = round(corr(te[max(0, best):n + min(0, best)], ge[max(0, -best):n - max(0, best)]), 3)
    gpk = float(ge.max()); sd, pr, hold, bg = [], [], [], []
    for kind, a, b in EV[cut]:
        if kind in ('rise', 'drop', 'whip', 'orbit'):
            gp = float(ge[a:b + 2].max()); tp = float(ts[max(0, a - 4):b + 6].max())
            pr.append(round(tp / gp, 2) if gp > 0 else None)
            gs, tsf = stop_frame(ge, a, b, gp), stop_frame(ts, a, b, max(tp, 1e-6))
            sd.append(None if gs is None or tsf is None else tsf - gs)
            if kind in ('whip', 'orbit'): bg.append(round(float(T['g'][b + 2:b + 9].mean()), 2))
        elif kind == 'hold':
            if b - a >= 6: hold.append(round(100 * float(te_raw[a + 3:b - 1].mean()) / gpk, 1))
    m.update(stop_d=sd, peak_r=pr, hold=hold, bg_after=bg)
    ok = [x for x in sd if x is not None]
    m['stop_abs'] = round(float(np.mean(np.abs(ok))), 2) if ok else None
    m['stop_miss'] = len(sd) - len(ok)
    m['peak_mean'] = round(float(np.mean([x for x in pr if x is not None])), 2) if pr else None
    m['hold_mean'] = round(float(np.mean(hold)), 1) if hold else None
    m['bg_mean'] = round(float(np.mean(bg)), 2) if bg else None
    return m


def main():
    os.makedirs(f'{R}/npz', exist_ok=True)
    out = {}
    names = sorted(os.path.basename(p)[:-4] for p in glob.glob(f'{R}/out/*.mp4'))
    for n in names:
        z = f'{R}/npz/{n}.npz'
        if not os.path.exists(z): subprocess.run([PY, f'{K}/motion_feat.py', f'{R}/out/{n}.mp4', '--out', z], capture_output=True)
        cut = n.split('_')[0]
        out[n] = metrics(cut, load(z), load(f'{R}/npz/g_{cut}B.npz'))
    for cut in ('c1', 'c2', 'c3'):   # 手本どうし(測り方の物差し): A・C を B と比べる
        for v in 'AC':
            out[f'guide_{cut}{v}'] = metrics(cut, load(f'{R}/npz/g_{cut}{v}.npz'), load(f'{R}/npz/g_{cut}B.npz'))
    json.dump(out, open(f'{R}/metrics.json', 'w'), indent=1)
    for n, m in out.items():
        print(f"{n:18s} corr {m['corr']:6.3f} c3 {m['corr3']:.3f} twos {m['twos']} lag {m['lag']:+d} ({m['corr_lag']:.3f}) stop {m['stop_d']} peak {m['peak_r']} hold% {m['hold']} bg {m['bg_after']}")


if __name__ == '__main__':
    main()
