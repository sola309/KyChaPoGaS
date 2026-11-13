#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""取り込みの報告(import_reports/sceneNN.json)と比べた結果(compare/*/metrics.json)を表にして出す(Markdown)。

    python3 import_summary.py > /tmp/summary.md
"""
import collections
import glob
import json
import os

SAKURA = '/home/kigarashi309/workspace/projects/KyChaPoGaS/reference/aviutl_mad/sakura'


def main():
    reps = [json.load(open(p, encoding='utf-8')) for p in sorted(glob.glob(os.path.join(SAKURA, 'import_reports', 'scene*.json')))]
    print('| シーン | comp | 元のオブジェクト | 取り込んだレイヤー | 無効・非表示で除いた | 効果(対応) | 効果(未対応) | 無い素材 | 置き換えた AVI |')
    print('|---|---|---|---|---|---|---|---|---|')
    mapped, unmapped, missing, layers, notes, eases, fonts = (collections.Counter() for _ in range(7))
    for r in reps:
        m, u = sum(r['effects_mapped'].values()), sum(r['effects_unmapped'].values())
        avis = sorted({f'S{b}' for _, b in r.get('avi_as_scene', [])})
        print(f"| {r['scene']} | {r.get('comp_id', '-')} | {r['objects_total']} | {r['layers_out']} | {r['dropped_disabled'] + r['dropped_hidden_layer']} | {m} | {u} | {len(r['missing'])} | {' '.join(avis)} |")
        mapped.update(r['effects_mapped'])
        unmapped.update(r['effects_unmapped'])
        layers.update(r['layers'])
        notes.update(r['notes'])
        eases.update(r['ease'])
        fonts.update(r.get('font_subst', {}))
        for p in r['missing']:
            missing[p] += 1
    print('\n### レイヤーの種類\n')
    print(', '.join(f'{k} {v}' for k, v in layers.most_common()))
    print('\n### 対応づけた効果(文書の type ごと)\n')
    print(', '.join(f'{k} {v}' for k, v in mapped.most_common()))
    print('\n### 未対応(`aviutl_script` として残した)\n')
    for k, v in unmapped.most_common():
        print(f'- {k}: {v}')
    print('\n### 補間\n')
    print(', '.join(f'{k} {v}' for k, v in eases.most_common()))
    print('\n### 書体の置き換え\n')
    for k, v in fonts.most_common():
        print(f'- {k}: {v}')
    print('\n### メモ\n')
    for k, v in notes.most_common():
        print(f'- {k}: {v}')
    print(f'\n### 無い素材 {len(missing)} 種類\n')
    kinds = collections.Counter()
    for p in missing:
        b = p.rsplit('\\', 1)[-1]
        kinds['シーンの書き出し AVI' if b.lower().startswith('scene') and b.lower().endswith('.avi') else
              '連番(Blender など)' if b[:1].isdigit() and b.lower().endswith('.png') and len(b) <= 9 else
              'ほかの動画' if b.lower().endswith(('.avi', '.mp4')) else '静止画(PC に無い)'] += 1
    print(', '.join(f'{k} {v}' for k, v in kinds.most_common()))
    print('\n### 完成動画との差(compare.py)\n')
    print('| 場所 | 回 | コマ数 | MAD(完成動画と) | SSIM | MAD(参照レンダラと) |')
    print('|---|---|---|---|---|---|')
    for mp in sorted(glob.glob(os.path.join(SAKURA, 'compare', '*', 'metrics.json'))):
        h = json.load(open(mp))
        for run in h['runs']:
            if 'mad_mean' in run or 'mad_vs_ref_mean' in run:
                print(f"| {os.path.basename(os.path.dirname(mp))} | {run['tag']} | {len(run['frames'])} | {run.get('mad_mean', '-')} | {run.get('ssim_mean', '-')} | {run.get('mad_vs_ref_mean', '-')} |")


if __name__ == '__main__':
    main()
