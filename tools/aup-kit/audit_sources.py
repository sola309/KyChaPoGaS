#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""再現版(元の素材を使わない作り直し)が、本当に元の素材を 1 つも使っていないことを機械で確かめる。

    python3 audit_sources.py --project-id 37 --root 225 --out AUDIT.md [--json audit.json]

やること:
 1. ルート comp から入れ子(comp レイヤー・mesh のテクスチャ・マットなど、文書のどこにあっても)をたどり、使われる comp と素材(asset_id)を全部ならべる。
 2. 素材ごとに file_path を引き、(a) そのプロジェクトの素材か (b) 禁止の場所(materials/・final_1.05・original_op・fetched_after_stop・project 36 の素材置き場)を指していないか
    (c) ファイルの md5 が元素材(materials/ の全ファイル・project 36 の全素材)のどれとも同じでないか を見る。
 3. 素材の出どころを分類する: 生成ジョブ(gen_params。init_asset_id / ref_asset_ids が元素材を指していないかも見る)、切り抜きジョブ(元の素材番号をたどる)、
    登録(置き換え表 replace_*.json の kind / how、取り込み器の仮の板)。出どころが分からない物は「不明」として数える(0 でなければ不合格)。
 4. 文書に埋まった data URL(絵)と外の URL を全部ならべる(どの comp のどのレイヤーか・大きさ)。
 5. フォントの一覧。
