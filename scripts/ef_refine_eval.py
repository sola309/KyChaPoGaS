#!/usr/bin/env python3
"""refine(T1 採用テイクを参照に T2 で描き直し)の評価と差し替え。
ジョブが終わるたびに: 元アニメ参照/T1 との NCC、鮮鋭度比、Codex による 3 段比較(REF/T1/REFINE)で判定し、
カットの全ジョブが揃ったら合格テイクの中で最良のものを Shots のクリップに差し替える。
usage: ef_refine_eval.py <spec.json> [--dry]
spec = {"C22": {"jobs":[..], "ref": 元参照.mp4, "t1": T1.mp4, "t1_asset": id, "clip": clip_id, ...}}"""
import sys, json, time, re, subprocess, urllib.request
import numpy as np
API = 'http://localhost:8002/api'
R = 'outputs/kijun-ef/refine'; E = f'{R}/eval'
CODEX = ['/home/kigarashi309/.npm-global/bin/codex', 'exec', '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=high',
         '--skip-git-repo-check', '--sandbox', 'workspace-write']
EXEMPT_ORIG = {'C13'}  # 元の人物 ≒ 目標のカット(NCC ゲート対象外)

def get(path): return json.load(urllib.request.urlopen(API + path))

def frames(p, w, h, every=1):
    vf = f"scale={w}:{h}:flags=lanczos" + (f",select='not(mod(n\\,{every}))'" if every > 1 else '')
    d = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', p, '-vf', vf, '-fps_mode', 'passthrough',
                        '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], capture_output=True).stdout
    return np.frombuffer(d, np.uint8).reshape(-1, h, w).astype(np.float32)

def ncc(a, b):
    n = min(len(a), len(b)); a = a[:n, ::4, ::4]; b = b[:n, ::4, ::4]
    a = a - a.mean(axis=(1, 2), keepdims=True); b = b - b.mean(axis=(1, 2), keepdims=True)
    return float(((a * b).sum(axis=(1, 2)) / np.sqrt((a ** 2).sum(axis=(1, 2)) * (b ** 2).sum(axis=(1, 2)) + 1e-6)).mean())

def lapvar(f):
    l = -4 * f[:, 1:-1, 1:-1] + f[:, :-2, 1:-1] + f[:, 2:, 1:-1] + f[:, 1:-1, :-2] + f[:, 1:-1, 2:]
    return float(l.var(axis=(1, 2)).mean())

def evaluate(cut, v, j, gen):
    tag = f'{cut}_job{j}'
    ref, t1 = v['ref'], v['t1']
    g = frames(gen, 96, 54); r = frames(ref, 96, 54); t = frames(t1, 96, 54)
    m = {'ncc_orig': ncc(g, r), 'ncc_t1': ncc(g, t), 't1_ncc_orig': ncc(t, r)}
    gs = frames(gen, 1344, 768, 8); ts = frames(t1, 1344, 768, 8)
    m['sharp_ratio'] = lapvar(gs) / max(1e-6, lapvar(ts))
    n = len(g); step = max(1, (n + 5) // 6); mid = n // 2
    strip = f'{E}/{tag}_cmp.jpg'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', ref, '-i', t1, '-i', gen, '-filter_complex',
        f"[0:v]select='not(mod(n,{step}))',scale=448:256,drawtext=text='REF %{{n}}':x=4:y=4:fontsize=18:fontcolor=cyan:box=1:boxcolor=black@0.6,tile=6x1[a];"
        f"[1:v]select='not(mod(n,{step}))',scale=448:256,drawtext=text='T1 %{{n}}':x=4:y=4:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6,tile=6x1[b];"
        f"[2:v]select='not(mod(n,{step}))',scale=448:256,drawtext=text='REFINE %{{n}}':x=4:y=4:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=6x1[c];[a][b][c]vstack=3",
        '-fps_mode', 'passthrough', '-frames:v', '1', strip], check=True)
    full_t1, full_g = f'{E}/{tag}_t1_mid.png', f'{E}/{tag}_refine_mid.png'
    for src, dst in ((t1, full_t1), (gen, full_g)):
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', src, '-vf', f"select='eq(n,{mid})',scale=1344:768:flags=lanczos",
                        '-fps_mode', 'passthrough', '-frames:v', '1', dst], check=True)
    brief = (
        f"カット {cut} の高解像度化の検品。T1 はユーザー承認済みの低解像度(960x544)テイクで、REFINE はそれを参照動画にして 1344x768 で描き直したもの。\n"
        f"カット意図: {v.get('intent', '')}\n"
        "画像1: 3 段構成。上段 REF = 元アニメ(置換前の元の人物)、中段 T1、下段 REFINE。同じ列 = 同じ時刻。\n"
        f"画像2: T1 の {mid} フレーム目を 1344x768 に拡大したもの。画像3: REFINE の同じフレーム(等倍)。細部を見比べること。\n"
        "判定: (a) REFINE の人物は T1 と同じキャラクター(髪色・服・顔立ち・人数)か。元アニメ(REF)の人物の姿に戻っていないか。"
        "(b) 位置・大きさ・動き・タイミング・カメラ・背景・光・フェードが T1 と一致しているか。"
        "(c) REFINE だけに生じた破綻(顔や手の崩れ、融合、ちらつき、余計な人物や物、色の大きな変化)が無いか。"
        "(d) 線・目・髪・背景のディテールが T1 より精細か。\n"
        "簡潔な所見のあと、最終行に次の JSON を 1 行だけ出す(キーはこの通り):\n"
        '{"same_characters":true,"matches_t1":true,"new_artifacts":false,"sharper":true,"better_or_equal":true,"score":0-10,"note":"20字程度"}\n'
        "score は REFINE を最終映像に使う価値(T1 と同等なら 6、明確に上なら 8 以上、使えないなら 3 以下)。画像は生成しない。日本語。")
    open(f'{E}/{tag}_brief.txt', 'w').write(brief)
    out = ''
    for _ in range(3):
        p = subprocess.run(CODEX + ['-i', strip, '-i', full_t1, '-i', full_g, '-'], input=brief, capture_output=True, text=True, timeout=900)
        out = p.stdout
        if re.search(r'\{[^{}]*"same_characters"[^{}]*\}', out): break
        time.sleep(300 if 'limit' in (p.stdout + p.stderr).lower() else 30)
    open(f'{E}/{tag}_eval.txt', 'w').write(out)
    js = re.findall(r'\{[^{}]*"same_characters"[^{}]*\}', out)
    try: verdict = json.loads(js[-1])
    except Exception: verdict = {}
    m.update(verdict=verdict)
    ok = bool(verdict) and verdict.get('same_characters') and verdict.get('matches_t1') and not verdict.get('new_artifacts') and verdict.get('better_or_equal')
    reasons = []
    if not verdict: reasons.append('Codex 判定なし')
    elif not ok: reasons.append('Codex 不合格')
    if cut not in EXEMPT_ORIG and m['ncc_orig'] >= 0.97: reasons.append('元アニメとほぼ同一(未置換)')
    if cut not in EXEMPT_ORIG and m['ncc_orig'] > m['t1_ncc_orig'] + 0.08 and m['ncc_orig'] > 0.85: reasons.append('元アニメ側へ戻った疑い')
    if m['ncc_t1'] < 0.5: reasons.append('T1 から大きく逸脱')
    m['pass'] = not reasons; m['reasons'] = reasons
    with open(f'{R}/results.md', 'a') as f:
        f.write(f"## {cut} job {j} — {time.strftime('%m/%d %H:%M')}\n"
                f"ncc_orig={m['ncc_orig']:.3f} (T1 {m['t1_ncc_orig']:.3f}) ncc_t1={m['ncc_t1']:.3f} sharp={m['sharp_ratio']:.2f} "
                f"pass={m['pass']} {' / '.join(reasons)}\n{json.dumps(verdict, ensure_ascii=False)}\n\n")
    return m

