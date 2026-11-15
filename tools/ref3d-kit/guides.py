#!/usr/bin/env python3
"""REF3D: 手本の comp を作る(project 35)。同じ動き・同じカメラ・同じキーで見た目だけ替える。
usage: guides.py build            # comp を upsert(15 個)→ comps.json
       guides.py thumb <cut> <f,f,..>   # 5 種を並べた点検シート
       guides.py render [names]   # 描き出しジョブ(1 本ずつ待つ)→ 動画を REF3D/guides/ に写す
"""
import json, math, sys, os, time, io, shutil
sys.path.insert(0, '/tmp/claude-1000/sakura-rebuild/VRM')
from api import call
R = '/tmp/claude-1000/sakura-rebuild/REF3D'
W, H, FPS, D = 1344, 768, 24, 124
FOOT = [672, 700, 0]
BEAT = 9.6   # 150 BPM @ 24fps
bt = lambda n: round(n * BEAT)   # 拍 n のコマ: 0 10 19 29 38 48 58 67 77 86 96 106 115


def ease(name, t):
    t = max(0.0, min(1.0, t))
    return {'linear': t, 'inCubic': t ** 3, 'inQuart': t ** 4, 'outCubic': 1 - (1 - t) ** 3, 'outCirc': math.sqrt(1 - (t - 1) ** 2), 'inOutSine': 0.5 - 0.5 * math.cos(math.pi * t)}[name]


def track(segs, f):
    """segs = [(f0, f1, v0, v1, ease)] 順に。区間の外は前の終わりの値"""
    v = segs[0][2]
    for f0, f1, v0, v1, e in segs:
        if f < f0: break
        v = v0 + (v1 - v0) * ease(e, (f - f0) / max(1, f1 - f0)) if f < f1 else v1
    return v


def cam_layer(th, rad, ty, cy=None, zoom=1050):
    """th(度。0 = 正面(z 負の側)、正で人物の左手側へ回る)・rad・注視点の高さ ty(足もとから上)を 1 コマごとのキーに"""
    P, T = [], []
    for f in range(D):
        a = math.radians(th(f)); r = rad(f); t = ty(f); c = (cy or ty)(f)
        P.append({'f': f, 'v': [FOOT[0] + r * math.sin(a), FOOT[1] - c, -r * math.cos(a)]})
        T.append({'f': f, 'v': [FOOT[0], FOOT[1] - t, 0]})
    return {'id': 'cam', 'type': 'camera', 'in': 0, 'out': D, 'source': {'zoom': zoom, 'target': {'k': T}}, 'transform': {'position': {'k': P}}}


def stage(mat):
    """mat(名前, 色) → material。屋上: 床・柵(四角 1500)・外の目印の箱"""
    o = [{'geometry': 'plane', 'size': [12000, 12000], 'rotation': [90, 0, 0], 'material': mat('floor')}]
    S = 1500
    for i in range(13):
        t = -S + i * 250
        for x, z in ((t, S), (t, -S), (S, t), (-S, t)):
            o.append({'geometry': 'box', 'size': [16, 330, 16], 'position': [x, -165, z], 'material': mat('fence')})
    for y in (-325, -170):
        for (x, z, sx, sz) in ((0, S, 2 * S, 12), (0, -S, 2 * S, 12), (S, 0, 12, 2 * S), (-S, 0, 12, 2 * S)):
            o.append({'geometry': 'box', 'size': [sx, 12, sz], 'position': [x, y, z], 'material': mat('fence')})
    for k, (x, z, sx, sy, sz) in enumerate(((2500, 900, 600, 700, 700), (-2300, 2300, 500, 420, 500), (700, -2700, 900, 1000, 600), (-2700, -1100, 500, 560, 800), (300, 3000, 1400, 520, 500))):
        o.append({'geometry': 'box', 'size': [sx, sy, sz], 'position': [x, -sy / 2, z], 'material': mat('block%d' % k)})
    return o


