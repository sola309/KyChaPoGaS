#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""恋妹 2022 再現 (project 38): 素材の絵を WAI の txt2img で新しく作り、元と同じ大きさの PNG にして登録する。

元の素材のファイルは開かない。入力は「手本の動画を見て言葉にした台帳」(describe_*.json: fid・kind・tags)と、
AE のプロジェクトに書いてある素材の大きさ (aep_full.json の width / height) だけ。

    python koiimo_gen.py --desc DIR/describe_*.json --aep aep_full_v21.json --work WORK [--only 39,45] [--kinds stand,chibi] [--redo 39]

出力: WORK/assets_map.json = {"<AE の素材 id>": {"asset_id": N, "kind", "tags", "seed", "status": "仮"}}
      → aep_to_comp.py --assets WORK/assets_map.json で仮の板の代わりに置かれる。
生成した絵はすべて「仮」(ユーザーが見るまで)。
"""
import argparse
import glob
import json
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rebuild_lib as L  # noqa: E402  (wai / cutout / upload / call を使う。project は引数で 38 を渡す)

PROJECT = 38
FORBIDDEN = ('reference/aviutl_mad/koiimo/1111_', 'I:\\', 'I:/', 'sola2070')
CUT = {'stand', 'chibi', 'object', 'logo_text'}
NEG_EXTRA = {
    'stand': 'background, scenery',
    'chibi': 'background, scenery',
    'object': '1girl, person, background',
    'bg': '1girl, person, people, character',
}
POS_SUFFIX = {
    'stand': ', simple background, white background',
    'chibi': ', chibi, simple background, white background',
    'object': ', no humans, still life, simple background, white background',
    'bg': ', no humans, scenery',
    'sketch': ', sketch, line art, traditional media',
}


def bucket(w, h, area=1024 * 1024):
    """元の縦横比に近い SDXL の大きさ (64 の倍数・約 1 MP)"""
    ar = (w / h) if w and h else 1.0
    ar = max(0.25, min(4.0, ar))
    hh = (area / ar) ** 0.5
    ww = hh * ar
    return int(round(ww / 64) * 64), int(round(hh / 64) * 64)


def fit_canvas(src, W, H, kind):
    """生成した絵を元の大きさ W×H の画布に入れる。切り抜きは縦横比を保って収め、立ち絵は下にそろえる。背景は覆うように拡大して中央を切る"""
    if kind in CUT:
        im = src.convert('RGBA')
        s = min(W / im.width, H / im.height)
        im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
        out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        y = H - im.height if kind in ('stand', 'chibi') else (H - im.height) // 2
        out.alpha_composite(im, ((W - im.width) // 2, y))
        return out
    im = src.convert('RGB')
    s = max(W / im.width, H / im.height)
    im = im.resize((max(W, int(round(im.width * s))), max(H, int(round(im.height * s)))), Image.LANCZOS)
    x, y = (im.width - W) // 2, (im.height - H) // 2
    return im.crop((x, y, x + W, y + H))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--desc', nargs='+', required=True)
    ap.add_argument('--aep', required=True)
    ap.add_argument('--work', required=True)
    ap.add_argument('--only', default='')
    ap.add_argument('--kinds', default='')
    ap.add_argument('--redo', default='')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--max-side', type=int, default=4096, help='元が大きすぎるときの上限 (長い辺)')
    a = ap.parse_args()
    os.makedirs(os.path.join(a.work, 'gen'), exist_ok=True)
    mp = os.path.join(a.work, 'assets_map.json')
    amap = json.load(open(mp)) if os.path.exists(mp) else {}
    items = {i['id']: i for i in json.load(open(a.aep, encoding='utf-8'))['items']}
    rows = []
    for pat in a.desc:
        for f in glob.glob(pat):
            rows += json.load(open(f, encoding='utf-8'))
    only = {int(x) for x in a.only.split(',') if x}
    redo = {int(x) for x in a.redo.split(',') if x}
    kinds = {x for x in a.kinds.split(',') if x}
    n = 0
    for r in rows:
        fid, kind = int(r['fid']), r.get('kind', 'unknown')
        if only and fid not in only:
            continue
        if kinds and kind not in kinds:
            continue
        if kind in ('video', 'unknown') or not r.get('tags'):
            continue
        key = str(fid)
        if key in amap and fid not in redo:
            continue
        it = items.get(fid, {})
        W, H = int(it.get('width') or 1024), int(it.get('height') or 1024)
        if max(W, H) > a.max_side:
            s = a.max_side / max(W, H)
            W, H = int(W * s), int(H * s)
        gw, gh = bucket(W, H)
        seed = 380000 + fid * 7 + (amap.get(key, {}).get('tries', 0) * 1000 if fid in redo else 0)
        multi = bool(r.get('multi'))
        pos = ('masterpiece, best quality, ' if multi else L.WAI_POS)
        tags = r['tags'] + POS_SUFFIX.get(kind, '')
        if kind in ('bg', 'object'):
            pos = 'masterpiece, best quality, '
        print(f'[{fid}] {kind} {W}x{H} gen {gw}x{gh} seed {seed}: {tags[:90]}', flush=True)
        job, aid = L.wai(tags, seed, w=gw, h=gh, pos=pos, neg_extra=NEG_EXTRA.get(kind, ''), project_id=PROJECT)
        if not aid:
            print('  生成に失敗', job.get('error'), flush=True)
            continue
        src_aid = aid
        if kind in CUT:
            j2, cut = L.cutout(aid)
            if cut:
                aid = cut
        path = None
        for x in L.call('GET', f'/api/assets/?project_id={PROJECT}'):
            if x['id'] == aid:
                path = x['file_path']
        assert path and not any(t in path for t in FORBIDDEN), path
        out = fit_canvas(Image.open(path), W, H, kind)
        op = os.path.join(a.work, 'gen', f'{fid}.png')
        out.save(op)
        up = L.upload(op, name=f'koiimo_{fid}_{kind}.png', project_id=PROJECT)
        amap[key] = {'asset_id': up['id'], 'kind': kind, 'tags': r['tags'], 'seed': seed, 'gen_asset': src_aid,
                     'status': '仮', 'tries': amap.get(key, {}).get('tries', 0) + 1, 'w': W, 'h': H}
        json.dump(amap, open(mp + '.tmp', 'w'), ensure_ascii=False, indent=1)
        os.replace(mp + '.tmp', mp)
        print(f'  → asset {up["id"]}', flush=True)
        n += 1
        if a.limit and n >= a.limit:
            break
    print('done', n)


if __name__ == '__main__':
    main()
