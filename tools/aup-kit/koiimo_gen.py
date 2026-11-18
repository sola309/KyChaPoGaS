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
    # 切り抜く絵は髪・体が絵の端で途切れないように (11/18 指摘。途切れたら koiimo_fixcut.py で描き足す)
    'stand': 'background, scenery, cropped, out of frame, cut off, head out of frame',
    'chibi': 'background, scenery, cropped, out of frame, cut off',
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


# 杏子のデザインの決まり (memory: kyoko-hair-tv-style・kyoko-ponytail-volume・kyoko-bangs-check)。台帳の説明に別の髪色・髪型が
# 書いてあっても、人物の絵は必ずこの形に直す (ファンアートの描き分けより「杏子に見える」ことを優先)
KYOKO_FIX = ('sakura kyoko, long hair, red hair, high ponytail, thick ponytail, black hair ribbon, hair bow, '
             'sidelocks, pointy bangs, red eyes, fang, smooth hair, large hair strands')
KYOKO_NEG = ('black hair, brown hair, orange hair, blonde hair, pink hair, purple hair, blue hair, gradient hair, multicolored hair, '
             'wavy hair, curly hair, short hair, twintails, braid, low ponytail, messy hair, flyaway hair, dark hair shadow, '
             'other characters, 2girls, multiple girls, greyscale, desaturated, muted colors, blurry')
HAIR_WORDS = ('hair', 'ponytail', 'twintails', 'braid', 'bangs', 'eyes', 'ribbon', 'bow')
PERSON_KINDS = {'stand', 'chibi', 'bust', 'scene', 'sketch'}


def kyoko_tags(tags, kind, multi):
    """人物の絵: 髪・目の説明を消して決まりの塊を足す。何人も並ぶ絵は「全員が杏子」と書く"""
    if kind not in PERSON_KINDS:
        return tags, ''
    keep = [t.strip() for t in tags.split(',') if t.strip() and not any(w in t for w in HAIR_WORDS)
            and t.strip() not in ('1girl', '2girls', '3girls', 'multiple girls', 'sakura kyoko', 'miki sayaka', 'akemi homura')]
    if multi:
        head = 'multiple girls, everyone is sakura kyoko, same face, ' + KYOKO_FIX
        neg = KYOKO_NEG.replace('other characters, 2girls, multiple girls, ', 'other characters, ')
    else:
        head = KYOKO_FIX
        neg = KYOKO_NEG
    if kind == 'sketch':
        neg = neg.replace('greyscale, desaturated, ', '')
    return head + ', ' + ', '.join(keep), neg


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


POSES = ['standing, hand on hip', 'peace sign, smile', 'arms behind back, leaning forward', 'waving, open mouth',
         'holding spear, confident', 'eating pocky, one eye closed', 'arms crossed, smirk', 'jumping, happy']


