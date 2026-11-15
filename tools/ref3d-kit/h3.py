#!/usr/bin/env python3
"""REF3D: H3 の T1 を 1 本ずつ流す(project 35。アプリのジョブ generate_video_i2v / minimax-h3-ref をそのまま使う)。
usage: h3.py plan            # 条件の一覧
       h3.py run <name>...   # 順に 1 本ずつ(済みは飛ばす)。RENDER_BUSY の間は待ち、走っている間は H3_BUSY を置く
       h3.py dry <name>      # params を表示
名前 = <cut>_<方式>_<衣装>_s<シード番号>   例: c1_M1A_B_s1 / c2_M2Dh_B_s2
方式: M1A M1B M1C = Ref2V(<Video 1> = 手本 A / B / C)
      M2Dh M2Dm = Fun ControlNet 深度 強 1.0 / 中 0.6、M2Ph M2Pm = 骨 強 1.0 / 中 0.6、M2X = 深度 0.3 + 骨 0.7(どれも参照動画なし・設定画つき)
"""
import json, os, sys, time, shutil, subprocess
sys.path.insert(0, '/tmp/claude-1000/sakura-rebuild/VRM')
from api import call
RR = '/tmp/claude-1000/sakura-rebuild'; R = f'{RR}/REF3D'
SEEDS = {'s1': 20261115, 's2': 20261116}
OUTFIT = {
    'B': dict(front=8577, back=8578, b34=8579, text='the star-pattern outfit'),
    'P': dict(front=6673, back=None, b34=None, text='the casual hoodie outfit'),
}
FACE = 6674
STYLE = ("The target video is in 2D-animated style: hand-drawn Japanese TV anime built from flat painted cels - thin, clean line art, flat colour fills, hard-edged cel shadows, "
         "and hand-painted background art with clear, bright air. The place is a school rooftop on a clear day: a pale concrete floor, a dark green metal fence around the edge, "
         "a few rooftop structures beyond it and an open blue sky with white clouds.")
ACTION = {
    'c1': ("The camera is locked and never moves. <Subject 1> stands facing the camera, arms down. At 1.3 s her right arm snaps straight up above her head - fastest at the very first frame of the move - "
           "and stops dead at 1.6 s. The arm stays frozen in the air; only her sleeve, skirt and ponytail swing once from the snap and settle. At 2.4 s the arm drops in one quick motion and she is still again. "
           "At 2.9 s both arms snap up the same way and stop dead at 3.2 s, frozen; at 4.0 s both arms drop in one quick motion, and she stands still to the end."),
    'c2': ("<Subject 1> stands almost still, arms down; only the camera moves. The camera holds still, then at 0.8 s it swings around her toward her left side, getting faster and faster the whole way, "
           "and stops dead at 1.6 s. It holds perfectly still. At 2.4 s it swings on around her again, faster and faster, past her side to behind her, and stops dead at 3.2 s, holding still on her back. "
           "At 4.0 s it swings the rest of the way around, faster and faster, and stops dead at 4.8 s in front of her again. Each stop is instant; her hair and clothes stay calm because she does not move."),
    'c3': ("<Subject 1> stands with her back to the camera, her right hand on her hip, looking out over the fence; she holds this pose the whole time. The camera drifts slowly behind her. "
           "From 1.6 s the camera swings around her right side, getting faster and faster the whole way while moving closer, and stops dead at 3.2 s in front of her at an angle, where her face is seen; "
           "it settles within a few frames and holds."),
}
GUIDE_LOOK = {'A': "a plain 3D previs with a stand-in 3D model", 'B': "a plain 3D previs with a faceless grey mannequin", 'C': "a plain 3D previs with a black stick figure"}


def pictures(cut, o):
    O = OUTFIT[o]; ids = [O['front']]; lines = ["<Subject 1> is Kyoko Sakura in %s, drawn exactly as in <Picture 1>: her face, her long crimson hair in a thick high ponytail and every part of her outfit come only from the pictures." % O['text']]
    if cut in ('c2', 'c3') and O['back']:
        ids.append(O['back']); lines.append("<Picture %d> shows the same Kyoko from behind: her ponytail and the back of the outfit." % len(ids))
    if cut == 'c3' and O['b34']:
        ids.append(O['b34']); lines.append("<Picture %d> shows her from behind at an angle." % len(ids))
    ids.append(FACE); lines.append("<Picture %d> is the face reference: a soft round face, large round red eyes, uneven pointed bangs." % len(ids))
    return ids, lines


