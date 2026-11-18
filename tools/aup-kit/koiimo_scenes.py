#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""恋妹 2022 再現 (project 38): 元は Blender・動画だった場面を、comp-kit のコンポで作り直す。

    python koiimo_scenes.py --map WORK/assets_map.json --out DIR

書き出すもの (どれも素材と同じ 1920×1080・60fps。aep_to_comp.py の置き換え表に {"comp_id": N} で入れる):
  399001 冒頭の空と傘 (元 '0.05'。手本 11.1〜21.9 秒): 生成した空 + mesh の傘 (8 枚の布の円すい (上の半径 0 の円柱)・柄・曲がった持ち手) が手前から奥へ回りながら飛ぶ + レンズの光
  399003 街の空撮 (元 '03.avi'。手本 51.1〜53.9 秒): 生成した街をカメラが寄りながら流れ、最後に光で白く抜ける
台帳 (assets_map.json) の 900001 = 空、900002 = 傘の布、900003 = 街。
"""
import argparse
import json
import os

FPS = 60


def K(*pairs, e=None):
    """[(f, v), ...] → キーフレーム。e は区間ごとのイージング (全部同じなら 1 つ)"""
    out = []
    for i, (f, v) in enumerate(pairs):
        k = {'f': f, 'v': v}
        if i < len(pairs) - 1 and e:
            k['e'] = e[i] if isinstance(e, list) else e
        out.append(k)
    return {'k': out}


def sky_umbrella(amap):
    sky = amap['900001']['asset_id']
    cloth = amap['900002']['asset_id']
    dur = 650
    # 傘: 手前 (画面を覆うほど大きい) から左上の奥へ。回りながら小さくなる (手本 11.6〜15.6 秒 = 0.5〜4.5 秒)
    umb = {
        'geometry': 'group',
        'position': K((0, [260, 420, -1900]), (50, [330, 60, -900]), (110, [-80, -160, 600]), (170, [-420, -260, 2600]),
                      (230, [-120, -120, 9000]), (270, [60, -80, 16000]), e=['outCubic', 'inOutSine', 'inOutSine', 'inSine', 'linear']),
        'rotation': K((0, [62, -10, 18]), (60, [38, 20, -22]), (120, [-30, 80, 40]), (180, [-70, 170, 95]), (270, [-120, 320, 160]),
                      e=['outCubic', 'inOutSine', 'inOutSine', 'linear']),
        'children': [
            {'geometry': 'cylinder', 'radius_top': 0, 'radius_bottom': 420, 'height': 150, 'segments': 8, 'open_ended': True, 'position': [0, -75, 0],
             'material': {'type': 'basic', 'texture': {'asset_id': cloth}, 'side': 'double'}},
            {'geometry': 'cylinder', 'radius': 7, 'height': 520, 'position': [0, 110, 0], 'material': {'color': '#2b2b30', 'metalness': 0.6, 'roughness': 0.35}},
            {'geometry': 'torus', 'radius': 34, 'tube': 7, 'arc': 180, 'start': 90, 'position': [34, 370, 0], 'material': {'color': '#5a3a24', 'roughness': 0.5}},
            {'geometry': 'cylinder', 'radius': 5, 'height': 40, 'position': [0, -170, 0], 'material': {'color': '#2b2b30', 'metalness': 0.6, 'roughness': 0.35}},
        ],
    }
    layers = [
        {'id': 'flare', 'name': 'レンズの光', 'type': 'adjustment', 'in': 0, 'out': dur,
         'effects': [{'type': 'lens_flare', 'params': {'cx': 90, 'cy': -140, 'radius': 140, 'streak_length': 0, 'rays': 0, 'intensity': 45,
                                                       'core': 60, 'ring': 25, 'color': '#a8f4ff'}}]},
        {'id': 'umbrella', 'name': '傘', 'type': 'mesh', 'in': 0, 'out': 290, 'motion_blur': True,
         'transform': {'position': [960, 540, 0]},
         'source': {'env': 'soft', 'light': {'ambient': 0.85, 'intensity': 1.6, 'direction': [-0.4, 0.8, 0.6]}, 'objects': [umb]}},
        {'id': 'sky', 'name': '空', 'type': 'image', 'in': 0, 'out': dur,
         'transform': {'position': K((0, [990, 560]), (dur, [930, 520]), e='inOutSine'), 'scale': K((0, [104, 104]), (dur, [112, 112]), e='inOutSine')},
         'source': {'asset_id': sky, 'fit': {'mode': 'cover'}}},
    ]
    return {'id': 399001, 'name': '作り直し: 冒頭の空と傘', 'width': 1920, 'height': 1080, 'fps': FPS, 'duration_frames': dur,
            'data': {'version': 1, 'bg': '#7fc3ea', 'layers': layers}}


def city(amap):
    c = amap['900003']['asset_id']
    dur = 170
    layers = [
        {'id': 'white', 'name': '白く抜ける', 'type': 'solid', 'in': 120, 'out': dur, 'source': {'color': '#ffffff'},
         'transform': {'opacity': K((120, 0), (165, 100), e='inQuad')}},
        {'id': 'leak', 'name': '光', 'type': 'adjustment', 'in': 0, 'out': dur,
         'effects': [{'type': 'lens_flare', 'params': {'cx': -260, 'cy': -320, 'radius': 260, 'streak_length': 0, 'rays': 0,
                                                       'intensity': K((0, 35), (dur, 120), e='inQuad'), 'core': 90, 'color': '#d8fbff'}}]},
        {'id': 'city', 'name': '街', 'type': 'image', 'in': 0, 'out': dur,
         'transform': {'position': K((0, [1060, 600]), (dur, [860, 470]), e='inOutSine'), 'scale': K((0, [110, 110]), (dur, [128, 128]), e='inQuad')},
         'source': {'asset_id': c, 'fit': {'mode': 'cover'}}},
    ]
    return {'id': 399003, 'name': '作り直し: 街の空撮', 'width': 1920, 'height': 1080, 'fps': FPS, 'duration_frames': dur,
            'data': {'version': 1, 'bg': '#bfe9ff', 'layers': layers}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--map', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    amap = json.load(open(a.map))
    os.makedirs(a.out, exist_ok=True)
    for doc in (sky_umbrella(amap), city(amap)):
        json.dump(doc, open(os.path.join(a.out, '%d.json' % doc['id']), 'w'), ensure_ascii=False)
        print('wrote', doc['id'], doc['name'])


if __name__ == '__main__':
    main()