def compose_multi(a, r, W, H, seed, style_pos):
    """何人も並ぶ絵: WAI に一度に描かせると別の子が混ざるので、杏子を 1 人ずつ描いて切り抜き、背景 (人なし) の上に並べる"""
    import re
    kind = r.get('kind')
    m = re.search(r'(\d+)\+?girls', r['tags'])
    n = max(2, min(8, int(m.group(1)) if m else 5))
    body, kneg = kyoko_tags(r['tags'], 'stand', False)
    keep = ', '.join(t for t in body.split(', ')[len(KYOKO_FIX.split(', ')):] if not re.search(r'girls|everyone|same face|clones|multiple', t))
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    if kind == 'scene':
        bw, bh = bucket(W, H)
        _, bg = L.wai(keep + ', no humans, scenery, background', seed + 1, w=bw, h=bh, pos='masterpiece, best quality, ',
                      neg_extra='1girl, person, people, character', project_id=PROJECT)
        if bg:
            canvas = fit_canvas(Image.open(asset_file(bg)), W, H, 'bg').convert('RGBA')
    figs = []
    for i in range(n):
        tags = KYOKO_FIX + ', full body, ' + POSES[i % len(POSES)] + ', ' + keep + POS_SUFFIX['stand']
        _, gid = L.wai(tags, seed + 10 + i, w=832, h=1216, pos='1girl, solo, ' + style_pos, neg_extra=NEG_EXTRA['stand'] + ', ' + kneg,
                       project_id=PROJECT)
        if not gid:
            continue
        _, cut = L.cutout(gid)
        im = Image.open(asset_file(cut or gid)).convert('RGBA')
        bb = im.getbbox()
        figs.append(im.crop(bb) if bb else im)
    # 奥の列 (小さめ・上) と手前の列 (大きめ・下) を交互に。左右に均等
    for i, im in enumerate(figs):
        back = (i % 2 == 1)
        h = int(H * (0.78 if back else 0.95))
        s = h / im.height
        im = im.resize((max(1, int(im.width * s)), h), Image.LANCZOS)
        cx = int(W * (i + 0.5) / len(figs))
        y = int(H * (0.02 if back else 0.05)) + (H - h) - int(H * 0.05)
        canvas.alpha_composite(im, (cx - im.width // 2, max(0, y)))
    return canvas


def asset_file(aid):
    for x in L.call('GET', f'/api/assets/?project_id={PROJECT}'):
        if x['id'] == aid:
            assert not any(t in x['file_path'] for t in FORBIDDEN)
            return x['file_path']
    raise KeyError(aid)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--desc', nargs='+', required=True)
    ap.add_argument('--aep', required=True)
    ap.add_argument('--work', required=True)
    ap.add_argument('--only', default='')
    ap.add_argument('--kinds', default='')
    ap.add_argument('--redo', default='')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--compose-multi', action='store_true', help='何人も並ぶ絵は 1 人ずつ描いて合成する')
    ap.add_argument('--style', default='ume', choices=['anime', 'ume'], help='ume = 蒼樹うめ風 (11/18 ユーザーが選んだ既定) / anime = TV アニメの塗り')
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
    names = {i: os.path.basename((items.get(i, {}).get('path') or items.get(i, {}).get('name') or '').replace('\\', '/'))
             for i in items}
    seen_name = {}   # 同じ PSD の別レイヤー → 最初の 1 枚だけ描き、残りは透明
    seen_tags = {}   # 連番 (… コンポジション 1_000NN) は同じ絵を使い回す
    n = 0
    for r in rows:
        fid, kind = int(r['fid']), r.get('kind', 'unknown')
        nm = names.get(fid, '')
        if r.get('tags') and kind not in ('video', 'unknown') and str(fid) not in amap:
            if nm in seen_name and nm.lower().endswith(('.psd', '.psb')) and seen_name[nm][1] == r['tags']:
                it = items.get(fid, {})
                W, H = int(it.get('width') or 16), int(it.get('height') or 16)
                op = os.path.join(a.work, 'gen', f'{fid}.png')
                Image.new('RGBA', (max(1, min(W, 4096)), max(1, min(H, 4096))), (0, 0, 0, 0)).save(op)
                up = L.upload(op, name=f'koiimo_{fid}_empty.png', project_id=PROJECT)
                amap[str(fid)] = {'asset_id': up['id'], 'kind': 'empty', 'status': '仮', 'note': f'同じ PSD ({nm}) の別レイヤー。絵は {seen_name[nm][0]} に 1 枚で描いた'}
                print(f'[{fid}] 同じ PSD の別レイヤー → 透明', flush=True)
                continue
            if 'コンポジション' in nm and r['tags'] in seen_tags and str(seen_tags[r['tags']]) in amap:
                src = amap[str(seen_tags[r['tags']])]
                it = items.get(fid, {})
                W, H = int(it.get('width') or 1024), int(it.get('height') or 1024)
                op = os.path.join(a.work, 'gen', f'{fid}.png')
                fit_canvas(Image.open(os.path.join(a.work, 'gen', f'{seen_tags[r["tags"]]}.png')), W, H, src['kind']).save(op)
                up = L.upload(op, name=f'koiimo_{fid}_seq.png', project_id=PROJECT)
                amap[str(fid)] = dict(src, asset_id=up['id'], note=f'連番の 1 コマ。{seen_tags[r["tags"]]} と同じ絵 (動きは無い)')
                print(f'[{fid}] 連番 → {seen_tags[r["tags"]]} の絵を使い回す', flush=True)
                continue
        if r.get('tags'):
            seen_name.setdefault(nm, (fid, r['tags']))
            seen_tags.setdefault(r['tags'], fid)
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
        W, H = int(r.get('w') or it.get('width') or 1024), int(r.get('h') or it.get('height') or 1024)  # 台帳に w/h があればそれ (動画の場面の背景など)
        if max(W, H) > a.max_side:
            s = a.max_side / max(W, H)
            W, H = int(W * s), int(H * s)
        gw, gh = bucket(W, H)
        seed = 380000 + fid * 7 + (amap.get(key, {}).get('tries', 0) * 1000 if fid in redo else 0)
        multi = bool(r.get('multi'))
        body, kneg = kyoko_tags(r['tags'], kind, multi)
        tags = body + POS_SUFFIX.get(kind, '')
        pos = ('1girl, solo, ' if kind in PERSON_KINDS and not multi else '') + 'masterpiece, best quality, amazing quality, mahou shoujo madoka magica, ' + \
            ('aoki ume, ' if a.style == 'ume' else 'anime screencap, anime coloring, ')
        if kind in ('bg', 'object'):
            pos = 'masterpiece, best quality, '
        if multi and a.compose_multi:
            print(f'[{fid}] 何人も並ぶ絵 → 1 人ずつ描いて合成 {W}x{H}', flush=True)
            out = compose_multi(a, r, W, H, seed, pos.replace('1girl, solo, ', ''))
            op = os.path.join(a.work, 'gen', f'{fid}.png')
            out.save(op)
            up = L.upload(op, name=f'koiimo_{fid}_multi.png', project_id=PROJECT)
            amap[key] = {'asset_id': up['id'], 'kind': kind, 'tags': r['tags'], 'seed': seed, 'status': '仮', 'how': '1 人ずつ描いて合成',
                         'tries': amap.get(key, {}).get('tries', 0) + 1, 'w': W, 'h': H}
            json.dump(amap, open(mp + '.tmp', 'w'), ensure_ascii=False, indent=1)
            os.replace(mp + '.tmp', mp)
            print(f'  → asset {up["id"]}', flush=True)
            continue
        print(f'[{fid}] {kind} {W}x{H} gen {gw}x{gh} seed {seed}: {tags[:90]}', flush=True)
        job, aid = L.wai(tags, seed, w=gw, h=gh, pos=pos, neg_extra=', '.join(x for x in (NEG_EXTRA.get(kind, ''), kneg, r.get('neg', '')) if x), project_id=PROJECT)
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
