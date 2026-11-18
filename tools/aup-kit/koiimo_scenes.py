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


def dance(vrm_asset):
    """緑のパーカーの杏子が踊る (元 'v4-4_AnKit.mp4'。手本 75.1〜81.0 秒)。ユーザーの VRM (作者のみ・再配布禁止) を拍に合わせてポーズで動かす。
    拍 = 176.5 BPM (20.4 コマ)。手本の頭 (4506) から最初の拍まで 7 コマ"""
    dur = 360
    beat = [7 + 20.4 * i for i in range(18)]
    # 拍ごとのポーズ: (拍の番号, 2 つ目のプリセット, 混ぜる量)
    seq = [(0, 'idle', 0.0), (2, 'hand_on_hip', 0.9), (5, 'idle', 0.2), (6, 'peace', 1.0), (9, 'idle', 0.1), (10, 'wave', 1.0), (13, 'hand_on_hip', 0.9), (16, 'idle', 0.0)]
    pb, pm = [], []
    for i, (bi, name, mix) in enumerate(seq):
        f = round(beat[bi], 2)
        pb.append({'f': f - 6, 'v': name, 'e': 'hold'})
        pm.append({'f': f - 6, 'v': 0.0 if i and seq[i - 1][1] != name else pm[-1]['v'] if pm else 0.0, 'e': 'snap'})
        pm.append({'f': f + 6, 'v': mix, 'e': 'inOutSine'})
    pm.sort(key=lambda k: k['f'])
    sway, bounce = [], []
    for i, f in enumerate(beat):
        sway.append({'f': round(f, 2), 'v': [0, 0, 7 if i % 2 else -7], 'e': 'inOutSine'})
        bounce.append({'f': round(f, 2), 'v': [1024, 2700], 'e': 'outCubic'})
        bounce.append({'f': round(f + 7, 2), 'v': [1024, 2676], 'e': 'inQuad'})
    layers = [
        {'id': 'kyoko', 'name': '杏子 (VRM・仮)', 'type': 'model', 'in': 0, 'out': dur,
         'transform': {'position': {'k': bounce}, 'rotation': [0, {'k': [{'f': 0, 'v': -14, 'e': 'inOutSine'}, {'f': 180, 'v': 10, 'e': 'inOutSine'}, {'f': dur, 'v': -6}]}, 0]},
         'three_d': True,
         'source': {'asset_id': vrm_asset, 'height': 2415, 'light': {'intensity': 1.0, 'ambient': 0.35},
                                        'vrm': {'preset': 'idle', 'phase': {'k': [{'f': 0, 'v': 0}, {'f': dur, 'v': 3}]}, 'preset_b': {'k': pb}, 'preset_mix': {'k': pm},
                            'pose': {'waist': {'k': sway}}, 'auto_blink': True, 'expressions': {'Joy': 0.45}}}},
        {'id': 'bg', 'name': '空色', 'type': 'shape', 'in': 0, 'out': dur, 'transform': {'position': [1024, 1024]},
         'source': {'kind': 'rect', 'width': 2048, 'height': 2048, 'fill': {'gradient': {'type': 'linear', 'angle': 180, 'stops': [[0, '#cfe8f7'], [1, '#a9d3ee']]}}}},
    ]
    # 元の素材は 2048×2048 (画面では 52.7% = 1080 角で、細切りの入れ子にも使われる)。同じ大きさで作り、頭の上〜ひざを映す
    return {'id': 399011, 'name': '作り直し: 緑のパーカーの踊り (VRM)', 'width': 2048, 'height': 2048, 'fps': FPS, 'duration_frames': dur,
            'data': {'version': 1, 'bg': '#bfe0f4', 'layers': layers}}


