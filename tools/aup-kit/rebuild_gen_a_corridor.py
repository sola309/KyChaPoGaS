#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GEN_A v4: 廊下に並ぶ「魔法少女服の杏子が槍を持って跳ぶ/構える」立ち絵 12 種(WAI txt2img → cutout → 余白を切る → 登録)。
元素材は開かない。key = v4:corridor/NN.png。 python rebuild_gen_a_corridor.py [--only 03,07 --bump]"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rebuild_lib as L
import rebuild_gen_a as G
from PIL import Image
R = os.path.join(L.WORK, 'GEN_A'); OUT = os.path.join(R, 'corridor'); os.makedirs(OUT, exist_ok=True); ST = os.path.join(R, 'corridor_state.json')
BASE = 'magical girl, red sleeveless dress, detached sleeves, pink skirt, black thighhighs, red boots, holding spear, polearm, full body, long hair, red hair, high ponytail, black hair ribbon, red eyes, fang, simple background, white background, '
POSES = ['jumping, dynamic pose, grin, legs apart', 'fighting stance, spear pointed forward, serious, legs apart', 'swinging spear, motion, dynamic pose, open mouth', 'landing, crouching, one knee, looking up',
         'looking back, from behind, standing, spear on shoulder, smile', 'midair, spinning, floating hair, skirt fluttering, dynamic pose', 'running, leaning forward, spear at side, grin', 'jumping, from side, thrusting spear, shouting',
         'standing, hand on hip, spear planted on ground, confident smile', 'jumping, knees bent, spear overhead, both hands, dynamic pose', 'lunging, from side, low stance, glaring', 'midair, backflip pose, arched back, spear in one hand, smile']
NEG = L.WAI_NEG + ', multiple weapons, dual wielding, 2girls'


def main():
    S = json.load(open(ST)) if os.path.exists(ST) else {}
    only = None; bump = '--bump' in sys.argv
    if '--only' in sys.argv: only = sys.argv[sys.argv.index('--only') + 1].split(',')
    ids = only or ['%02d' % (n + 1) for n in range(12) if not S.get('%02d' % (n + 1), {}).get('asset')]
    for i in ids:
        st = S.setdefault(i, {'att': 0})
        if bump and st.get('asset'): S[i] = st = {'att': st['att'] + 1}
    reqs = [(i, (BASE + POSES[int(i) - 1], 4000 + int(i) + 1000 * S[i]['att'], 832, 1216, L.WAI_POS, NEG)) for i in ids]
    g = G.run_jobs(reqs, L.wai)
    c = G.run_jobs([(i, (a,)) for i, (j, a) in g.items() if a], L.cutout)
    for i in ids:
        if not c.get(i, (0, 0))[1]: continue
        fig = G.crop_alpha(G.img(c[i][1])); p = os.path.join(OUT, i + '.png'); fig.save(p)
        a = L.upload(p, f'genA_corridor_{i}_a{S[i]["att"]}.png'); st = S[i]
        st.update(asset=a['id'], w=fig.width, h=fig.height, job=g[i][0], seed=4000 + int(i) + 1000 * st['att'], pose=POSES[int(i) - 1])
        L.put('GEN_A', f'v4:corridor/{i}.png', a['id'], fig.width, fig.height, 'gen', f"WAI txt2img job {st['job']} seed {st['seed']} tags: {BASE[:110]}… {st['pose']} → cutout → 余白を切る", '仮', st.get('note', '絵は出来・未確認'))
        json.dump(S, open(ST, 'w'), ensure_ascii=False, indent=1); print('ok', i, a['id'], flush=True)


if __name__ == '__main__':
    main()
