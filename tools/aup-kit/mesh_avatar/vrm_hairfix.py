# vrm_hairfix.py <in.glb> <out.glb> : 3D 杏子(VRM0)の髪のめり込みを減らす。元のファイルは読むだけ(上書きしない)
#   当たり判定(コライダー)は素肌の体の大きさで、パーカーの布の厚みが入っていない → 胴・肩・腕・腰を布の厚みぶん大きく、フードの当たりも大きく。
#   髪の房の当たりの太さ(hitRadius)も 0.02 → 0.03。メッシュ・骨・テクスチャは触らない(JSON の数だけ)
import sys, json, struct
src, dst = sys.argv[1], sys.argv[2]
assert src != dst
b = open(src, 'rb').read()
n = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20 + n]); rest = b[20 + n:]
nodes = j['nodes']; sa = j['extensions']['VRM']['secondaryAnimation']
ADD = {'Hips': 0.03, 'Spine': 0.035, 'Chest': 0.035, 'Left shoulder': 0.03, 'Right shoulder': 0.03,
       'Left arm': 0.03, 'Right arm': 0.03, 'Left elbow': 0.025, 'Right elbow': 0.025}
SET = {'Kyoko_Hood_001': 0.06, 'Kyoko_Hood_002': 0.06}
log = []
for g in sa['colliderGroups']:
    nm = nodes[g['node']].get('name')
    for c in g['colliders']:
        r0 = c['radius']
        if nm in ADD: c['radius'] = r0 + ADD[nm]
        elif nm in SET: c['radius'] = max(r0, SET[nm])
        if c['radius'] != r0: log.append((nm, round(r0, 4), round(c['radius'], 4)))
for s in sa['boneGroups']:
    if s.get('hitRadius', 0) < 0.03: s['hitRadius'] = 0.03
meta = j['extensions']['VRM'].get('meta', {})
js = json.dumps(j, ensure_ascii=False, separators=(',', ':')).encode()
js += b' ' * ((4 - len(js) % 4) % 4)
total = 12 + 8 + len(js) + len(rest)
out = b[:4] + struct.pack('<I', struct.unpack('<I', b[4:8])[0]) + struct.pack('<I', total) + struct.pack('<I', len(js)) + b'JSON' + js + rest
open(dst, 'wb').write(out)
print('colliders changed', len(log)); [print(x) for x in log[:12]]
print('meta title/author', meta.get('title'), meta.get('author'))
