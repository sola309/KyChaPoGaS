#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「さくら」再現 2 巡目・担当 GEN_A: 人物・背景・線画の素材を WAI の txt2img で新しく作り、元と同じ大きさ・同じ箱に置く。

元の素材のファイルは一切開かない。入力は台帳 R/GEN_A/manifest.json(目で見て言葉にしたタグ + geom.json の大きさ・箱の数値)だけ。
  python rebuild_gen_a.py --only 96,75        # その番号だけ(生成 → 切り抜き → 配置 → 登録 → 置き換え表)
  python rebuild_gen_a.py --kinds stand --limit 30
  python rebuild_gen_a.py --redo 96           # シードを替えて作り直す(3 回まで)
  python rebuild_gen_a.py --sheets            # 点検シート R/GEN_A/sheet_XX.jpg
  python rebuild_gen_a.py --compose-only --only 97   # 生成は済み・後処理だけやり直す
"""
import argparse, json, math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rebuild_lib as L
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageFilter, ImageChops
Image.MAX_IMAGE_PIXELS = None

R = os.path.join(L.WORK, 'GEN_A')
OUT = os.path.join(R, 'out'); os.makedirs(OUT, exist_ok=True)
MAN = os.path.join(R, 'manifest.json'); STATE = os.path.join(R, 'state.json')
FONTS = '/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/backend/data/fonts/'
ME = 'GEN_A'


def load_state():
    return json.load(open(STATE, encoding='utf-8')) if os.path.exists(STATE) else {}


def save_state(s):
    json.dump(s, open(STATE + '.tmp', 'w', encoding='utf-8'), ensure_ascii=False, indent=1); os.replace(STATE + '.tmp', STATE)


_paths = {}


def apath(aid):
    if aid not in _paths:
        _paths.clear()
        for a in L.call('GET', f'/api/assets/?project_id={L.PROJECT}'):
            _paths[a['id']] = a['file_path']
    p = _paths[aid]
    assert not any(x in p for x in L.FORBIDDEN), p
    return p


def img(aid):
    return Image.open(apath(aid))


def hexc(s):
    s = s.lstrip('#'); return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


# ---------- 生成の割り当て ----------
def slots(i, m):
    """この素材に要る生成 [(slot, pos, tags, neg, seed, w, h, cut)]"""
    k = m['kind']; seed = m['seed']; pos = m.get('pos', L.WAI_POS); neg = m.get('neg', L.WAI_NEG)
    if m.get('neg_extra'): neg += ', ' + m['neg_extra']
    if k in ('stand', 'opaque', 'diamond', 'window'):
        w, h = m['sz']; return [('main', pos, m['tags'], neg, seed, w, h, k == 'stand')]
    if k == 'mosaic':
        return [(f'c{n}', pos, t + ', long hair, red hair, high ponytail, black hair ribbon, red eyes, fang, sparkle background, pastel background', neg, seed + n, 1024, 1024, False)
                for n, (cx, cy, circ, t) in enumerate(m['cells'])]
    if k == 'thumb':
        out = []
        for n, (t, x, hh) in enumerate(m['figs']):
            full = 'full body' in t
            tt = t + (', long hair, red hair, high ponytail, black hair ribbon, red eyes, fang, simple background, white background' if full
                      else ', upper body, looking at viewer, long hair, red hair, high ponytail, black hair ribbon, red eyes, fang, simple background, white background')
            out.append((f'f{n}', pos, tt, neg, seed + n, 1024 if full else 832, 1024 if full else 1216, True))
        return out
    return []


def run_jobs(reqs, fn, chunk=10):
    """reqs = [(tag, args)] → {tag: (job_id, asset_id)}。chunk 個ずつ積んで待つ。"""
    res = {}
    for a in range(0, len(reqs), chunk):
        js = []
        for tag, args in reqs[a:a + chunk]:
            for tr in range(3):
                try:
                    j, _ = fn(*args, wait=False); js.append((tag, j['id'])); break
                except Exception as e:
                    print('  submit retry', tag, e, flush=True); time.sleep(5)
        for tag, jid in js:
            s = L.wait_job(jid)
            aid = s['result_asset_ids'][0] if s.get('result_asset_ids') else None
            if not aid: print('  FAILED job', jid, tag, s.get('status'), str(s.get('error'))[:200], flush=True)
            res[tag] = (jid, aid)
        print(f'  jobs {min(a + chunk, len(reqs))}/{len(reqs)}', flush=True)
    return res


# ---------- 後処理 ----------
def crop_alpha(im, thr=16):
    im = im.convert('RGBA'); bb = im.getchannel('A').point(lambda v: 255 if v > thr else 0).getbbox()
    return im.crop(bb) if bb else im


def place(fig, m, fit='contain', valign=None):
    W, H = m['w'], m['h']; x0, y0, x1, y1 = m['bbox']; bw, bh = x1 - x0, y1 - y0
    s = (max if fit == 'cover' else min)(bw / fig.width, bh / fig.height)
    f = fig.resize((max(1, round(fig.width * s)), max(1, round(fig.height * s))), Image.LANCZOS)
    cv = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    px = round((x0 + x1) / 2 - f.width / 2)
    py = (y0 if (valign or ('top' if fit == 'cover' else 'bottom')) == 'top' else y1 - f.height)
    cv.alpha_composite(f, (px, py)) if (px >= 0 and py >= 0) else cv.paste(f, (px, py), f)
    return cv


def cover(im, W, H, top=False):
    im = im.convert('RGB'); s = max(W / im.width, H / im.height)
    cw, ch = min(im.width, round(W / s)), min(im.height, round(H / s))
    l = (im.width - cw) // 2; t = 0 if top else (im.height - ch) // 2
    return im.crop((l, t, l + cw, t + ch)).resize((W, H), Image.LANCZOS)


def tint(gray, dark, light, gain=1.0):
    """L を dark〜light の 2 色に写す。gain < 1 = 線を薄く。"""
    g = gray.convert('L')
    if gain != 1.0: g = g.point(lambda v: round(255 - (255 - v) * gain))
    return ImageOps.colorize(g, dark, light)


def font(size, kind='black'):
    return ImageFont.truetype(FONTS + {'black': 'NotoSansJP-Black.otf', 'bold': 'NotoSansJP-Bold.otf', 'light': 'NotoSansJP-Light.otf'}[kind], max(8, int(size)))


def diamond_poly(cx, cy, r):
    return [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]


def make_diamond(content, m):
    """ひし形のステンドグラス風の枠(1920×1080 の中の ひし形 中心 960,540・半対角 529)。2 倍で描いて縮める。"""
    W, H = m['w'], m['h']; S = 2; cx, cy = W / 2 * S, H / 2 * S
    R0 = 529 * S; lw = 12 * S; line = (70, 58, 66, 255)
    cv = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
    side = int(R0 * 2)
    c = tint(cover(content, side, side), (52, 56, 62), (206, 213, 217)).convert('RGBA')
    mask = Image.new('L', cv.size, 0); ImageDraw.Draw(mask).polygon(diamond_poly(cx, cy, R0 - 2), fill=255)
    lay = Image.new('RGBA', cv.size, (0, 0, 0, 0)); lay.paste(c, (int(cx - R0), int(cy - R0)))
    cv = Image.composite(lay, cv, mask); d = ImageDraw.Draw(cv)
    col = hexc(m['corner']) + (255,)
    rc = 95 * S; dc = 415 * S
    for dx, dy in ((0, -1), (1, 0), (0, 1), (-1, 0)):
        p = diamond_poly(cx + dx * dc, cy + dy * dc, rc); d.polygon(p, fill=col); d.line(p + [p[0]], fill=line, width=lw, joint='curve')
    for r in (R0 - lw / 2, 320 * S):
        p = diamond_poly(cx, cy, r); d.line(p + [p[0], p[1]], fill=line, width=lw, joint='curve')
    q = 160 * S; d.rectangle((cx - q, cy - q, cx + q, cy + q), outline=line, width=lw)
    o = 104 * S
    segs = [((-q, -q), (-1, -1)), ((q, q), (1, 1)), ((110 * S, -210 * S), (1, -1)), ((215 * S, -105 * S), (1, -1)), ((-110 * S, 210 * S), (-1, 1)), ((-215 * S, 105 * S), (-1, 1))]
    for (px, py), (ux, uy) in segs:
        d.line((cx + px, cy + py, cx + px + ux * o, cy + py + uy * o), fill=line, width=lw)
    return cv.resize((W, H), Image.LANCZOS)


def make_window(content, m):
    """四角い窓枠(637..1283 × 217..863)。地の色 + 線画(乗算ふう)+ 四隅の濃い色 + 枠の線。"""
    W, H = m['w'], m['h']; S = 2; x0, y0, x1, y1 = [v * S for v in (637, 217, 1283, 863)]; lw = 12 * S; line = (70, 58, 66, 255)
    base = hexc(m['base']); ink = hexc(m['ink'])
    c = tint(cover(content, x1 - x0, y1 - y0), ink, base).convert('RGBA')
    cv = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0)); cv.paste(c, (x0, y0)); d = ImageDraw.Draw(cv)
    vx = [770 * S, 1150 * S]; hy = [350 * S, 728 * S]; col = hexc(m['corner']) + (255,)
    for (a, b) in ((x0, vx[0]), (vx[1], x1)):
        for (e, f) in ((y0, hy[0]), (hy[1], y1)): d.rectangle((a, e, b, f), fill=col)
    for x in vx: d.line((x, y0, x, y1), fill=line, width=lw)
    for y in hy: d.line((x0, y, x1, y), fill=line, width=lw)
    for x in (908 * S, 1012 * S): d.line((x, hy[0], x, hy[1]), fill=line, width=lw)
    d.rectangle((x0, y0, x1, y1), outline=line, width=lw)
    return cv.resize((W, H), Image.LANCZOS)


def make_mosaic(parts, m):
    W, H = m['w'], m['h']; cv = Image.new('RGBA', (W, H), (0, 0, 0, 0)); c = 200
    for n, (cx, cy, circ, t) in enumerate(m['cells']):
        im = tint(cover(parts[f'c{n}'], c, c), (48, 78, 96), (214, 240, 250)).convert('RGBA')
        if circ:
            mk = Image.new('L', (c * 4, c * 4), 0); ImageDraw.Draw(mk).ellipse((0, 0, c * 4 - 1, c * 4 - 1), fill=255); im.putalpha(mk.resize((c, c), Image.LANCZOS))
        cv.alpha_composite(im, (460 + cx * c, 40 + cy * c))
    return cv


def text_layer(W, H, txt, size, col, cxy, stroke=(255, 255, 255), kind='black', sw=None):
    lay = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(lay); f = font(size, kind)
    sw = max(2, int(size * 0.07)) if sw is None else sw
    d.multiline_text(cxy, txt, font=f, fill=col + (255,), anchor='mm', stroke_width=sw, stroke_fill=stroke + (255,), align='left', spacing=size * 0.1)
    return lay


def make_thumb(parts, m):
    W, H = m['w'], m['h']; a, b = hexc(m['bg'][0]), hexc(m['bg'][1])
    g = Image.linear_gradient('L').resize((W, H)); cv = ImageOps.colorize(g, a, b).convert('RGBA'); d = ImageDraw.Draw(cv)
    deco = m.get('deco')
    if deco == 'ring':   # 左に赤い二重丸 + 横の帯
        for y, c in ((0.42, '#d8483c'), (0.5, '#3c7c9c'), (0.58, '#e89080')): d.rectangle((0, H * y, W, H * (y + 0.06)), fill=hexc(c))
        cx, cy = W * 0.2, H * 0.5
        for r, c in ((0.3, '#e05a3c'), (0.22, '#ffffff'), (0.17, '#d83a2c')): d.ellipse((cx - H * r, cy - H * r, cx + H * r, cy + H * r), fill=hexc(c))
    order = sorted(range(len(m['figs'])), key=lambda n: -m['figs'][n][2])
    if deco == 'panel': d.rectangle((0, 0, W * 0.47, H), fill=hexc('#b0204a'))
    for n in order:
        t, x, hh = m['figs'][n]; f = crop_alpha(parts[f'f{n}']); s = H * hh / f.height
        f = f.resize((round(f.width * s), round(f.height * s)), Image.LANCZOS)
        px, py = round(W * x - f.width / 2), H - f.height if hh <= 1 else round(H * 0.02)
        tmp = Image.new('RGBA', (W, H), (0, 0, 0, 0)); tmp.paste(f, (px, py), f); cv.alpha_composite(tmp)
    if deco == 'panel':
        d = ImageDraw.Draw(cv); d.rectangle((0, 0, W * 0.44, H), fill=hexc('#b0204a'))
        for k2, lab in enumerate(('たい焼き', 'ワッフル', '串だんご')):
            x = W * (0.03 + k2 * 0.105); d.rectangle((x, H * 0.38, x + W * 0.095, H * 0.44), fill=hexc('#d83a62'))
            cv.alpha_composite(text_layer(W, H, lab, H * 0.03, (255, 255, 255), (x + W * 0.0475, H * 0.41), sw=0, kind='bold'))
    tx, ty = m['tpos']; col = hexc(m['tcol'])
    stroke = (255, 255, 255) if m['tcol'].lower() != '#ffffff' else (hexc('#b0204a') if deco == 'panel' else hexc('#d83a2c'))
    cv.alpha_composite(text_layer(W, H, m['title'], H * m['tsize'], col, (W * tx, H * ty), stroke=stroke, kind=m.get('font', 'black'), sw=(0 if m['tcol'].lower() == '#ffffff' else None)))
    if m.get('sub'):
        cv.alpha_composite(text_layer(W, H, m['sub'], H * m['tsize'] * 0.22, col, (W * tx, H * (ty + m['tsize'] * (1.15 if '\n' in m['title'] else 0.75))), stroke=stroke, kind='bold', sw=(0 if m['tcol'].lower() == '#ffffff' else 2)))
    return cv.convert('RGB')


def sticker(cv, m):
    """ちび絵のスタンプ: 字と矢印を手続きで足す。"""
    W, H = cv.size; x0, y0, x1, y1 = m['bbox']; col = hexc(m['tcol']); d = ImageDraw.Draw(cv); bw, bh = x1 - x0, y1 - y0
    t = text_layer(W, H, m['text'], bh * 0.14, col, (W // 2, H // 2), stroke=(255, 255, 255)).rotate(18, resample=Image.BICUBIC, center=(W // 2, H // 2))
    cv.alpha_composite(ImageChops.offset(t, int(x0 + bw * (0.16 if m['arrow'] != 'down' else 0.8) - W / 2), int(y0 + bh * 0.1 - H / 2)))
    ax, ay, u = x0 + bw * (0.86 if m['arrow'] == 'up' else 0.1), y0 + bh * 0.62, bh * 0.09
    if m['arrow'] in ('up', 'down'):
        sg = -1 if m['arrow'] == 'up' else 1; ac = (244, 130, 140) if sg < 0 else (110, 170, 240)
        d.polygon([(ax, ay + sg * u * 1.6), (ax - u, ay), (ax - u * .45, ay), (ax - u * .45, ay - sg * u * 1.4), (ax + u * .45, ay - sg * u * 1.4), (ax + u * .45, ay), (ax + u, ay)], fill=ac + (255,), outline=(255, 255, 255, 255))
    else:
        for hx, hy in ((0.1, 0.2), (0.9, 0.25), (0.14, 0.5)):
            cx, cy, r = x0 + bw * hx, y0 + bh * hy, bh * 0.035
            d.ellipse((cx - r * 2, cy - r, cx, cy + r), fill=(250, 100, 160, 255)); d.ellipse((cx, cy - r, cx + r * 2, cy + r), fill=(250, 100, 160, 255))
            d.polygon([(cx - r * 1.9, cy + r * .3), (cx + r * 1.9, cy + r * .3), (cx, cy + r * 2.4)], fill=(250, 100, 160, 255))
    return cv


def compose(i, m, st):
    k = m['kind']; W, H = m['w'], m['h']
    if k == 'stand':
        fig = crop_alpha(img(st['cut']['main']))
        if m.get('post') == 'desat':
            rgb = fig.convert('RGB'); g = ImageOps.grayscale(rgb).convert('RGB'); rgb = Image.blend(rgb, g, 0.45); rgb = Image.blend(rgb, Image.new('RGB', rgb.size, (226, 218, 200)), 0.25)
            rgb.putalpha(fig.getchannel('A')); fig = rgb
        if m.get('post') == 'sticker':
            x0, y0, x1, y1 = m['bbox']; m2 = dict(m, bbox=[x0 + (x1 - x0) * 0.08, y0 + (y1 - y0) * 0.12, x1 - (x1 - x0) * 0.08, y1])
            return sticker(place(fig, m2), m), 'gen+proc', 'cutout → 元の箱に合わせて配置 → 字と矢印を PIL で'
        return place(fig, m, m.get('fit', 'contain')), 'gen+proc', 'cutout → 元の箱(bbox)に合わせて配置' + ('(覆う合わせ)' if m.get('fit') == 'cover' else '')
    if k == 'opaque':
        src = img(st['gen']['main']).convert('RGB'); p = m.get('post')
        if m.get('crop_top'): src = src.crop((src.width // 4, 0, src.width * 3 // 4, src.height * 45 // 100))
        if p == 'tint':
            out = tint(cover(src, W, H), hexc(m['ink']), hexc(m['paper']), m.get('gain', 1.0)); return out, 'gen+proc', '縦横比に切って拡大 → 線の色・紙の色に写す'
        out = cover(src, W, H)
        if p == 'bars':
            d = ImageDraw.Draw(out); d.rectangle((0, 0, W, H * 0.065), fill=(255, 255, 255)); d.rectangle((0, H * 0.94, W, H), fill=(255, 255, 255)); return out, 'gen+proc', '切って拡大 → 上下に白い帯'
        if p == 'wash':
            return Image.blend(out, Image.new('RGB', (W, H), (250, 246, 248)), 0.6), 'gen+proc', '切って拡大 → 白を 60% 重ねて淡く'
        return out, 'gen', '元の縦横比に切って w×h に拡大(Lanczos)'
    if k == 'diamond': return make_diamond(img(st['gen']['main']), m), 'gen+proc', 'make_diamond: 灰色の網点ふうに色づけ → ひし形の枠(PIL)にはめる'
    if k == 'window': return make_window(img(st['gen']['main']), m), 'gen+proc', 'make_window: 線画を地の色に重ね → 窓枠(PIL)'
    if k == 'mosaic': return make_mosaic({s: img(a) for s, a in st['gen'].items()}, m), 'gen+proc', 'make_mosaic: 16 枚を青の単色に → 200px の市松(丸 4 つ)'
    if k == 'thumb': return make_thumb({s: img(a) for s, a in st['cut'].items()}, m), 'gen+proc', 'make_thumb: 切り抜いた人物を並べ、題字「%s」を PIL + NotoSansJP で' % m['title'].replace('\n', ' ')
    raise ValueError(k)


def process(ids, M, S, compose_only=False):
    todo = [i for i in ids if M[i]['kind'] not in ('skip', 'alias')]
    if not compose_only:
        reqs = []
        for i in todo:
            st = S.setdefault(i, {'att': 0, 'gen': {}, 'cut': {}, 'jobs': {}})
            for (slot, pos, tags, neg, seed, w, h, cut) in slots(i, M[i]):
                if not st['gen'].get(slot):
                    sd = seed + 1000 * st['att']
                    reqs.append(((i, slot), (tags, sd, w, h, pos, neg)))
                    st['jobs'][slot] = {'seed': sd}
        print('gen', len(reqs), flush=True)
        for (i, slot), (jid, aid) in run_jobs(reqs, L.wai).items():
            S[i]['gen'][slot] = aid; S[i]['jobs'][slot]['job'] = jid
        save_state(S)
        reqs = []
        for i in todo:
            for (slot, *_r, cut) in slots(i, M[i]):
                if cut and S[i]['gen'].get(slot) and not S[i]['cut'].get(slot): reqs.append(((i, slot), (S[i]['gen'][slot],)))
        print('cutout', len(reqs), flush=True)
        for (i, slot), (jid, aid) in run_jobs(reqs, L.cutout).items():
            S[i]['cut'][slot] = aid
        save_state(S)
    for i in todo:
        m = M[i]; st = S[i]
        try:
            im, kind, how = compose(i, m, st)
        except Exception as e:
            print('  compose NG', i, repr(e), flush=True); continue
        assert im.size == (m['w'], m['h']), (i, im.size)
        p = os.path.join(OUT, f'{int(i):03d}.png'); im.save(p)
        a = L.upload(p, f'genA_{int(i):03d}_a{st["att"]}.png')
        st['asset'] = a['id']; st['kind'] = kind
        jobs = ' / '.join(f"job {v.get('job')} seed {v.get('seed')}" for v in st['jobs'].values())
        st['how'] = f"WAI txt2img {jobs} tags: {m['tags'][:160]} → {how}"
        put_row(i, m, st)
        save_state(S); print('  ok', i, a['id'], flush=True)
    for i in ids:
        if M[i]['kind'] == 'alias':
            o = str(M[i]['of'])
            if S.get(o, {}).get('asset'):
                S[i] = dict(S[o], alias=o); put_row(i, M[i], S[i]); save_state(S)


def put_row(i, m, st):
    note = st.get('note') or '絵は出来・未確認'
    if m['kind'] == 'alias': note += '。#%s と同じ絵(元の表情の差分は作れていない)' % m['of']
    L.put(ME, m['key'], st['asset'], m['w'], m['h'], st.get('kind', 'gen+proc'), st['how'], '仮', note, n=int(i), attempt=st.get('att', 0))


def sheets(M, S, ids=None, prefix='sheet', per=20, cols=5, cw=380, ch=420):
    ids = ids or [i for i in sorted(M, key=int) if os.path.exists(os.path.join(OUT, f'{int(i):03d}.png')) and M[i]['kind'] not in ('skip',)]
    f = ImageFont.truetype(FONTS + 'NotoSansJP-Bold.otf', 20); n = 0
    for a in range(0, len(ids), per):
        part = ids[a:a + per]; rows = (len(part) + cols - 1) // cols
        sh = Image.new('RGB', (cols * cw, rows * ch), (96, 96, 112)); d = ImageDraw.Draw(sh)
        for k, i in enumerate(part):
            src = f'{int(M[i]["of"]):03d}' if M[i]['kind'] == 'alias' else f'{int(i):03d}'
            im = Image.open(os.path.join(OUT, src + '.png')).convert('RGBA'); im.thumbnail((cw - 8, ch - 34))
            bg = Image.new('RGBA', im.size, (128, 128, 140, 255)); bg.alpha_composite(im)
            x, y = (k % cols) * cw + 4, (k // cols) * ch + 2; sh.paste(bg.convert('RGB'), (x, y))
            d.text((x, y + ch - 32), f'#{i} a{S.get(i, {}).get("att", 0)} {M[i]["kind"]}', font=f, fill=(255, 255, 0))
        p = os.path.join(R, f'{prefix}_{n:02d}.jpg'); sh.save(p, quality=85); print(p); n += 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only'); ap.add_argument('--kinds'); ap.add_argument('--limit', type=int); ap.add_argument('--redo'); ap.add_argument('--note')
    ap.add_argument('--sheets', action='store_true'); ap.add_argument('--compose-only', action='store_true'); ap.add_argument('--prefix', default='sheet')
    a = ap.parse_args()
    M = json.load(open(MAN, encoding='utf-8')); S = load_state()
    if a.sheets:
        return sheets(M, S, a.only.split(',') if a.only else None, a.prefix)
    if a.redo:
        ids = a.redo.split(',')
        for i in ids:
            st = S[i]; assert st['att'] < 3, f'{i}: 3 回まで'
            S[i] = {'att': st['att'] + 1, 'gen': {}, 'cut': {}, 'jobs': {}, 'prev': st.get('prev', []) + [st.get('asset')]}
        save_state(S)
    elif a.only:
        ids = a.only.split(',')
    else:
        ids = sorted(M, key=lambda i: -M[i]['frames'])
        if a.kinds: ids = [i for i in ids if M[i]['kind'] in a.kinds.split(',')]
        ids = [i for i in ids if not S.get(i, {}).get('asset')]
        if a.limit: ids = ids[:a.limit]
    if a.note:
        for i in ids: S[i]['note'] = a.note; put_row(i, M[i], S[i])
        return save_state(S)
    process(ids, M, S, a.compose_only)


if __name__ == '__main__':
    main()