COL_A = {'floor': '#b9b2a4', 'fence': '#4a5a4c', 'block0': '#d9d2c4', 'block1': '#8fa3b5', 'block2': '#c9b7a2', 'block3': '#a8b59a', 'block4': '#d0c8c0'}
COL_G = {'floor': '#b4b4b4', 'fence': '#5a5a5a', 'block0': '#d2d2d2', 'block1': '#a0a0a0', 'block2': '#bcbcbc', 'block3': '#acacac', 'block4': '#cacaca'}
LIGHT = {'ambient': 1.5, 'intensity': 1.2, 'direction': [0.7, -1, -0.7]}
DEPTH = {'type': 'depth', 'near': 350, 'far': 5200}


def kf(segs):
    """腕などの角度のキー: segs = [(f, v, ease で次へ)]"""
    return {'k': [dict(f=f, v=v, **({'e': e} if e else {})) for f, v, e in segs]}


def cuts():
    b = bt
    # --- カット 1「腕」: カメラ固定。右腕 → 拍 4 で止め → 拍 6 で下ろす。両腕 → 拍 8 で止め → 拍 10 で下ろす
    up, dn = 150, 12
    r_arm = kf([(0, dn, None), (b(4) - 7, dn, 'outCirc'), (b(4), up, None), (b(6), up, 'outCirc'), (b(6) + 6, dn, None), (b(8) - 7, dn, 'outCirc'), (b(8), up, None), (b(10), up, 'outCirc'), (b(10) + 6, dn, None)])
    l_arm = kf([(0, dn, None), (b(8) - 7, dn, 'outCirc'), (b(8), up, None), (b(10), up, 'outCirc'), (b(10) + 6, dn, None)])
    r_el = kf([(0, 8, None), (b(4) - 7, 8, 'outCirc'), (b(4), 4, None), (b(6), 4, 'outCirc'), (b(6) + 6, 8, None), (b(8) - 7, 8, 'outCirc'), (b(8), 4, None), (b(10), 4, 'outCirc'), (b(10) + 6, 8, None)])
    l_el = kf([(0, 8, None), (b(8) - 7, 8, 'outCirc'), (b(8), 4, None), (b(10), 4, 'outCirc'), (b(10) + 6, 8, None)])
    c1 = dict(name='c1', rot=0, preset='stand',
              pose={'shoulder_r': [0, 0, r_arm], 'shoulder_l': [0, 0, l_arm], 'elbow_r': [r_el, 0, 0], 'elbow_l': [l_el, 0, 0], 'hand_r': 'open', 'hand_l': 'open'},
              cam=cam_layer(lambda f: 12, lambda f: 980, lambda f: 350),
              events=[('rise', b(4) - 7, b(4)), ('hold', b(4), b(6)), ('drop', b(6), b(6) + 6), ('rise', b(8) - 7, b(8)), ('hold', b(8), b(10)), ('drop', b(10), b(10) + 6)])
    # --- カット 2「カメラ」: 人物は立ったまま。カメラが加速し続けて拍で止まる(3 回)
    th2 = [(0, b(2), -20, -20, 'linear'), (b(2), b(4), -20, 60, 'inCubic'), (b(4), b(6), 60, 60, 'linear'), (b(6), b(8), 60, 200, 'inCubic'), (b(8), b(10), 200, 200, 'linear'), (b(10), b(12), 200, 340, 'inQuart')]
    c2 = dict(name='c2', rot=0, preset='stand', pose={'shoulder_l': [0, 0, 12], 'shoulder_r': [0, 0, 12]},
              cam=cam_layer(lambda f: track(th2, f), lambda f: 1000, lambda f: 320),
              face_points={'k': [{'f': f, 'v': 1 if math.cos(math.radians(track(th2, f))) > -0.05 else 0} for f in range(D)]},   # 骨の映像: 後ろから見ている間は鼻・目を切る
              events=[('hold', 0, b(2)), ('whip', b(2), b(4)), ('hold', b(4), b(6)), ('whip', b(6), b(8)), ('hold', b(8), b(10)), ('whip', b(10), b(12)), ('hold', b(12), D)])
    # --- カット 3「回りこみ」: 右手を腰に当てた後ろ姿。ゆっくり流れ → 加速し続けて拍 8 で止まり、10 コマで落ち着く
    th3 = [(0, b(4), -28, -18, 'linear'), (b(4), b(8), -18, 128, 'inCubic'), (b(8), b(8) + 10, 128, 133, 'outCubic')]
    rd3 = [(0, b(4), 1250, 1220, 'linear'), (b(4), b(8), 1220, 900, 'inCubic')]
    c3 = dict(name='c3', rot=180, preset='hand_on_hip', pose={'hip_l': [0, 0, 6], 'hip_r': [0, 0, 7], 'chest': [0, 0, -2.5], 'shoulder_l': [0, 0, 16]},
              cam=cam_layer(lambda f: track(th3, f), lambda f: track(rd3, f), lambda f: 340),
              face_points=kf([(0, 0, None), (b(8) - 6, 0, None), (b(8) - 5, 1, None)]),   # 骨の映像: 顔がこちらを向きはじめたら鼻・目を出す
              events=[('drift', 0, b(4)), ('orbit', b(4), b(8)), ('hold', b(8) + 10, D)])
    return [c1, c2, c3]


