#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""polish5_make_cards.py : キャラ紹介のカード 4 枚の「全画面の止め絵 → カードの中の顔」を、1 コマで切り替えずに寄せていくための絵を作る(v13)。

v9〜v12: カードの切り抜きレイヤーだけ「顔をまん中へ寄せた版」(全画面の絵を k 倍・平行移動した 1920×1080)に差し替えていた。
  カードの窓(グループのマスク)は 3270 → 528 へ縮むので、最初の 2〜3 コマは窓が全画面より大きく、その瞬間に絵が 1 コマで小さく跳ねて見えた(手本は同じ絵のまま)。
v13: 同じ全画面の絵(project 37 の生成絵。元の素材ではない)を、足りない外側を鏡うつしのぼかしで埋めた大きなカンバスに置き、
  1920×1080 の小さな comp(「POLISH5 カード寄せ …」)の中で scale(100 → 100k)と position((0,0) → t)をキーで動かす。カードのレイヤーはその comp を指す。
  窓が縮みはじめるコマでは全画面の止め絵とぴったり同じ、縮み終わるコマでは今までのカードと同じ構図。
  (カードのレイヤーそのものの transform を動かすと、グループ制御のマスクがレイヤーの中の座標でかかるので、窓までいっしょに縮む・ずれる。だから comp に入れた)
  カンバスの素材と comp の番号は reference/…/rebuild/polish5_cards.json に残し、流し直すときは作り直さず更新する。