def main():
    spec_path = sys.argv[1]; dry = '--dry' in sys.argv
    spec = json.load(open(spec_path)); res_path = spec_path + '.result.json'
    try: res = json.load(open(res_path))
    except Exception: res = {}
    subprocess.run(['mkdir', '-p', E])
    db = __import__('sqlite3').connect('backend/data/kychapogas.db')
    cuts = {int(l.split()[0]): tuple(map(int, l.split()[1:])) for l in open('outputs/kijun-ef/plan/cuts.tsv')}
    for cut, v in spec.items():
        if 'intent' not in v and cut[1:].isdigit():
            pin = cuts[int(cut[1:])][2]
            v['intent'] = json.loads(db.execute('select attrs_json from clip where id=?', (pin,)).fetchone()[0] or '{}').get('intent', '')
    while True:
        pending = False
        for cut, v in spec.items():
            rc = res.setdefault(cut, {'jobs': {}, 'adopted': None})
            if rc['adopted'] is not None: continue
            for j in v['jobs']:
                if str(j) in rc['jobs']: continue
                st = get(f'/jobs/{j}')
                if st['status'] == 'failed': rc['jobs'][str(j)] = {'pass': False, 'reasons': ['job failed']}; continue
                if st['status'] != 'completed': pending = True; continue
                aid = (st.get('result_asset_ids') or [None])[0]
                gen = get(f'/assets/{aid}')['file_path']
                m = evaluate(cut, v, j, gen); m['asset'] = aid; rc['jobs'][str(j)] = m
                print(f"{cut} job {j} asset {aid}: pass={m['pass']} score={m['verdict'].get('score')} ncc_orig={m['ncc_orig']:.3f} ncc_t1={m['ncc_t1']:.3f} sharp={m['sharp_ratio']:.2f} {m['reasons']}", flush=True)
                json.dump(res, open(res_path, 'w'), ensure_ascii=False, indent=1)
            if all(str(j) in rc['jobs'] for j in v['jobs']):
                ok = [(m['verdict'].get('score', 0), m['sharp_ratio'], j, m['asset']) for j, m in rc['jobs'].items() if m.get('pass')]
                if ok:
                    sc, sh, j, aid = max(ok)
                    if not dry:
                        body = json.dumps({'asset_id': aid, 'asset_in_frame': 0}).encode()
                        urllib.request.urlopen(urllib.request.Request(f"{API}/clips/{v['clip']}", data=body, headers={'Content-Type': 'application/json'}, method='PATCH'))
                    rc['adopted'] = {'job': int(j), 'asset': aid, 'score': sc, 'dry': dry}
                    print(f"{cut}: ADOPT job {j} asset {aid} score {sc} -> clip {v['clip']}{' (dry)' if dry else ''}", flush=True)
                else:
                    rc['adopted'] = False
                    print(f"{cut}: 合格テイクなし(T1 {v.get('t1_asset')} のまま)", flush=True)
                json.dump(res, open(res_path, 'w'), ensure_ascii=False, indent=1)
        if not pending: break
        time.sleep(60)

if __name__ == '__main__':
    main()
