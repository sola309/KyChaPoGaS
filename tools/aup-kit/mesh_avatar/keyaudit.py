# keyaudit.py <comps.pkl> <root a> <root b> : ルートの区間に映るキーの「つなぎ目の速さの段」と「止まりからの急発進・動いたままの急停止」を拾う
#   速さ = (キーの差 / コマ数) × イージングの端の傾き。位置 px、拡大 % は ×5(500px の物の px)、回転 ° は ×8 で px に揃える
#   interp: spline の e の無い区間は速さがつながるので見ない。hold は止まり
import sys, json, pickle, math
C = pickle.load(open(sys.argv[1], 'rb')); A, B = int(sys.argv[2]), int(sys.argv[3]); ROOT = 225
SL = json.load(open('/tmp/claude-1000/sakura-rebuild/POLISH9/slopes.json'))
AU = json.load(open('/tmp/claude-1000/sakura-rebuild/FEEL/audio.json')); BEATS = AU['beats']
W = {'position': 1.0, 'scale': 5.0, 'rotation': 8.0}
def vec(v): return [float(x) for x in v] if isinstance(v, list) else [float(v)]
def slope(e, end):
    if isinstance(e, str) and e in SL: s = SL[e][end]
    elif e is None: s = 1.0
    elif isinstance(e, (list, dict)): s = 1.0
    else: s = 1.0
    return min(s, 4.0)
def beat(f): return min(BEATS, key=lambda b: abs(b - f))
out = []
def scan_prop(p, name, w, tmap, lay, cid, vis):
    if not isinstance(p, dict) or 'k' not in p: return
    k = p['k']; n = len(k)
    if n < 2: return
    spline = p.get('interp') == 'spline'
    segs = []
    for i in range(n - 1):
        a, b = k[i], k[i + 1]; df = b['f'] - a['f']
        if df <= 0: continue
        try: va, vb = vec(a['v']), vec(b['v'])
        except Exception: return
        d = [y - x for x, y in zip(va, vb)]
        e = a.get('e')
        if e == 'hold': d = [0.0] * len(d)
        mag = math.sqrt(sum(x * x for x in d)) * w
        segs.append((a['f'], b['f'], mag / df * slope(e, 0), mag / df * slope(e, 1), e, mag, spline and not e))
    for i in range(len(segs) - 1):
        s0, s1 = segs[i], segs[i + 1]
        if s0[6] and s1[6]: continue
        v0, v1 = s0[3], s1[2]
        jump = abs(v1 - v0)
        if jump >= 4 and jump >= 0.5 * max(v0, v1):
            rf = tmap(s0[1])
            if rf is not None and A <= rf <= B and vis(s0[1]):
                kind = '急発進' if v0 < 0.5 else '急停止' if v1 < 0.5 else '段'
                out.append((rf, kind, round(v0, 1), round(v1, 1), cid, lay.get('id'), (lay.get('name') or '')[:24], name, s0[4], s1[4]))
    # 最後のキーで動いたまま止まる / 最初のキーが止まりから急に出る(レイヤーの出入りのコマは除く)
    if segs:
        s = segs[-1]
        if s[3] >= 4:
            rf = tmap(s[1])
            if rf is not None and A <= rf <= B and vis(s[1]) and lay.get('out', 1e9) > s[1] + 2:
                out.append((rf, '急停止(最後のキー)', round(s[3], 1), 0, cid, lay.get('id'), (lay.get('name') or '')[:24], name, s[4], None))
        s = segs[0]
        if s[2] >= 4:
            rf = tmap(s[0])
            if rf is not None and A <= rf <= B and vis(s[0]) and s[0] > lay.get('in', -1e9) + 2:
                out.append((rf, '急発進(最初のキー)', 0, round(s[2], 1), cid, lay.get('id'), (lay.get('name') or '')[:24], name, None, s[4]))
def walk(cid, tmap, lo, hi, depth=0):
    if depth > 8 or cid not in C: return
    for L in C[cid]['data']['layers']:
        li, lo_ = L.get('in', 0), L.get('out', 1e9)
        if lo_ < lo or li > hi: continue
        vis = lambda f, li=li, lo_=lo_: li <= f <= lo_
        t = L.get('transform') or {}
        for nm, w in W.items():
            if nm in t: scan_prop(t[nm], nm, w, tmap, L, cid, vis)
        for j, e in enumerate(L.get('effects') or []):
            if e.get('type') == 'offset':
                pp = e.get('params') or {}
                if 'position' in pp: scan_prop(pp['position'], 'fx%d.position' % j, 1.0, tmap, L, cid, vis)
        if L.get('type') == 'comp':
            s = L.get('source') or {}; sub = s.get('comp_id')
            if sub is None: continue
            st, sp = float(L.get('start', 0) or 0), float(L.get('speed', 1) or 1)
            def cm(f, li=li, st=st, sp=sp, tmap=tmap):   # 子のコマ → 親のコマ → ルート
                pf = (f - st) / sp + li
                return tmap(pf)
            clo, chi = (max(lo, li) - li) * sp + st, (min(hi, lo_) - li) * sp + st
            walk(sub, cm, clo, chi, depth + 1)
walk(ROOT, lambda f: f, A, B)
out = sorted(set(out), key=lambda r: r[0])
for r in out:
    print('%7.1f %-14s %6s→%-6s comp%-4s %-7s %-24s %-14s %s→%s 拍%+.0f' % (r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[0] - beat(r[0])))
print('件数', len(out))