def mannequin(c, **kw):
    return {'geometry': 'mannequin', 'position': [0, 0, 0], 'rotation': [0, c['rot'], 0], 'body': {'height': 560, 'heads': 6.0}, 'preset': c['preset'], 'pose': c['pose'], **kw}


def doc(c, v):
    cam = c['cam']
    mesh = lambda id_, objs, **src: {'id': id_, 'type': 'mesh', 'in': 0, 'out': D, 'transform': {'position': FOOT}, 'source': {'light': dict(LIGHT), 'objects': objs, **src}}
    std = lambda col: (lambda n: {'type': 'standard', 'roughness': 1, 'color': col[n]})
    if v == 'A':
        person = {'id': 'kyoko', 'type': 'model', 'in': 0, 'out': D, 'transform': {'position': FOOT, 'rotation': [0, c['rot'], 0]},
                  'source': {'asset_id': 11160, 'height': 560, 'light': {'direction': [0.7, -1, -0.7]}, 'shadow': {'opacity': 0.35},
                             'vrm': {'outline': {'all': True, 'width': 2.0}, 'shade': {'color': '#d6c2d6', 'shift': -0.1, 'toony': 0.95}, 'preset': c['preset'], 'pose': c['pose'], 'arm_open': 0,
                                     'spring': {'stiffness': 2, 'gravity': 0.15}}}}
        return {'version': 1, 'bg': '#a9cdea', 'layers': [cam, person, mesh('stage', stage(std(COL_A))), {'id': 'sky', 'type': 'solid', 'in': 0, 'out': D, 'source': {'color': '#a9cdea'}}]}
    if v in ('B', 'C'):
        g = '#9c9c9c'
        colors = {'skin': g, 'top': g, 'bottom': g, 'shoes': g, 'hair': g} if v == 'B' else {k: '#2c2c2c' for k in ('skin', 'top', 'bottom', 'shoes', 'hair')}
        m = mannequin(c, colors=colors, face=False, hair={'style': 'none'}, outfit={'sleeves': 1, 'pants': 1}, material={'type': 'standard', 'roughness': 1}, **({'style': 'stick'} if v == 'C' else {}))
        shadow = {'geometry': 'plane', 'size': [3000, 3000], 'rotation': [90, 0, 0], 'position': [0, -0.5, 0], 'cast_shadow': False, 'material': {'type': 'shadow', 'opacity': 0.3}}
        fig = mesh('fig', [shadow, m]); fig['source']['light'].update(shadows=True, shadow_area=2400, shadow_opacity=0.5)
        return {'version': 1, 'bg': '#c9c9c9', 'layers': [cam, fig, mesh('stage', stage(std(COL_G))), {'id': 'sky', 'type': 'solid', 'in': 0, 'out': D, 'source': {'color': '#c9c9c9'}}]}
    if v == 'D':   # 深度(B の人形 + 舞台。近いほど白)
        m = mannequin(c, face=False, hair={'style': 'none'}, material=dict(DEPTH))
        return {'version': 1, 'bg': '#000000', 'layers': [cam, mesh('all', stage(lambda n: dict(DEPTH)) + [m]), {'id': 'sky', 'type': 'solid', 'in': 0, 'out': D, 'source': {'color': '#000000'}}]}
    if v == 'P':   # OpenPose 形式の骨(黒い背景)
        m = mannequin(c, style='openpose', line_width=5.5, **({'face_points': c['face_points']} if 'face_points' in c else {}))
        return {'version': 1, 'bg': '#000000', 'layers': [cam, mesh('pose', [m], unlit=True), {'id': 'sky', 'type': 'solid', 'in': 0, 'out': D, 'source': {'color': '#000000'}}]}