出力: 素材の登録(replace_POLISH5.json)と、polish_align の表(layer_edits)の書き換え。 --dry で絵だけ。
"""
import os, sys, json, cv2, numpy as np
sys.path.insert(0, '/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/tools/aup-kit')
import rebuild_lib as RL
OUT = '/tmp/claude-1000/sakura-rebuild/POLISH5/card/'
TABLE = RL.REBUILD + '/polish_align_37.json'
# 全画面の絵: (名前, 顔の中心の割合 n, 拡大 k, 顔を置く場所, カードのレイヤー, 窓が縮む区間 (f0, f1), もとの position の z のキー)
SPEC = {10236: ('02決定', (0.205, 0.385), 0.55, (960, 545), 'o2940', (1524, 1547)),
        10237: ('03決定', (0.345, 0.36), 0.80, (965, 530), 'o2943', (1905, 1928)),
        10242: ('10', (0.30, 0.42), 0.60, (960, 540), 'o2945', (2236, 2253)),
        10238: ('01 (2)', (0.735, 0.44), 0.66, (962, 548), 'o2947', (2567, 2591))}
EASE = 'outCubic'      # 窓(outCirc)より少し遅れて寄る。出だしの 1 コマで動く量を窓の 1/3 に


def main():
    dry = '--dry' in sys.argv
    table = json.load(open(TABLE, encoding='utf-8'))
    comp = RL.call('GET', '/api/comps/209')
    SJ = RL.REBUILD + '/polish5_cards.json'
    state = json.load(open(SJ, encoding='utf-8')) if os.path.exists(SJ) else {}
    for aid, (name, n, k, tg, lid, (f0, f1)) in SPEC.items():
        p = RL.asset_path(aid)
        assert not any(x in p for x in RL.FORBIDDEN)
        im = cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)
        h, w = im.shape[:2]
        assert (w, h) == (1920, 1080)
        tx, ty = tg[0] - k * n[0] * w, tg[1] - k * n[1] * h
        x0, x1 = int(np.floor(min(0, -tx / k))) - 4, int(np.ceil(max(w, (w - tx) / k))) + 4
        y0, y1 = int(np.floor(min(0, -ty / k))) - 4, int(np.ceil(max(h, (h - ty) / k))) + 4
        W, H = x1 - x0, y1 - y0
        st = state.get(str(aid), {})
        if not st.get('asset_id'):
            pad = cv2.copyMakeBorder(im, -y0, y1 - h, -x0, x1 - w, cv2.BORDER_REFLECT_101)
            soft = cv2.GaussianBlur(pad, (0, 0), 60)
            a = np.zeros((H, W), np.float32)
            a[-y0 + 30:-y0 + h - 30, -x0 + 30:-x0 + w - 30] = 1
            a = cv2.GaussianBlur(a, (0, 0), 16)[..., None]
            a[-y0 + 60:-y0 + h - 60, -x0 + 60:-x0 + w - 60] = 1      # 絵の中は元のまま
            out = (pad * a + soft * (1 - a)).astype(np.uint8)
            fp = OUT + 'polish5_card_%d.png' % aid
            cv2.imwrite(fp, out)
            print(aid, name, 'canvas', W, H, 'x0,y0', x0, y0, 't', round(tx, 1), round(ty, 1))
            if dry:
                continue
            up = RL.upload(fp, 'polish5_card_%s.png' % name)
            st['asset_id'] = up['id']
        RL.put('POLISH5', 'POLISH5/card/%s.png' % name, st['asset_id'], W, H, 'gen+proc',
               'polish5_make_cards.py: 生成絵 asset %d を、外側を鏡うつしのぼかしで埋めた %d×%d のカンバスに置いた物(絵そのものは等倍)。カードの切り抜きレイヤー %s 専用(comp「POLISH5 カード寄せ」の中で拡大 100→%d%% と位置のキーで全画面の構図からカードの構図へ寄せる)' % (aid, W, H, lid, round(k * 100)),
               '仮', '元の絵は使っていない。v9〜v12 の 1920×1080 版(k 倍に焼き込んだ物)の置き換え')
        L = next(x for x in comp['data']['layers'] if x['id'] == lid)
        a0 = L['in']
        ek = lambda v0, v1: {'k': [{'f': f0 - a0, 'v': v0, 'e': EASE}, {'f': f1 - a0, 'v': v1}]}
        cdoc = {'name': 'POLISH5 カード寄せ ' + name, 'fps': 60, 'duration_frames': L['out'] - a0, 'width': 1920, 'height': 1080,
                'data': {'version': 1, 'bg': None, 'layers': [
                    {'id': 'pic', 'type': 'image', 'in': 0, 'out': L['out'] - a0, 'source': {'asset_id': st['asset_id']},
                     'transform': {'anchor': [-x0 - W / 2, -y0 - H / 2, 0], 'scale': ek([100.0, 100.0], [100.0 * k, 100.0 * k]), 'position': ek([0.0, 0.0, 0], [round(tx, 2), round(ty, 2), 0])}}]}}
        if st.get('comp_id'):
            RL.call('PATCH', '/api/comps/%d' % st['comp_id'], cdoc)
        else:
            st['comp_id'] = RL.call('POST', '/api/comps/', dict(cdoc, project_id=RL.PROJECT))['id']
        state[str(aid)] = st
        e = table['layer_edits'].setdefault('209:' + lid, {})
        e['set'] = {'type': 'comp', 'source': {'comp_id': st['comp_id'], 'transparent': False}, 'start': 0.0, 'speed': 1.0}
        base = e.get('note', '').split(' / POLISH5')[0]
        e['note'] = (base + ' / POLISH5(v13): 1 コマで小さい絵に切り替わっていた(窓が全画面より大きい最初の 2〜3 コマに絵が跳ねる)→ 大きなカンバスの絵(asset %d)を入れた comp %d に替えた。'
                     'comp の中で、窓が縮む %d〜%d に scale 100→%d・position (0,0)→(%d,%d) を %s で動かす。始まりは全画面の止め絵と同じ、終わりは v12 と同じ構図' % (st['asset_id'], st['comp_id'], f0, f1, round(k * 100), tx, ty, EASE))
        print(lid, 'asset', st['asset_id'], 'comp', st['comp_id'])
    if not dry:
        json.dump(state, open(SJ, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        json.dump(table, open(TABLE, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
