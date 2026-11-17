# motion_cast.py <out.json> <F0> <N> <style> <w> <h> : 立ち絵の動き(ルート F0 から N コマ)。拍 = 音の解析(beat_this)。style でその子らしさを変える
#   共通: 入りで首が戻る(行き過ぎて落ち着く)・拍でうなずく(小節の頭は深め。6 コマで下り 16 コマで戻る)・2 小節で一往復の首と体の傾き(体は 8 コマ遅れ)・呼吸
import json, math, sys
A = json.load(open('/tmp/claude-1000/sakura-rebuild/FEEL/audio.json'))
out, F0, N, style, W, H = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], int(sys.argv[5]), int(sys.argv[6])
BEATS = [b for b in A['beats'] if F0 - 30 <= b <= F0 + N + 20]; DOWN = set(round(b, 1) for b in A['downbeats'])
ST = {   # 入りの首の向き・傾き、揺れの大きさ、うなずきの深さ(小節の頭 / 拍)、体、視線
    'detective': dict(x0=-7, z0=3.5, sx=2.0, sz=2.6, nd=4.0, nb=2.2, bz=1.1, gaze=-0.08),
    'pink':      dict(x0=6, z0=-4, sx=2.4, sz=2.0, nd=4.5, nb=2.6, bz=1.3, gaze=0.06),       # 歯を見せて笑う: 大きめに弾む
    'blue':      dict(x0=-6, z0=4, sx=2.8, sz=3.2, nd=3.5, nb=2.0, bz=1.6, gaze=-0.08),      # スカートをつまむ: 首をかしげて大きく揺れる
    'magic':     dict(x0=5, z0=-2.5, sx=1.6, sz=1.6, nd=3.0, nb=1.6, bz=0.8, gaze=0.05),     # 魔法少女の姿: 落ち着いて小さく
}[style]
def nod(f):
    v = 0.0
    for b in BEATS:
        if b < F0 + 14: continue
        d = ST['nd'] if round(b, 1) in DOWN else ST['nb']
        if b - 6 <= f <= b: t = (f - (b - 6)) / 6; v -= d * t * t
        elif b < f <= b + 16: t = (f - b) / 16; v -= d * (1 - t) ** 3
    return v
bar0 = min([b for b in A['downbeats'] if b >= F0] or [F0])
def eio(t): return 0.5 - 0.5 * math.cos(math.pi * min(1, max(0, t)))
P = []
for i in range(N):
    f = F0 + i
    land = 1 - (lambda t: 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2)(min(1, i / 20))
    sway = math.sin(2 * math.pi * (f - bar0) / 194.4); lag = math.sin(2 * math.pi * (f - bar0 - 8) / 194.4)
    ph = (f - BEATS[0]) % 48
    p = dict(angleX=ST['x0'] * land + ST['sx'] * sway, angleZ=ST['z0'] * land + ST['sz'] * sway, angleY=nod(f),
             bodyAngleZ=ST['bz'] * lag, bodyAngleX=0.55 * ST['bz'] * lag, breath=eio(ph / 24) if ph < 24 else eio(1 - (ph - 24) / 24), gazeX=ST['gaze'] * sway)
    P.append({k: round(v, 4) for k, v in p.items()})
json.dump({'frames': N, 'warmup': 1.0, 'crop': [0, 0, W, H], 'params': P}, open(out, 'w'))
print(style, len(BEATS), 'beats', P[0])