終了コード: 違反 0 件なら 0、あれば 1。
"""
import argparse
import collections
import glob
import hashlib
import json
import os
import sys
import urllib.request

SAKURA = '/home/kigarashi309/workspace/projects/KyChaPoGaS/reference/aviutl_mad/sakura'
FORBIDDEN = ('reference/aviutl_mad/sakura/materials', 'final_1.05', 'original_op', 'fetched_after_stop',
             '/uploads/36/', '/generated/36/', '/assets/36/')


def get(api, p):
    with urllib.request.urlopen(api + p, timeout=300) as r:
        return json.load(r)


def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project-id', type=int, default=37)
    ap.add_argument('--root', type=int, required=True)
    ap.add_argument('--api', default='http://127.0.0.1:8002')
    ap.add_argument('--out', default=None)
    ap.add_argument('--json', default=None)
    ap.add_argument('--orig-project', type=int, default=36)
    a = ap.parse_args()
    pid = a.project_id
    comps = {c['id']: c for c in get(a.api, f'/api/comps/?project_id={pid}')}
    assets = {x['id']: x for x in get(a.api, f'/api/assets/?project_id={pid}')}
    orig_assets = {x['id']: x for x in get(a.api, f'/api/assets/?project_id={a.orig_project}')}
    full = {}

    def comp(cid):
        if cid not in full:
            full[cid] = get(a.api, f'/api/comps/{cid}')
        return full[cid]

    used_assets = collections.defaultdict(set)      # asset_id -> {(comp_id, layer id)}
    used_comps = collections.OrderedDict()
    data_urls = []
    ext_urls = []
    fonts = collections.Counter()
    violations = []

    def walk(cid, via):
        if cid in used_comps:
            return
        if cid not in comps:
            violations.append(f'comp {cid} はプロジェクト {pid} の物ではない(参照元 {via})')
            used_comps[cid] = None
            return
        used_comps[cid] = comps[cid]['name']
        c = comp(cid)

        def deep(o, lid, path):
            if isinstance(o, dict):
                for k, v in o.items():
                    if k == 'asset_id' and isinstance(v, int) and v > 0:
                        used_assets[v].add((cid, lid))
                    elif k == 'comp_id' and isinstance(v, int):
                        walk(v, f'comp {cid} / {lid}')
                    elif k in ('font', 'font_family') and isinstance(v, str):
                        fonts[v] += 1
                    elif isinstance(v, str) and v.startswith('data:'):
                        data_urls.append({'comp': cid, 'layer': lid, 'key': path + '.' + k, 'mime': v[5:v.find(';')] if ';' in v[:60] else v[5:40],
                                          'bytes': len(v), 'md5': hashlib.md5(v.encode()).hexdigest()[:12]})
                    elif isinstance(v, str) and (v.startswith('http://') or v.startswith('https://') or v.startswith('/api/') or v.startswith('file:')):
                        ext_urls.append({'comp': cid, 'layer': lid, 'key': path + '.' + k, 'url': v[:200]})
                    else:
                        deep(v, lid, path + '.' + k)
            elif isinstance(o, list):
                for i, v in enumerate(o):
                    deep(v, lid, path)
        for L in c['data'].get('layers', []):
            deep(L, L.get('id', '?'), 'layer')
        deep({k: v for k, v in c['data'].items() if k != 'layers'}, '(comp)', 'data')

    walk(a.root, 'root')

    # 置き換え表・仮の板
    repl = {}
    for rp in sorted(glob.glob(os.path.join(SAKURA, 'rebuild', 'replace_*.json'))):
        for k, v in json.load(open(rp, encoding='utf-8')).items():
            if v.get('asset_id'):
                repl[v['asset_id']] = dict(v, key=k, table=os.path.basename(rp))
    ph = {}
    php = os.path.join(SAKURA, 'rebuild', f'asset_map_{pid}.json')
    if os.path.exists(php):
        for k, v in json.load(open(php, encoding='utf-8')).items():
            if v.get('rebuilt') == 'placeholder':
                ph[v['asset_id']] = k

    # 元素材の md5(materials/ の全ファイル + 元プロジェクトの全素材 + 完成版など)
    orig_md5 = {}
    for root, _d, files in os.walk(os.path.join(SAKURA, 'materials')):
        for fn in files:
            p = os.path.join(root, fn)
            try:
                orig_md5[md5(p)] = p
            except OSError:
                pass
    for x in orig_assets.values():
        p = x.get('file_path')
        if p and os.path.exists(p):
            orig_md5.setdefault(md5(p), p)
    for p in (os.path.join(SAKURA, 'final_1.05.mp4'), os.path.join(SAKURA, 'original_op.mp4')):
        if os.path.exists(p):
            orig_md5.setdefault(md5(p), p)

    rows = []
    kinds = collections.Counter()

    def origin(x, depth=0):
        """素材の出どころ → (分類, 説明, 入力にした素材の番号の並び)"""
        gp = {}
        try:
            gp = json.loads(x.get('gen_params_json') or '{}') or {}
        except Exception:
            pass
        aid = x['id']
        if aid in repl:
            r = repl[aid]
            return r['kind'], f"{r['table']}: {r.get('how', '')}", []
        if aid in ph:
            return 'placeholder', '取り込み器の仮の板(PIL: 灰色の板 + 桃色の × + 「仮」)', []
        if x.get('asset_type') == 'generated' and gp.get('prompt') is not None:
            ins = [i for i in ([gp.get('init_asset_id')] + list(gp.get('ref_asset_ids') or [])) if i]
            return 'gen', f"生成ジョブ model={gp.get('model')} seed={gp.get('seed')} prompt={str(gp.get('prompt'))[:80]}", ins
        if gp.get('src_asset_id') or gp.get('asset_id'):
            s = gp.get('src_asset_id') or gp.get('asset_id')
            return 'derived', f"アプリの加工ジョブ(元 = 素材 {s}。{ {k: v for k, v in gp.items() if k in ('model', 'method', 'job_type')} })", [s]
        return 'unknown', f"asset_type={x.get('asset_type')} name={x.get('name')}", []

    def check_inputs(ins, aid, seen=()):
        for i in ins:
            if i in seen:
                continue
            if i in orig_assets:
                violations.append(f'素材 {aid} の入力に元プロジェクトの素材 {i} が使われている')
            elif i in assets:
                p = assets[i].get('file_path') or ''
                if any(f in p for f in FORBIDDEN):
                    violations.append(f'素材 {aid} の入力 {i} が禁止の場所を指す: {p}')
                _k, _d, ins2 = origin(assets[i])
                check_inputs(ins2, aid, tuple(seen) + (i,))
            else:
                violations.append(f'素材 {aid} の入力 {i} がプロジェクト {pid} に無い')

    for aid in sorted(used_assets):
        x = assets.get(aid)
        where = sorted(used_assets[aid])[:3]
        if x is None:
            violations.append(f'素材 {aid} はプロジェクト {pid} の物ではない(使う所 {where})' + (' ← 元プロジェクトの素材!' if aid in orig_assets else ''))
            rows.append({'asset_id': aid, 'path': (orig_assets.get(aid) or {}).get('file_path'), 'kind': 'VIOLATION', 'how': '別プロジェクトの素材', 'uses': len(used_assets[aid])})
            continue
        p = x.get('file_path') or ''
        bad = [f for f in FORBIDDEN if f in p]
        if bad:
            violations.append(f'素材 {aid} が禁止の場所を指す: {p}')
        m = md5(p) if os.path.exists(p) else None
        if m and m in orig_md5:
            violations.append(f'素材 {aid}({p})は元素材 {orig_md5[m]} と同じファイル(md5 一致)')
        k, how, ins = origin(x)
        check_inputs(ins, aid)
        if k == 'unknown':
            violations.append(f'素材 {aid} の出どころが分からない({how})')
        kinds[k] += 1
        rows.append({'asset_id': aid, 'path': p, 'kind': k, 'how': how, 'uses': len(used_assets[aid]), 'w': x.get('width'), 'h': x.get('height'),
                     'status': (repl.get(aid) or {}).get('status', '仮' if k == 'placeholder' else ''), 'for': (repl.get(aid) or {}).get('key') or ph.get(aid, '')})

    ok = not violations
    res = {'project_id': pid, 'root': a.root, 'comps_used': len(used_comps), 'assets_used': len(rows), 'kinds': dict(kinds),
           'data_urls': len(data_urls), 'ext_urls': len(ext_urls), 'violations': violations, 'orig_files_hashed': len(orig_md5), 'ok': ok}
    if a.json:
        json.dump(dict(res, rows=rows, data_url_list=data_urls, ext_url_list=ext_urls, fonts=dict(fonts), comps={str(k): v for k, v in used_comps.items()}),
                  open(a.json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    lines = [f'# 素材の監査(project {pid}・ルート comp {a.root})', '',
             f'- たどった comp: {len(used_comps)} 個 / 使われる素材: {len(rows)} 個 / 文書に埋まった data URL: {len(data_urls)} 個 / 外の URL: {len(ext_urls)} 個',
             f'- 見比べた元素材のファイル(md5): {len(orig_md5)} 個(materials/ の全ファイル・project {a.orig_project} の全素材・完成版・元の OP)',
             f'- 禁止の場所: {", ".join(FORBIDDEN)}',
             f'- **違反: {len(violations)} 件** → {"合格(元の素材は 0 件)" if ok else "不合格"}', '']
    for v in violations[:200]:
        lines.append(f'  - 違反: {v}')
    lines += ['', '## 素材の出どころ(分類ごとの数)', '', '| 分類 | 数 | 意味 |', '|---|---|---|']
    mean = {'proc': '手続きで描いた絵(PIL など。置き換え表に作り方)', 'gen': 'アプリの生成ジョブ(WAI txt2img)で新しく作った絵', 'gen+proc': '生成した絵 + 手続きの加工(枠・字・切り抜きの配置)',
            'placeholder': '仮の板(置き換え先がまだ無い)', 'derived': 'アプリの加工ジョブ(切り抜きなど)の結果', 'unknown': '出どころ不明(違反)'}
    for k, n in sorted(kinds.items(), key=lambda kv: -kv[1]):
        lines.append(f'| {k} | {n} | {mean.get(k, "")} |')
    lines += ['', '## data URL(文書に埋まった絵・モデル)', '', '| comp | レイヤー | 場所 | 種類 | 大きさ(字数) |', '|---|---|---|---|---|']
    for d in data_urls:
        lines.append(f"| {d['comp']} {used_comps.get(d['comp'], '')} | {d['layer']} | {d['key']} | {d['mime']} | {d['bytes']} |")
    if not data_urls:
        lines.append('| (なし) | | | | |')
    lines += ['', '## 外の URL', '']
    for d in ext_urls[:100]:
        lines.append(f"- comp {d['comp']} / {d['layer']} / {d['key']}: {d['url']}")
    if not ext_urls:
        lines.append('- (なし)')
    lines += ['', '## フォント', '', ', '.join(f'{k}×{n}' for k, n in fonts.most_common()) or '(なし)', '',
              '## 使われる素材の一覧', '', '| 素材 | 分類 | 状態 | 元のどの素材の代わりか | file_path | 作り方 |', '|---|---|---|---|---|---|']
    for r in rows:
        lines.append(f"| {r['asset_id']} | {r['kind']} | {r.get('status', '')} | {str(r.get('for', ''))[-60:]} | {str(r['path']).replace('/home/kigarashi309/workspace/projects/KyChaPoGaS/', '')} | {str(r['how'])[:160].replace('|', '/')} |")
    txt = '\n'.join(lines) + '\n'
    if a.out:
        open(a.out, 'w', encoding='utf-8').write(txt)
    print('\n'.join(lines[:12 + min(len(violations), 30)]))
    print(json.dumps({k: v for k, v in res.items() if k != 'violations'}, ensure_ascii=False))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
