#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""feel-kit / AviUtl のプロジェクト(aup-kit の aup_parse.py が出す JSON)から「作者の動かし方の癖」を数える。

  python aup_habits.py 1.05.json --audio audio.json --out habits.json [--md habits.md] [--offset 1]

数える物(動きのある区間 = 値が変わるトラックの 1 区間ごと):
  移動方法・イージングの種類ごとの数と長さ(コマ・拍)/ 動き出し・着地が拍(1 拍・半拍・1/4 拍の格子)からどれだけ離れているか
  「速さのピーク」の時刻(out 系 = 動き出し、in 系 = 着地、inOut = 真ん中)と拍 / 着地のあとの止め(次の区間が始まるまで)の長さ
  同じ動きを数コマずつずらして並べる組(スタッガー)の間隔と人数 / 切り替わり(オブジェクトの頭)と拍
--offset: aup のコマ → 動画のコマ のずれ(さくら = 1)。シーンが全体の時刻と同じ番号で作られている物だけを数える(再生位置 = 開始 + 1 のシーン)。
"""
import argparse
import collections
import json

import numpy as np

from feel_lib import Beats

MOVE = {'X', 'Y', 'Z', '拡大率', '回転', 'X軸回転', 'Y軸回転', 'Z軸回転', '中心X', '中心Y', '中心Z', 'サイズ', '上', '下', '左', '右', '幅', '高さ', '縦横比', 'ライン幅', '目標X', '目標Y', '目標Z'}
FADE = {'透明度', '明るさ', '強さ', '範囲', 'ぼかし'}


def norm_ease(t):
    m = t.get('mode')
    acc, dec = t.get('accel'), t.get('decel')
    if m == 'スクリプト':
        return t.get('easing') or (t.get('script') or 'script').split('@')[0]
    if m == '加減速移動':
        return '加減速' + ('(加速だけ)' if acc and not dec else '(減速だけ)' if dec and not acc else '')
    return (m or '?') + ('+加速' if acc else '') + ('+減速' if dec else '')


def kind_of(ez):
    """速さのピークがどこにあるか: 'out'(頭が速い)/ 'in'(終わりが速い)/ 'inout' / 'flat'"""
    if ez.startswith('outIn'):
        return 'outin'
    if ez.startswith('inOut') or ez.startswith('加減速') and '(' not in ez:
        return 'inout'
    if ez.startswith('out') or '減速' in ez:
        return 'out'
    if ez.startswith('in') or '加速' in ez:
        return 'in'
    return 'flat'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('json')
    ap.add_argument('--audio', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--md')
    ap.add_argument('--offset', type=int, default=1)
    a = ap.parse_args()
    j = json.load(open(a.json))
    obs = j['exedit']['objects']
    B = Beats(a.audio)
    bl = B.beat_len
    # 全体の時刻と番号がそろっていないシーン(再生位置をずらして使われている)を外す
    bad = set()
    for o in obs:
        if o['type_name'] == 'シーン':
            f = o['filters'][0]
            pos = next((t.get('value', t.get('left')) for t in f['tracks'] if t['name'] == '再生位置'), None)
            sp = next((t.get('value', t.get('left')) for t in f['tracks'] if t['name'] == '再生速度'), 100)
            if pos is not None and (abs(pos - (o['start'] + 1)) > 2 or sp != 100):
                bad.add(f.get('exdata', {}).get('scene'))
    segs = []
    for o in obs:
        if o['scene'] in bad:
            continue
        for f in o['filters']:
            for t in f.get('tracks', []):
                m = t.get('mode')
                if m in (None, '移動無し', '瞬間移動') or t.get('left') is None or t.get('right') is None:
                    continue
                if m == '中間点無視' and o.get('chain'):
                    continue        # 鎖の途中の値は意味を持たない(頭と最後だけ)。ここでは数えない
                d = abs(t['right'] - t['left'])
                if d < 1e-6:
                    continue
                ez = norm_ease(t)
                segs.append({'obj': o['id'], 'scene': o['scene'], 'layer': o['layer'], 's': o['start'] + a.offset, 'e': o['end'] + a.offset, 'n': o['end'] - o['start'],
                             'filter': f['name'], 'name': t['name'], 'left': t['left'], 'right': t['right'], 'ease': ez, 'kind': kind_of(ez),
                             'cls': 'move' if t['name'] in MOVE else 'fade' if t['name'] in FADE else 'other', 'type': o['type_name']})
    out = {'segments': len(segs), 'skipped_scenes': sorted(x for x in bad if x is not None), 'beat_len': bl, 'bpm': B.a['bpm']}
    # 1) イージングの種類
    c = collections.Counter(s['ease'] for s in segs)
    cm = collections.Counter(s['ease'] for s in segs if s['cls'] == 'move')
    dur = collections.defaultdict(list)
    for s in segs:
        dur[s['ease']].append(s['n'])
    out['ease'] = [{'ease': k, 'count': v, 'share': round(v / len(segs), 3), 'move_count': cm.get(k, 0), 'len_median': float(np.median(dur[k])),
                    'len_p25': float(np.percentile(dur[k], 25)), 'len_p75': float(np.percentile(dur[k], 75)), 'len_beats': round(float(np.median(dur[k])) / bl, 2)} for k, v in c.most_common()]
    kc = collections.Counter(s['kind'] for s in segs if s['cls'] == 'move')
    out['kind_share_move'] = {k: round(v / max(1, sum(kc.values())), 3) for k, v in kc.most_common()}
    # 2) 長さ(コマ)の分布(動きだけ)
    L = np.array([s['n'] for s in segs if s['cls'] == 'move'])
    hist = collections.Counter(int(x) for x in L)
    out['len_top'] = [[k, v] for k, v in hist.most_common(16)]
    out['len_pct'] = {p: float(np.percentile(L, p)) for p in (10, 25, 50, 75, 90)}
    # 3) 拍との距離(動きだけ。同じ物体の X・Y などは 1 回に数える)
    seen = set()
    start_d, end_d, peak_d, start_h, end_h, peak_h, start_on, end_on = [], [], [], [], [], [], [], []
    by_kind = collections.defaultdict(lambda: {'start': [], 'end': []})
    for s in segs:
        if s['cls'] != 'move' or s['n'] < 4:
            continue
        key = (s['obj'], s['kind'])
        if key in seen:
            continue
        seen.add(key)
        pk = s['s'] if s['kind'] == 'out' else s['e'] if s['kind'] == 'in' else (s['s'] + s['e']) / 2
        start_d.append(B.to_beat(s['s'])); end_d.append(B.to_beat(s['e'])); peak_d.append(B.to_beat(pk))
        start_h.append(B.to_grid(s['s'])); end_h.append(B.to_grid(s['e'])); peak_h.append(B.to_grid(pk))
        od = B.to_onset(s['s'], 'drums' if 'drums' in B.on else 'all')
        if od is not None:
            start_on.append(od); end_on.append(B.to_onset(s['e'], 'drums' if 'drums' in B.on else 'all'))
        by_kind[s['kind']]['start'].append(B.to_grid(s['s'])); by_kind[s['kind']]['end'].append(B.to_grid(s['e']))

    def stat(v, lim):
        v = np.array(v, float)
        return {'n': int(len(v)), 'within1': round(float((np.abs(v) <= 1.5).mean()), 3), 'within2': round(float((np.abs(v) <= 2.5).mean()), 3),
                'median_abs': round(float(np.median(np.abs(v))), 2), 'mean_signed': round(float(v.mean()), 2), 'chance_within1': round(3 / lim, 3), 'chance_within2': round(5 / lim, 3)}
    out['beat'] = {'start_to_beat': stat(start_d, bl), 'end_to_beat': stat(end_d, bl), 'peak_to_beat': stat(peak_d, bl),
                   'start_to_half': stat(start_h, bl / 2), 'end_to_half': stat(end_h, bl / 2), 'peak_to_half': stat(peak_h, bl / 2),
                   'start_to_drum_onset': stat(start_on, bl / 2), 'end_to_drum_onset': stat(end_on, bl / 2)}
    out['beat_by_kind'] = {k: {'start_to_half': stat(v['start'], bl / 2), 'end_to_half': stat(v['end'], bl / 2)} for k, v in by_kind.items()}
    # 拍の中の位置(0..1 を 8 等分)に動き出しがいくつあるか
    ph = np.array([B.beat_phase(s['s']) for s in segs if s['cls'] == 'move' and s['n'] >= 4])
    out['start_phase_hist8'] = [int(x) for x in np.histogram((ph + 1 / 16) % 1, bins=8, range=(0, 1))[0]]
    ph = np.array([B.beat_phase(s['e']) for s in segs if s['cls'] == 'move' and s['n'] >= 4])
    out['end_phase_hist8'] = [int(x) for x in np.histogram((ph + 1 / 16) % 1, bins=8, range=(0, 1))[0]]
    # 4) スタッガー: 同じシーン・同じイージング・同じ長さ・同じトラック名で、開始が少しずつずれている組
    grp = collections.defaultdict(list)
    for s in segs:
        if s['cls'] == 'move' and s['n'] >= 4:
            grp[(s['scene'], s['ease'], s['name'], s['filter'])].append(s)
    stag = []
    for key, g in grp.items():
        g = sorted({(x['s'], x['obj']): x for x in g}.values(), key=lambda x: x['s'])
        i = 0
        while i < len(g):
            run = [g[i]]
            while i + 1 < len(g) and 1 <= g[i + 1]['s'] - run[-1]['s'] <= 8 and abs(g[i + 1]['n'] - run[-1]['n']) <= 6:
                run.append(g[i + 1]); i += 1
            if len(run) >= 3:
                steps = np.diff([x['s'] for x in run])
                stag.append({'scene': key[0], 'ease': key[1], 'track': key[2], 'count': len(run), 'start': run[0]['s'], 'step_median': float(np.median(steps)),
                             'steps': [int(x) for x in steps[:12]], 'len': run[0]['n'], 'even': bool(len(set(steps)) == 1)})
            i += 1
    out['stagger'] = {'groups': len(stag), 'step_hist': [[k, v] for k, v in sorted(collections.Counter(int(x['step_median']) for x in stag).items())],
                      'count_median': float(np.median([x['count'] for x in stag])) if stag else 0, 'even_share': round(float(np.mean([x['even'] for x in stag])), 3) if stag else 0,
                      'ease': collections.Counter(x['ease'] for x in stag).most_common(6), 'examples': sorted(stag, key=lambda x: -x['count'])[:12]}
    # 5) 入り → 止め → 抜け: 同じレイヤーで続く区間(着地の次に同じトラックがまた動き出すまで)
    lay = collections.defaultdict(list)
    for s in segs:
        if s['cls'] == 'move':
            lay[(s['scene'], s['layer'], s['name'])].append(s)
    holds, pairs = [], collections.Counter()
    for key, g in lay.items():
        g.sort(key=lambda x: x['s'])
        for x, y in zip(g, g[1:]):
            gap = y['s'] - x['e']
            if 0 <= gap <= 240:
                holds.append(gap)
                pairs[(x['ease'], y['ease'])] += 1
    out['hold'] = {'n': len(holds), 'pct': {p: float(np.percentile(holds, p)) for p in (10, 25, 50, 75, 90)} if holds else {},
                   'zero_share': round(float(np.mean(np.array(holds) <= 1)), 3) if holds else 0, 'pairs': [[a_, b_, n] for (a_, b_), n in pairs.most_common(12)]}
    # 6) 入りと抜けの長さの比(同じ物体の最初の動きと最後の動き)
    ob = collections.defaultdict(list)
    for s in segs:
        if s['cls'] == 'move':
            ob[(s['scene'], s['layer'])].append(s)
    # 7) オブジェクトの頭(= 切り替わり・出現)と拍
    st = sorted({o['start'] + a.offset for o in obs if o['scene'] not in bad and not o.get('chain_mid')})
    out['object_start_to_half'] = stat([B.to_grid(f) for f in st], bl / 2)
    json.dump(out, open(a.out, 'w'), ensure_ascii=False, indent=1)
    if a.md:
        T = ['# 作者の動かし方の癖(aup から数えた)', '', f"動きのある区間 {len(segs)} 個 / 1 拍 = {bl:.1f} コマ(BPM {B.a['bpm']})/ 数えなかったシーン {out['skipped_scenes']}", '',
             '## イージングの種類', '| 種類 | 数 | 割合 | うち位置・大きさ・回転 | 長さの中央値(コマ) | 25〜75% | 拍に直すと |', '|---|---|---|---|---|---|---|']
        for e in out['ease'][:22]:
            T.append(f"| {e['ease']} | {e['count']} | {e['share'] * 100:.1f}% | {e['move_count']} | {e['len_median']:.0f} | {e['len_p25']:.0f}〜{e['len_p75']:.0f} | {e['len_beats']} |")
        T += ['', '速さのピークの位置(位置・大きさ・回転の区間): ' + ' / '.join(f'{k} {v * 100:.0f}%' for k, v in out['kind_share_move'].items()), '',
              '## 拍との距離(位置・大きさ・回転の区間、4 コマ以上。±1 コマ以内に入る割合 / でたらめに置いた場合)', '| 何が | どの格子に | ±1 コマ以内 | ±2 コマ以内 | でたらめなら(±1) | ずれの中央値 |', '|---|---|---|---|---|---|']
        nm = {'start_to_beat': ('動き出し', '拍'), 'end_to_beat': ('着地', '拍'), 'peak_to_beat': ('速さのピーク', '拍'), 'start_to_half': ('動き出し', '半拍'), 'end_to_half': ('着地', '半拍'),
              'peak_to_half': ('速さのピーク', '半拍'), 'start_to_drum_onset': ('動き出し', 'ドラムの立ち上がり'), 'end_to_drum_onset': ('着地', 'ドラムの立ち上がり')}
        for k, v in out['beat'].items():
            T.append(f"| {nm[k][0]} | {nm[k][1]} | {v['within1'] * 100:.0f}% | {v['within2'] * 100:.0f}% | {v['chance_within1'] * 100:.0f}% | {v['median_abs']} |")
        for k, v in out['beat_by_kind'].items():
            T.append(f"| {k} 系の動き出し / 着地 | 半拍 | {v['start_to_half']['within1'] * 100:.0f}% / {v['end_to_half']['within1'] * 100:.0f}% | {v['start_to_half']['within2'] * 100:.0f}% / {v['end_to_half']['within2'] * 100:.0f}% | {v['start_to_half']['chance_within1'] * 100:.0f}% | n = {v['start_to_half']['n']} |")
        T += ['', f"拍の中の位置(8 等分。0 = 拍の頭、4 = 裏拍)に置かれた数: 動き出し {out['start_phase_hist8']} / 着地 {out['end_phase_hist8']}", '',
              '## 長さ', f"よく使う長さ(コマ: 数): {out['len_top']}", f"パーセンタイル: {out['len_pct']}", '',
              '## ずらし(スタッガー)', f"組 {out['stagger']['groups']} / 1 組の数の中央値 {out['stagger']['count_median']} / 等間隔の割合 {out['stagger']['even_share'] * 100:.0f}% / ずらしのコマ数の分布 {out['stagger']['step_hist']} / よく使うイージング {out['stagger']['ease']}", '',
              '## 止め(着地から次の動き出しまで。同じレイヤー・同じトラック)', f"{out['hold']}", '', f"オブジェクトの頭(出現・切り替わり)と半拍: {out['object_start_to_half']}"]
        open(a.md, 'w').write('\n'.join(T) + '\n')
    print('segments', len(segs), 'kinds', out['kind_share_move'])


if __name__ == '__main__':
    main()
