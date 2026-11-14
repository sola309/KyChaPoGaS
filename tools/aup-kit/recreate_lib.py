#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""recreate.py の共通部品(登録簿と小道具)。作り直しの本体は recreate_g*.py に分けて書く。"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aup_materials as AM   # noqa: E402

SAKURA = AM.SAKURA
W, H, FPS = 1920, 1080, 60
PID = int(os.environ.get('AUP_PROJECT', '36'))     # 作る先のプロジェクト(recreate.py --project-id が環境変数に入れる。37 = 元素材を使わない作り直し)
REBUILD = PID != 36


def scene_comps():
    """AviUtl のシーン番号(文字列)→ そのプロジェクトでの comp id。"""
    return json.load(open(os.path.join(SAKURA, 'comp_map.json'), encoding='utf-8')).get(str(PID), {})


BUILDERS = {}     # key(連番フォルダの相対パス)→ (台帳 ID, 関数, メモ)


def reg(key, lid, how, placeholder=False):
    def deco(fn):
        BUILDERS[key] = {'id': lid, 'fn': fn, 'how': how, 'placeholder': placeholder}
        return fn
    return deco


# ---------------------------------------------------------------- 小道具

def kf(*pts):
    """kf((f, v), (f, v, 'outQuad'), ...) → キーフレーム値"""
    return {'k': [dict(f=p[0], v=p[1], **({'e': p[2]} if len(p) > 2 else {})) for p in pts]}


def layer(id, type, n, source=None, pos=None, **kw):
    L = {'id': id, 'type': type, 'in': kw.pop('t0', 0), 'out': kw.pop('t1', n)}
    tr = kw.pop('transform', None) or {}
    if pos is not None:
        tr['position'] = pos
    if tr:
        L['transform'] = tr
    if source is not None:
        L['source'] = source
    L.update(kw)
    return L


def petals(id, n, seed=1, rate=20, life=5, size=30, colors=('#ffd9e4', '#ffb7cd', '#ffffff'), wind=(120, 0, 0), gravity=(0, 60, 0),
           area=(2400, 1300, 0), pos=(960, 540), pre=300, sprite='petal', **extra):
    """画面全体に舞う花びら(粒子)。pre コマぶん前から出しておく(頭のコマからもう舞っている)。"""
    em = {'preset': 'petals', 'sprite': sprite, 'position': [0, 0, 0], 'emit': 'box', 'area': list(area), 'rate': rate, 'life': life,
          'size': [size, size], 'size_random': 0.6, 'wind': list(wind), 'gravity': list(gravity), 'colors': list(colors),
          'opacity': [0, 100, 100, 100, 0]}
    em.update(extra)
    return layer(id, 'particles', n, {'seed': seed, 'emitter': em}, pos=list(pos), t0=-pre)


def doc(name, n, layers, bg=None, fps=FPS, w=W, h=H):
    return {'name': name, 'fps': fps, 'duration_frames': n, 'width': w, 'height': h, 'data': {'version': 1, 'bg': bg, 'layers': layers}}