def pure_girl(stands):
    """3D の部屋を駆け抜ける (元 Blender 'v4'。手本 69.8〜73.5 秒)。黄緑の柱の格子・青い床・白い机 (mesh) の間に、
    生成した杏子の立ち絵 (stands = 素材の id の列。台帳の stand から選ぶ) を 3D の板として立て、カメラが奥へ進む"""
    dur = 225
    floor_y = 620
    objs = [{'geometry': 'plane', 'size': [3600, 22000], 'position': [0, floor_y, 9000], 'rotation': [90, 0, 0],
             'material': {'color': '#27b9f0', 'roughness': 0.35, 'metalness': 0.1}}]
    for z in range(0, 20001, 900):
        for x in (-1100, 1100):
            objs.append({'geometry': 'box', 'size': [46, 1500, 46], 'position': [x, floor_y - 750, z], 'material': {'color': '#c9d83c', 'roughness': 0.5}})
        objs.append({'geometry': 'box', 'size': [2246, 40, 40], 'position': [0, floor_y - 1480, z], 'material': {'color': '#c9d83c', 'roughness': 0.5}})
    for x in (-1100, 1100):
        for h in (300, 900):
            objs.append({'geometry': 'box', 'size': [36, 36, 20000], 'position': [x, floor_y - h, 10000], 'material': {'color': '#c9d83c', 'roughness': 0.5}})
    import random
    rnd = random.Random(38)
    for i in range(46):
        x = rnd.choice([-1, 1]) * rnd.uniform(380, 980)
        z = rnd.uniform(500, 19000)
        objs.append({'geometry': 'box', 'size': [220, 26, 150], 'position': [x, floor_y - 160, z], 'material': {'color': '#f4f7fb', 'roughness': 0.6}})
        objs.append({'geometry': 'box', 'size': [16, 134, 16], 'position': [x, floor_y - 80, z], 'material': {'color': '#8b9aa8'}})
    layers = []
    for i, aid in enumerate(stands[:12]):
        x = (-1 if i % 2 else 1) * (230 + (i * 157) % 520)
        z = 600 + i * 800
        layers.append({'id': f'st{i}', 'name': f'立ち絵 {i}(仮)', 'type': 'image', 'three_d': True, 'billboard': True, 'in': 0, 'out': dur,
                       'transform': {'position': [960 + x, 540 + floor_y - 450, z]},
                       'source': {'asset_id': aid, 'fit': {'height': 900}}})
    layers.append({'id': 'cam', 'name': 'カメラ', 'type': 'camera', 'in': 0, 'out': dur,
                   'transform': {'position': K((0, [960, 380, -2600]), (dur, [990, 420, 12500]), e='inOutSine')},
                   'source': {'fov': 62, 'target': K((0, [960, 470, 2000]), (dur, [930, 520, 18000]), e='inOutSine')}})
    layers.append({'id': 'room', 'name': '部屋 (mesh)', 'type': 'mesh', 'in': 0, 'out': dur, 'transform': {'position': [960, 540, 0]},
                   'source': {'env': 'soft', 'light': {'ambient': 0.9, 'intensity': 1.3, 'direction': [-0.3, 1, 0.4]}, 'objects': objs}})
    layers.append({'id': 'sky', 'name': '空', 'type': 'shape', 'in': 0, 'out': dur, 'transform': {'position': [960, 540]},
                   'source': {'kind': 'rect', 'width': 1920, 'height': 1080, 'fill': {'gradient': {'type': 'linear', 'angle': 180, 'stops': [[0, '#e9f7ff'], [1, '#bfe6ff']]}}}})
    return {'id': 399009, 'name': '作り直し: ピュアガールの部屋 (3D)', 'width': 1920, 'height': 1080, 'fps': FPS, 'duration_frames': dur,
            'data': {'version': 1, 'bg': '#dff3ff', 'layers': layers}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--map', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--stands', default='', help='立ち絵を選ぶ台帳 (gen1/assets_map.json)')
    ap.add_argument('--vrm', type=int, default=0, help='踊りに使う VRM の素材 (project 37 の 11483。作者のみ・再配布禁止)')
    a = ap.parse_args()
    amap = json.load(open(a.map))
    os.makedirs(a.out, exist_ok=True)
    docs = [sky_umbrella(amap), city(amap)]
    if a.vrm:
        docs.append(dance(a.vrm))
    if a.stands:
        sm = json.load(open(a.stands))
        ids = [v['asset_id'] for k, v in sm.items() if v.get('kind') == 'stand' and v.get('tries')]
        docs.append(pure_girl(ids[::max(1, len(ids) // 12)]))
    for doc in docs:
        json.dump(doc, open(os.path.join(a.out, '%d.json' % doc['id']), 'w'), ensure_ascii=False)
        print('wrote', doc['id'], doc['name'])


if __name__ == '__main__':
    main()