def build(name):
    cut, mode, o, s = name.split('_')
    G = json.load(open(f'{R}/guide_assets.json'))
    ids, lines = pictures(cut, o)
    p = dict(project_id=35, model='minimax-h3-ref', fps=24, seed=SEEDS[s], negative_prompt='', scheduler='beta', use_ref_video_audio=False, width=1344, height=768,
             ref_image_size='max', steps=4, turbo_lora=0.75, easycache=True, duration_sec=124 / 24, keyframes=[{'time_sec': 0, 'asset_id': i} for i in ids],
             note=f'REF3D {name} (3D previs guide experiment, T1)')
    if mode.startswith('M1'):
        v = mode[2]
        p['ref_video_asset_ids'] = [G[cut + v]]
        lines.append("<Video 1> is %s: it gives only the camera, the framing, the body motion and its exact timing. The stand-in's own look is not used." % GUIDE_LOOK[v])
        summary = ("[video editing] One continuous shot with no cuts. <Subject 1> takes the place of the stand-in figure of <Video 1> and performs exactly its motion, with exactly its camera and timing, on a school rooftop. "
                   "Every fast move and every dead stop happens on the same frame as in <Video 1>.")
        ret = "<Video 1>: partially_preserved - only the camera, the framing, the body motion and the timing; its figure, colours and surfaces are replaced."
        shot = "[Shot 1] Exactly as <Video 1> in camera, motion and timing. " + ACTION[cut]
    else:
        fc = {'M2Dh': [('D', 1.0)], 'M2Dm': [('D', 0.6)], 'M2Ph': [('P', 1.0)], 'M2Pm': [('P', 0.6)], 'M2X': [('D', 0.3), ('P', 0.7)]}[mode]
        p['fun_controls'] = [dict(control_asset_id=G[cut + v], strength=st) for v, st in fc]
        summary = "[reference generation] One continuous shot with no cuts. <Subject 1> on a school rooftop; fast moves stop dead and hold."
        ret = "N/A"
        shot = "[Shot 1] " + ACTION[cut]
    p['prompt'] = ("subject_definitions:\n" + "\n".join(lines) + "\n\nsummary:\n" + summary + "\n\nretention_analysis:\n" + ret + "\n\ndetailed_description:\n" + STYLE + "\n" + shot
                   + "\n\noverall_soundscape:\nA light rooftop wind.\n\nnon_diegetic_music:\nN/A")
    return p


def plan():
    L = []
    for c in ('c1', 'c2'):
        L += [f'{c}_M1{v}_B_s1' for v in 'ABC'] + [f'{c}_M2X_B_s1', f'{c}_M2Dh_B_s1', f'{c}_M2Ph_B_s1']
    for c in ('c1', 'c2'):
        L += [f'{c}_M1{v}_B_s2' for v in 'ABC'] + [f'{c}_M2X_B_s2', f'{c}_M2Dh_B_s2', f'{c}_M2Ph_B_s2', f'{c}_M1A_P_s1', f'{c}_M1B_P_s1', f'{c}_M2Dm_B_s1', f'{c}_M2Pm_B_s1']
    L += ['c3_M1A_B_s1', 'c3_M1B_B_s1', 'c3_M2X_B_s1', 'c3_M1A_B_s2', 'c3_M1B_B_s2', 'c3_M2X_B_s2']
    return L


def free_gb(): return int(subprocess.run("free -g | awk 'NR==2{print $7}'", shell=True, capture_output=True, text=True).stdout)


def comfy_idle():
    import urllib.request
    q = json.load(urllib.request.urlopen('http://127.0.0.1:8188/queue', timeout=10))
    return not q['queue_running'] and not q['queue_pending']


def log(m):
    open(f'{RR}/LOG.md', 'a').write(f"[REF3D] {time.strftime('%H:%M')} {m}\n")


def run(names):
    os.makedirs(f'{R}/out', exist_ok=True)
    rj = f'{R}/runs.json'
    for n in names:
        runs = json.load(open(rj)) if os.path.exists(rj) else {}
        if runs.get(n, {}).get('status') == 'completed': continue
        if os.path.exists(f'{R}/STOP'): print('STOP'); return
        t0 = time.time()
        while os.path.exists(f'{RR}/RENDER_BUSY') or not comfy_idle() or free_gb() < 42:   # H3 のピークは約 63GB → 終わりまで空き 40GB を保つには走る前に多めに要る…が上限は機体しだい。70 で待つ
            if time.time() - t0 > 3 * 3600: print('gave up waiting', n); return
            time.sleep(20)
        p = build(n)
        open(f'{RR}/H3_BUSY', 'w').write(n)
        try:
            jid = call('POST', '/api/jobs/', {'project_id': 35, 'job_type': 'generate_video_i2v', 'params': p})['id']
            t1 = time.time(); st = None; lo = 999
            while time.time() - t1 < 45 * 60:
                j = call('GET', f'/api/jobs/{jid}'); st = j['status']; lo = min(lo, free_gb())
                if st in ('completed', 'failed', 'cancelled'): break
                time.sleep(10)
            rec = dict(job=jid, status=st, sec=round(time.time() - t1), min_free_gb=lo, seed=p['seed'], pictures=[k['asset_id'] for k in p['keyframes']],
                       ref=p.get('ref_video_asset_ids'), fun=p.get('fun_controls'), err=(j.get('error_msg') or '')[:300])
            if st == 'completed' and j.get('result_asset_ids'):
                a = call('GET', f"/api/assets/{j['result_asset_ids'][0]}"); rec['asset'] = a['id']
                shutil.copy(a.get('file_path') or a.get('path'), f'{R}/out/{n}.mp4')
        finally:
            if os.path.exists(f'{RR}/H3_BUSY'): os.remove(f'{RR}/H3_BUSY')
        runs = json.load(open(rj)) if os.path.exists(rj) else {}
        runs[n] = rec; json.dump(runs, open(rj, 'w'), indent=1)
        print(n, rec, flush=True); log(f"H3 {n}: job {rec['job']} {rec['status']} {rec['sec']} 秒 空きの最小 {rec['min_free_gb']}GB {rec['err'][:80]}")
        if st != 'completed' and len([1 for r in runs.values() if r['status'] != 'completed']) >= 3: print('too many failures'); return


if __name__ == '__main__':
    c = sys.argv[1]
    if c == 'plan': L = plan(); print(len(L)); print('\n'.join(L))
    elif c == 'dry':
        p = build(sys.argv[2]); print(json.dumps({k: v for k, v in p.items() if k != 'prompt'}, ensure_ascii=False)); print(p['prompt']); print(len(p['prompt']))
    elif c == 'run': run(sys.argv[2:] or plan())
