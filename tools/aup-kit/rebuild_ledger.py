#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""素材の台帳(reference/aviutl_mad/sakura/REBUILD_LEDGER.md)を、置き換え表・作り直しの対応表・使われ方の表から組み立てる。

    python3 rebuild_ledger.py [--project-id 37] [--extra notes.json]

入力:
  /tmp/claude-1000/sakura-rebuild/look/index.json   元の静止画の一覧(番号・大きさ・相対パス)
  /tmp/claude-1000/sakura-rebuild/usage36.json      元素材ごとの使われ方(1 巡目の project 36 の構成から数えた: コマ数・最初/最後のコマ・シーン・拡大率)
  sakura/rebuild/replace_*.json                     置き換え表(担当ごと)
  sakura/rebuild/desc_*.json                        何が映っているかの説明(担当が見て書いた {key: 説明})。無ければ how から
  sakura/recreate_map.json の "37"                  連番・動画の作り直し comp
  --extra                                           追加の行(3D の人物など){section: [[列…]]}
"""
import argparse
import collections
import glob
import json
import os

SAKURA = '/home/kigarashi309/workspace/projects/KyChaPoGaS/reference/aviutl_mad/sakura'
WORK = '/tmp/claude-1000/sakura-rebuild'
KIND = {'proc': '手続き', 'gen': '生成(絵)', 'gen+proc': '生成 + 手続き', 'placeholder': '仮の板'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project-id', type=int, default=37)
    ap.add_argument('--extra', default=None)
    ap.add_argument('--out', default=os.path.join(SAKURA, 'REBUILD_LEDGER.md'))
    a = ap.parse_args()
    idx = json.load(open(os.path.join(WORK, 'look', 'index.json'), encoding='utf-8'))
    use = json.load(open(os.path.join(WORK, 'usage36.json'), encoding='utf-8'))
    repl, desc = {}, {}
    for p in sorted(glob.glob(os.path.join(SAKURA, 'rebuild', 'replace_*.json'))):
        for k, v in json.load(open(p, encoding='utf-8')).items():
            repl[k] = dict(v, table=os.path.basename(p)[8:-5])
    for p in sorted(glob.glob(os.path.join(SAKURA, 'rebuild', 'desc_*.json'))):
        desc.update(json.load(open(p, encoding='utf-8')))
    rmap = json.load(open(os.path.join(SAKURA, 'recreate_map.json'), encoding='utf-8')).get(str(a.project_id), {})
    extra = json.load(open(a.extra, encoding='utf-8')) if a.extra else {}

    cnt = collections.Counter()
    rows = []
    for i, _aid, w, h, key in idx:
        u = use.get(key, {})
        r = repl.get(key)
        frames = u.get('frames', 0)
        if r:
            kind, st = KIND.get(r['kind'], r['kind']), r['status']
            how = r.get('how', '')
            note = r.get('note', '')
        else:
            kind, st = '仮の板', ('まだ(ルートから映らない)' if not frames else 'まだ')
            how, note = '取り込み器の仮の板(同じ大きさの灰色の板 + 桃色の × + 「仮」)', ''
        cnt[(kind, st.split('(')[0])] += 1
        sc = u.get('scale') or []
        px = ''
        try:
            s0 = max(float(x) for x in sc if not isinstance(x, str))
            px = f'{int(w * s0 / 100)}×{int(h * s0 / 100)}'
        except Exception:
            pass
        rows.append((-(frames or 0), i, f"| {i} | {key[-58:]} | {desc.get(key, '')[:70]} | {'・'.join(s.split(' ')[0][:14] for s in u.get('scenes', [])[:3])} | "
                     f"{u.get('first', '')}–{u.get('last', '')}({frames}) | {w}×{h} → 画面で最大 約 {px} | {kind} | {st} | {how[:110].replace('|', '/')} {('/ ' + note[:60]) if note else ''} |"))
    rows.sort()

    L = ['# 素材の作り直しの台帳(さくら 1.05 の再現 2 巡目 = 元の素材を 1 つも使わない)', '',
         '- 再現先: project 37「さくら 再現(新規素材)」。ルート comp は `comp_map.json` の "37" → "0"。',
         '- 状態: **できた** = 形・色がそれと分かる所まで作れた / **仮** = 置いてあるが仮(生成した絵はユーザー未確認なので全部「仮」。粗い手続きの絵・棒人形も仮)/ **まだ** = 置き換え先が無く「仮の板」(灰色 + 桃色の ×)が映る。',
         '- 区分: 手続き(PIL・shape・pattern・text・particles)/ 生成(絵)(アプリの WAI txt2img)/ 生成 + 手続き / 3D(mesh)/ 棒人形の仮置き / 仮の板。',
         '- コマはルートの時間(60fps)。「使われるコマ数」は 1 巡目の構成(project 36)から数えた値(入れ子をたどり、そのレイヤーが出ている区間の合計)。',
         '- 元の素材から取ったのは数値だけ(大きさ・不透明部分の箱・代表色)と、目で見た内容。絵そのものは入っていない(監査 `tools/aup-kit/audit_sources.py`)。', '']
    L += ['## 0. まとめ(静止画 379 枚)', '', '| 区分 | できた | 仮 | まだ |', '|---|---|---|---|']
    for k in ('手続き', '生成(絵)', '生成 + 手続き', '仮の板'):
        L.append(f"| {k} | {cnt[(k, 'できた')]} | {cnt[(k, '仮')]} | {cnt[(k, 'まだ')]} |")
    tot = collections.Counter()
    for (k, s), n in cnt.items():
        tot[s] += n
    L.append(f"| 合計 | {tot['できた']} | {tot['仮']} | {tot['まだ']} |")
    for name, body in (extra.get('summary') or {}).items():
        L += ['', f'**{name}**: {body}']
    L += ['', '## 1. 静止画(元 379 枚。使われるコマ数の多い順)', '',
          '| # | 元の素材(相対パスの末尾) | 何が映っているか | シーン | コマ(合計) | 大きさ | 区分 | 状態 | 作り方 |', '|---|---|---|---|---|---|---|---|---|']
    L += [r[2] for r in rows]

    L += ['', '## 2. 連番・動画(Blender の書き出しなど)→ 作り直した comp', '',
          '| ID | 元(フォルダ・ファイル) | comp | 区分 | 状態 | 作り方 |', '|---|---|---|---|---|---|']
    c2 = collections.Counter()
    for key, e in sorted(rmap.items(), key=lambda kv: (kv[1].get('id', ''), kv[0])):
        how = e.get('how', '')
        ph = e.get('placeholder')
        kind = '棒人形の仮置き' if ('マネキン' in how or '棒人形' in how) else ('仮の板' if ph else ('3D(mesh)' if 'mesh' in how else '手続き(comp)'))
        st = '仮' if (ph or kind == '棒人形の仮置き') else 'できた'
        if key.startswith('still:') and ('still:' + key[6:] in repl or key in repl):
            kind, st, how = KIND.get(repl[key]['kind'], '生成(絵)'), repl[key]['status'], repl[key].get('how', '') + '(作り直し comp は使わず、新しい絵を置く)'
        c2[(kind, st)] += 1
        L.append(f"| {e.get('id', '')} | {key[-70:]} | {e.get('comp_id')} | {kind} | {st} | {how[:150].replace('|', '/')} |")
    L += ['', '数: ' + '、'.join(f'{k} {s} = {n}' for (k, s), n in sorted(c2.items()))]
    for sec, body in (extra.get('sections') or {}).items():
        L += ['', f'## {sec}', ''] + body
    open(a.out, 'w', encoding='utf-8').write('\n'.join(L) + '\n')
    print('静止画', dict(tot), {f'{k}/{s}': n for (k, s), n in cnt.items()})
    print('連番・動画', {f'{k}/{s}': n for (k, s), n in c2.items()})


if __name__ == '__main__':
    main()
