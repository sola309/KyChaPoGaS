# apply_cast.py <layer> <asset> <crop x0,y0,x1,y1(素材の px)> <ids.json> <note> : comp 199 の立ち絵の板を、メッシュで動かした連番に替える直しを polish_align_37.json に書く(戻せる)
#   位置: 連番の 1 枚 = 素材の crop を(縮めて)描いた物。レイヤーの中の単位 = fit の幅(無ければ素材の幅)。反転のときは x の差の向きが逆
import json, sys, pickle
sys.path.insert(0, '/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/tools/aup-kit'); import rebuild_lib as r
from PIL import Image
RB = '/home/kigarashi309/workspace/projects/KyChaPoGaS/reference/aviutl_mad/sakura/rebuild/polish_align_37.json'
lid, aid = sys.argv[1], int(sys.argv[2]); x0, y0, x1, y1 = [float(v) for v in sys.argv[3].split(',')]
ids = json.load(open(sys.argv[4])); note = sys.argv[5]
C = pickle.load(open('/tmp/claude-1000/sakura-rebuild/POLISH7/comps37.pkl', 'rb'))
L = [l for l in C[199]['data']['layers'] if l['id'] == lid][0]
assert L['type'] == 'image', L['type']
W, H = Image.open(r.asset_path(aid)).size
fit = (L.get('source') or {}).get('fit'); u = (fit['width'] / W) if fit else 1.0
flip = any(e['type'] == 'flip' and e['params'].get('h') for e in L.get('effects') or [])
a = (L['transform'].get('anchor') or [0, 0, 0])
off = (((x0 + x1) / 2 - W / 2) * u, ((y0 + y1) / 2 - H / 2) * u)
anchor = [round(a[0] + off[0] if flip else a[0] - off[0], 1), round(a[1] - off[1], 1), 0]
A = json.load(open(RB)); E = A['layer_edits']; key = '199:' + lid
prev = E.get(key, {})
st = dict(prev.get('set', {}))
st.update({'type': 'sequence', 'source': {'sequence': {'asset_ids': ids}, 'fit': {'width': round((x1 - x0) * u, 1), 'height': round((y1 - y0) * u, 1), 'mode': 'stretch'}},
           'transform.anchor': anchor, 'transform.scale': L['transform']['scale']})
E[key] = {'set': st, 'note': (prev.get('note', '') + ' / ' if prev.get('note') else '') + note}
json.dump(A, open(RB, 'w'), ensure_ascii=False, indent=1)
print(key, anchor, st['source']['fit'], 'scale', L['transform']['scale'], 'flip', flip)