def upsert(name, d):
    ex = [c for c in call('GET', '/api/comps/?project_id=35') if c['name'] == name]
    body = {'data': d, 'duration_frames': D, 'fps': FPS, 'width': W, 'height': H}
    if ex: return call('PATCH', f"/api/comps/{ex[0]['id']}", body)['id']
    return call('POST', '/api/comps/', {'project_id': 35, 'name': name, **body})['id']


def main():
    cmd = sys.argv[1]
    cj = f'{R}/comps.json'
    if cmd == 'build':
        ids = {}
        for c in cuts():
            for v in 'ABCDP':
                ids[f"{c['name']}{v}"] = upsert(f"試験: REF3D {c['name']} {v}", doc(c, v))
        json.dump(ids, open(cj, 'w')); print(ids)
        json.dump({c['name']: c['events'] for c in cuts()}, open(f'{R}/events.json', 'w'))
    elif cmd == 'thumb':
        from PIL import Image
        ids = json.load(open(cj)); cut = sys.argv[2]; fs = [int(x) for x in sys.argv[3].split(',')]
        vs = sys.argv[4] if len(sys.argv) > 4 else 'ABCDP'
        sheet = Image.new('RGB', (448 * len(fs), 256 * len(vs)))
        for j, v in enumerate(vs):
            for i, f in enumerate(fs):
                im = Image.open(io.BytesIO(call('GET', f"/api/comps/{ids[cut + v]}/thumb?frame={f}&width=448", raw=True))).convert('RGB')
                sheet.paste(im.resize((448, 256)), (448 * i, 256 * j))
        sheet.save(f'{R}/thumb_{cut}.jpg', quality=88); print(f'{R}/thumb_{cut}.jpg')
    elif cmd == 'render':
        ids = json.load(open(cj)); names = sys.argv[2:] or sorted(ids)
        os.makedirs(f'{R}/guides', exist_ok=True)
        for n in names:
            j = call('POST', f'/api/comps/{ids[n]}/render'); jid = j.get('id') or j.get('job_id')
            t0 = time.time()
            while time.time() - t0 < 1500:
                s = call('GET', f'/api/jobs/{jid}')
                if s['status'] in ('completed', 'failed', 'cancelled'): break
                time.sleep(5)
            c = call('GET', f'/api/comps/{ids[n]}')
            print(n, jid, s['status'], c.get('rendered_asset_id'), round(time.time() - t0), flush=True)
            if s['status'] == 'completed':
                a = call('GET', f"/api/assets/{c['rendered_asset_id']}")
                json.dump(dict(json.load(open(f'{R}/guide_assets.json')) if os.path.exists(f'{R}/guide_assets.json') else {}, **{n: c['rendered_asset_id']}), open(f'{R}/guide_assets.json', 'w'))
                print('  ', {k: a.get(k) for k in ('file_path', 'path', 'width', 'height', 'fps', 'duration_frames', 'frame_count')})


if __name__ == '__main__':
    main()
