# stiff.py <npz> <a> <b> [ref_npz] : 動きの「硬さ」を拾う(手本に合わせるためでなく、映像として気持ちよく流れるかを見る)
#   急発進 = 前のコマがほぼ止まり(<1.5)から次のコマで一気に速い(>=6)、急停止 = その逆。切り替わり(cut)の前後 2 コマは除く
#   等速 = 速さがほぼ一定(変動 12% 未満)で 18 コマ以上続く動き(機械的に見える)
#   段 = 動きの途中で速さが 1 コマで 2.2 倍以上 / 0.45 倍以下に変わる所(イージングのつなぎ目の段)
#   止まり = 速さ < 0.8 が 30 コマ以上(音が鳴っているのに画が止まる)
#   拍: 動き出し・急変が拍(1 拍 24 コマ)から何コマずれているか
import sys, json, numpy as np
d = np.load(sys.argv[1]); a, b = int(sys.argv[2]), int(sys.argv[3])
m = d['mag'].astype(float); cut = d['cut'].astype(bool)
A = json.load(open('/tmp/claude-1000/sakura-rebuild/FEEL/audio.json')); beats = np.array(A['beats']); down = set(round(x) for x in A['downbeats'])
def near_cut(f, r=2): return cut[max(0, f - r):f + r + 1].any()
def beat_off(f):
    i = np.argmin(np.abs(beats - f)); return f - beats[i]
out = []
for f in range(a + 1, b):
    if near_cut(f): continue
    p, q = m[f - 1], m[f]
    if p < 1.5 and q >= 6: out.append((f, '急発進', round(p, 1), round(q, 1)))
    elif p >= 6 and q < 1.5: out.append((f, '急停止', round(p, 1), round(q, 1)))
    elif min(p, q) >= 3 and (q / p >= 2.2 or q / p <= 0.45): out.append((f, '段', round(p, 1), round(q, 1)))
# 等速
f = a
while f < b - 18:
    seg = m[f:f + 18]
    if seg.min() >= 2.5 and seg.std() / seg.mean() < 0.12 and not cut[f:f + 18].any():
        g = f + 18
        while g < b and not cut[g] and abs(m[g] - seg.mean()) / seg.mean() < 0.15: g += 1
        out.append((f, '等速 %d コマ' % (g - f), round(float(seg.mean()), 1), ''))
        f = g
    else: f += 1
# 止まり
f = a
while f < b:
    if m[f] < 0.8:
        g = f
        while g < b and m[g] < 0.8: g += 1
        if g - f >= 30: out.append((f, '止まり %d コマ' % (g - f), '', ''))
        f = g
    else: f += 1
out.sort()
for f, k, p, q in out: print(f, k, p, q, '拍%+.0f' % beat_off(f))
print('件数', len(out))
