# -*- coding: utf-8 -*-
"""feel-kit の共通部品: イージングの式・軌跡からの推定・動きの出来事(イベント)の切り出し・拍との距離。"""
import json
import math

import numpy as np

# ---------------------------------------------------------------- イージングの式(comp-kit の props.js と同じ)

def _bounce_out(t):
    n, d = 7.5625, 2.75
    if t < 1 / d:
        return n * t * t
    if t < 2 / d:
        t -= 1.5 / d
        return n * t * t + 0.75
    if t < 2.5 / d:
        t -= 2.25 / d
        return n * t * t + 0.9375
    t -= 2.625 / d
    return n * t * t + 0.984375


_IN = {
    'Quad': lambda t: t * t, 'Cubic': lambda t: t ** 3, 'Quart': lambda t: t ** 4, 'Quint': lambda t: t ** 5,
    'Sine': lambda t: 1 - math.cos(t * math.pi / 2),
    'Expo': lambda t: 0.0 if t <= 0 else 2 ** (10 * (t - 1)),
    'Circ': lambda t: 1 - math.sqrt(max(0.0, 1 - t * t)),
    'Back': lambda t: t * t * (2.70158 * t - 1.70158),
    'Elastic': lambda t: 0.0 if t <= 0 else 1.0 if t >= 1 else -(2 ** (10 * (t - 1))) * math.sin((t - 1 - 0.075) * 2 * math.pi / 0.3),
    'Bounce': lambda t: 1 - _bounce_out(1 - t),
}
EASE = {'linear': lambda t: t}
for _n, _f in _IN.items():
    EASE['in' + _n] = _f
    EASE['out' + _n] = (lambda f: lambda t: 1 - f(1 - t))(_f)
    EASE['inOut' + _n] = (lambda f: lambda t: f(t * 2) / 2 if t < 0.5 else 1 - f(2 - t * 2) / 2)(_f)
    EASE['outIn' + _n] = (lambda f: lambda t: (1 - f(1 - t * 2)) / 2 if t < 0.5 else 0.5 + f(t * 2 - 1) / 2)(_f)
# AviUtl の「加減速移動」(加速 + 減速)と同じ形の候補
EASE['smoothstep'] = lambda t: t * t * (3 - 2 * t)
FIT_NAMES = ['linear'] + [d + k for k in ('Quad', 'Cubic', 'Quart', 'Quint', 'Sine', 'Expo', 'Circ') for d in ('in', 'out', 'inOut')] + \
            ['outBack', 'inBack', 'outElastic', 'outBounce', 'smoothstep']


def ease(name, t):
    t = min(1.0, max(0.0, t))
    return EASE.get(name, EASE['linear'])(t)


def curve(name, n):
    """n 個の点(0..1 を等分)の進み具合。"""
    return np.array([ease(name, i / (n - 1)) for i in range(n)])


# ---------------------------------------------------------------- 軌跡 → イージングの推定

def fit_easing(p):
    """p = 進み具合の列(最初 0・最後 1 に正規化済みでなくてよい。値の列そのまま)。
    → {'name': いちばん合う式, 'rmse', 'second': 次点, 't50': 半分まで進む時刻の割合(0.5 = 対称 / 小さい = 入りが速い),
        'peak_t': 速さのピークの位置(0..1), 'overshoot': 行き過ぎ(全体の移動量に対する割合), 'return_frames': 行き過ぎてから収まるまでのコマ,
        'settle_frames': 残り 10% にかけたコマ, 'attack_frames': 最初の 10% にかけたコマ, 'n': コマ数}"""
    p = np.asarray(p, float)
    n = len(p)
    if n < 3 or abs(p[-1] - p[0]) < 1e-9:
        return None
    q = (p - p[0]) / (p[-1] - p[0])
    errs = []
    for name in FIT_NAMES:
        c = curve(name, n)
        errs.append((float(np.sqrt(np.mean((c - q) ** 2))), name))
    errs.sort()
    v = np.diff(q)
    over = float(max(0.0, q.max() - 1.0, -q.min()))
    ret = 0
    if over > 0.01:
        i = int(np.argmax(np.abs(q - 0.5)))
        ret = n - 1 - i
    above = np.nonzero(q >= 0.5)[0]
    i90 = np.nonzero(q >= 0.9)[0]
    i10 = np.nonzero(q >= 0.1)[0]
    return {'name': errs[0][1], 'rmse': round(errs[0][0], 4), 'second': errs[1][1], 'rmse2': round(errs[1][0], 4),
            'linear_rmse': round(next(e for e, nm in errs if nm == 'linear'), 4),
            't50': round(float(above[0] / (n - 1)), 3) if len(above) else None,
            'peak_t': round(float((np.argmax(np.abs(v)) + 0.5) / (n - 1)), 3),
            'overshoot': round(over, 3), 'return_frames': int(ret),
            'settle_frames': int(n - 1 - i90[0]) if len(i90) else 0, 'attack_frames': int(i10[0]) if len(i10) else 0, 'n': int(n)}


