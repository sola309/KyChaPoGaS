# fastlayers.py <comps.pkl> <a> <b> <px/コマ> : ルートの区間で、キーの区間の平均の速さがしきい値を超えるレイヤー(モーションブラーの候補)
import sys, pickle, math, json
C = pickle.load(open(sys.argv[1], 'rb')); A, B, TH = int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
W = {'position': 1.0, 'scale': 5.0, 'rotation': 8.0}
res = {}
def vec(v): return [float(x) for x in v] if isinstance(v, list) else [float(v)]
def scan(p, nm, w, tmap, cid, L):
    if not isinstance(p, dict) or 'k' not in p: return
    k = p['k']
    for a, b in zip(k, k[1:]):
        df = b['f'] - a['f']
        if df <= 0 or a.get('e') == 'hold': continue
        try: d = math.dist(vec(a['v']), vec(b['v'])) * w / df
        except Exception: return
        rf = tmap(a['f'])
        if rf is None or not (A <= rf <= B) or not (L.get('in', -1e9) <= a['f'] <= L.get('out', 1e9)): continue
        key = (cid, L['id'])
        if d >= TH:
            r = res.setdefault(key, [0, rf, (L.get('name') or '')[:20], L.get('type'), set(), L.get('motion_blur')])
            r[0] = max(r[0], d); r[4].add(nm)
def walk(cid, tmap, lo, hi, depth=0):
    if depth > 8 or cid not in C: return
    for L in C[cid]['data']['layers']:
        li, lo_ = L.get('in', 0), L.get('out', 1e9)
        if lo_ < lo or li > hi: continue
        t = L.get('transform') or {}
        for nm, w in W.items():
            if nm in t: scan(t[nm], nm, w, tmap, cid, L)
        for j, e in enumerate(L.get('effects') or []):
            if e.get('type') == 'offset' and 'position' in (e.get('params') or {}): scan(e['params']['position'], 'fx%d' % j, 1.0, tmap, cid, L)
        if L.get('type') == 'comp' and (L.get('source') or {}).get('comp_id') is not None:
            st, sp = float(L.get('start', 0) or 0), float(L.get('speed', 1) or 1)
            walk(L['source']['comp_id'], lambda f, li=li, st=st, sp=sp, tm=tmap: tm((f - st) / sp + li), (max(lo, li) - li) * sp + st, (min(hi, lo_) - li) * sp + st, depth + 1)
walk(225, lambda f: f, A, B)
for (cid, lid), r in sorted(res.items(), key=lambda x: x[1][1]):
    print('%6.0f comp%-4s %-8s %-6s %-20s 最大 %7.1f %s mb=%s' % (r[1], cid, lid, r[3], r[2], r[0], ','.join(sorted(r[4])), r[5]))
print('件数', len(res))
