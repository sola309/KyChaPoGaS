# locate.py <layer_id> <asset_id> <root_frame> : comp 199 のレイヤーが画面でどう映るか(素材の px → 画面 px の倍率・反転・位置)を、描いたコマとの照合で求める
import sys, json, pickle, numpy as np, cv2
sys.path.insert(0, '/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/tools/aup-kit'); import rebuild_lib as r
from PIL import Image
lid, aid, f = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
C = pickle.load(open('/tmp/claude-1000/sakura-rebuild/POLISH7/comps37.pkl', 'rb'))
L = [l for l in C[int(__import__('os').environ.get('COMP','199'))]['data']['layers'] if l['id'] == lid][0]
src = L.get('source') or {}; fit = src.get('fit')
im = Image.open(r.asset_path(aid)).convert('RGBA'); W, H = im.size
w0 = fit['width'] if fit else W
sc = L['transform']['scale'][0] / 100 * w0 / W
flip = any(e['type'] == 'flip' and e['params'].get('h') for e in L.get('effects') or [])
fr = np.asarray(Image.open('/tmp/claude-1000/sakura-rebuild/POLISH9/full20/f_%06d.png' % f).convert('RGB')).astype(np.uint8)
t = im.resize((round(W * sc), round(H * sc)), Image.LANCZOS)
if flip: t = t.transpose(Image.FLIP_LEFT_RIGHT)
T = np.asarray(t).astype(np.float32); a = T[..., 3:] / 255
best = None
bb = Image.fromarray(T[..., 3].astype(np.uint8)).getbbox()
for dy in range(0, 900, 60):
  for dx in (-200, 0, 200):
    cx = (bb[0] + bb[2]) // 2 + dx; ys, ye, xs, xe = bb[1] + dy, bb[1] + dy + 260, cx - 200, cx + 200
    if a[ys:ye, xs:xe].mean() < 0.8: continue
    tpl = (T[ys:ye, xs:xe, :3] * a[ys:ye, xs:xe] + 128 * (1 - a[ys:ye, xs:xe])).astype(np.uint8)
    if tpl.shape[0] > fr.shape[0] or tpl.shape[1] > fr.shape[1]: continue
    res = cv2.matchTemplate(fr, tpl, cv2.TM_CCOEFF_NORMED); _, mx, _, loc = cv2.minMaxLoc(res)
    if best is None or mx > best[0]: best = (mx, loc[0] - xs, loc[1] - ys)
mx, ox, oy = best      # 拡大・反転した絵の左上の画面位置
# 画面 (0..1920, 0..1080) に映る素材の範囲
def to_src(x, y):
    u = (x - ox) / sc; v = (y - oy) / sc
    return (W - u if flip else u), v
xs_ = sorted([to_src(0, 0)[0], to_src(1920, 0)[0]]); v0, v1 = to_src(0, 0)[1], to_src(0, 1080)[1]
vis = [max(0, xs_[0]), max(0, v0), min(W, xs_[1]), min(H, v1)]
print(json.dumps({'layer': lid, 'asset': aid, 'size': [W, H], 'scale_screen': round(sc, 4), 'flip': flip, 'score': round(mx, 3), 'origin': [ox, oy], 'visible_src': [round(v) for v in vis]}))