# ---------------------------------------------------------------- 動きの出来事(止まり → 動き → 止まり)

def smooth(x, k=3):
    if k <= 1:
        return np.asarray(x, float)
    w = np.ones(k) / k
    return np.convolve(np.asarray(x, float), w, mode='same')


def events(speed, cut=None, floor=1.0, rel=0.12, min_len=4, gap=2):
    """速さの列 → [(始まり, 終わり, ピークのコマ, ピークの速さ)]。
    しきい値 = max(floor, そのかたまりのピーク × rel)。切り替わりでは必ず切る。"""
    s = np.asarray(speed, float)
    n = len(s)
    on = s > floor
    if cut is not None:
        on = on & (np.asarray(cut) < 0.5)
    ev = []
    i = 0
    while i < n:
        if not on[i]:
            i += 1
            continue
        j = i
        g = 0
        while j + 1 < n and (on[j + 1] or g < gap) and not (cut is not None and cut[j + 1] > 0.5):
            g = 0 if on[j + 1] else g + 1
            j += 1
        while j > i and not on[j]:
            j -= 1
        if j - i + 1 >= min_len:
            pk = i + int(np.argmax(s[i:j + 1]))
            thr = max(floor, s[pk] * rel)
            a, b = pk, pk
            while a > i and s[a - 1] > thr:
                a -= 1
            while b < j and s[b + 1] > thr:
                b += 1
            ev.append((int(a), int(b), int(pk), float(s[pk])))
        i = j + 1
    return ev


# ---------------------------------------------------------------- 拍

class Beats:
    def __init__(self, audio_json):
        a = json.load(open(audio_json)) if isinstance(audio_json, str) else audio_json
        self.a = a
        self.fps = a['fps']
        self.beats = np.array(a['beats'])
        self.down = np.array(a['downbeats'])
        self.beat_len = float(np.median(np.diff(self.beats)))
        self.on = {k: np.array(v) if len(v) else np.zeros((0, 2)) for k, v in a['onsets'].items()}
        # 半拍・1/4 拍の格子(拍の間を等分)
        b = self.beats
        self.half = np.sort(np.concatenate([b, (b[:-1] + b[1:]) / 2]))
        self.quarter = np.sort(np.concatenate([self.half, (self.half[:-1] + self.half[1:]) / 2]))

    @staticmethod
    def _near(arr, f):
        if len(arr) == 0:
            return None
        i = int(np.argmin(np.abs(arr - f)))
        return float(f - arr[i]), i

    def to_beat(self, f):
        """いちばん近い拍からのずれ(コマ。正 = 拍より後)。"""
        return self._near(self.beats, f)[0]

    def to_grid(self, f, grid='half'):
        return self._near(getattr(self, grid), f)[0]

    def to_down(self, f):
        return self._near(self.down, f)[0]

    def to_onset(self, f, band='all', min_strength=0.0):
        o = self.on.get(band)
        if o is None or len(o) == 0:
            return None
        o = o[o[:, 1] >= min_strength]
        if len(o) == 0:
            return None
        return self._near(o[:, 0], f)[0]

    def beat_phase(self, f):
        """拍の中の位置(0..1。0 = 拍の頭)。"""
        i = int(np.searchsorted(self.beats, f, side='right')) - 1
        if i < 0 or i >= len(self.beats) - 1:
            return ((f - self.beats[0]) / self.beat_len) % 1.0
        return float((f - self.beats[i]) / (self.beats[i + 1] - self.beats[i]))

    def bar_of(self, f):
        return int(np.searchsorted(self.down, f, side='right'))


def load_motion(path):
    d = np.load(path)
    return {k: d[k] for k in d.files}
