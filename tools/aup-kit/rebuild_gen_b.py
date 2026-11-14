#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「さくら」再現 2 巡目 担当 GEN_B: 元素材 #200〜#378 の人物絵・カード絵・アイコン・背景を WAI の txt2img で作り直す。

元の素材のファイルは一切開かない。使うのは 大きさ・bbox(R/look/geom.json の数値)と、目で見て書いたタグ(下の T)だけ。

  init            台帳 R/GEN_B/manifest.json を作る(既にある値は残す)
  gen  [--only N,N] [--redo N,N]   WAI 生成(10 枚ずつ積んで待つ)。--redo はシードを +1 して作り直す
  post [--only N,N]   切り抜き → 元の箱に合わせて配置 → upload → put
  sheet           点検シート R/GEN_B/sheet_XX.jpg(20 枚ずつ)
  ledger          R/GEN_B/LEDGER.md

mode: cut   = 白背景で生成 → cutout → bbox に等比で収める(fit=contain: 足もと・中心合わせ / cover: 箱を覆って上寄せ)
      key   = cut + 白でない所(炎などの効果)も残す
      opq   = 不透明。元の縦横比に切って w×h へ(Lanczos)
      box   = 不透明の絵を bbox に置き、外は透明
      sp    = 特別(SPECIAL の関数)
"""
import json
import math
import os
import sys
import time

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

import rebuild_lib as L

R = os.path.join(L.WORK, 'GEN_B')
OUT = os.path.join(R, 'out')
MAN = os.path.join(R, 'manifest.json')
FONT = '/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/backend/data/fonts/NotoSansJP-Black.otf'
AG = 'GEN_B'

H = 'long hair, red hair, high ponytail, black hair ribbon, red eyes, fang, '
HD = 'very long hair, red hair, hair down, red eyes, fang, '
MG = 'magical girl, red sleeveless dress, detached sleeves, pink skirt, black thighhighs, red boots, soul gem, '
WB = 'simple background, white background'
FB = 'full body, standing, ' + WB
CHIBI = 'chibi, full body, ' + WB
P5 = 'masterpiece, best quality, mahou shoujo madoka magica, aoki ume, 5girls, kaname madoka, akemi homura, miki sayaka, tomoe mami, sakura kyoko, '
PBG = 'masterpiece, best quality, no humans, scenery, anime background, '
CARD = 'upper body, close-up, looking at viewer, '
ICON = 'portrait, face focus, close-up, looking at viewer, '

# 番号: (mode, タグ, 追加の指定)
T = {
    200: ('sp', H + MG + 'open mouth, angry, shouting, arms spread, ' + CHIBI, {}),
    201: ('cut', H + MG + 'sigh, tired, hand on own cheek, half-closed eyes, ' + CHIBI, {}),
    202: ('sp', H + MG + 'angry, anger vein, pout, clenched hands, upper body, chibi, ' + WB, {}),
    203: ('cut', HD + 'blue striped pajamas, white shirt with blue vertical stripes, black socks, sitting, wariza, looking at viewer, ' + CHIBI, {}),
    209: ('cut', H + 'rabbit ears, maid, black dress, white apron, maid headdress, holding tray, food on tray, ' + FB, {}),
    212: ('sp', H + 'red sleeveless dress, detached sleeves, soul gem, pointing at viewer, foreshortening, closed eyes, pout, blush, upper body, white background, polka dot background, colorful polka dots', {'gw': 1216, 'gh': 832}),
    215: ('sp', '', {'from': 212}),
    217: ('opq', H + 'black sports bikini, beach volleyball, volleyball net, leaning forward, from side, upper body, beach, blue sky, summer, open mouth, smile', {}),
    218: ('opq', H + 'hair flower, yellow flower, red bikini, sarong, pareo, bracelet, reaching out, outstretched arm, smile, cowboy shot, beach, pastel background, sparkle', {}),
    219: ('key', H + MG + 'holding spear, polearm, chain, fighting stance, dynamic pose, fire, flame, sparks, action, full body, ' + WB, {'gw': 1216, 'gh': 832}),
    220: ('opq', H + 'red swimsuit, frilled bikini, sarong, jumping, splashing, water, ocean, palm tree, red sky, swirl, summer, full body, dynamic angle, smile, open mouth', {}),
    221: ('opq', H + 'red kimono, floral print, yellow obi, smile, open mouth, ' + CARD + 'fireworks, night sky, colorful background', {}),
    222: ('opq', H + 'black kimono, cherry blossom print, pink obi, chick on head, bird on head, holding bowl, arm up, smile, open mouth, ' + CARD + 'purple background, sparkle, glitter', {}),
    223: ('opq', H + 'gakuran, black jacket, white gloves, white headband, hachimaki, arm up, cheering, open mouth, ' + CARD + 'orange background, polka dot background', {}),
    224: ('opq', H + 'wedding dress, pink dress, bridal veil, frills, holding basket, rose, flower basket, light smile, ' + CARD + 'lace background, white background, light blue background, ribbon', {}),
    225: ('opq', H + 'red sleeveless dress, detached sleeves, soul gem, holding spear, polearm, serious, ' + CARD + 'striped background, vertical stripes, orange background, pastel colors', {}),
    226: ('opq', H + 'teal hoodie, green hoodie, holding fork, open mouth, smile, ' + CARD + 'striped background, vertical stripes, orange background, pastel colors', {}),
    227: ('opq', H + 'santa costume, red capelet, fur trim, red dress, holding food, meat on bone, ' + CARD + 'night sky, starry sky, dark blue background, snowflakes', {}),
    228: ('opq', H + 'red sleeveless dress, detached sleeves, soul gem, spear, expressionless, ' + CARD + 'striped background, vertical stripes, star (symbol), pastel colors, orange background', {}),
    229: ('opq', H + 'green hoodie, pocky in mouth, hand on own hip, looking back, from side, ' + CARD + 'striped background, polka dot, orange background, pastel colors', {}),
    230: ('opq', H + 'black jacket, fur collar, white collared shirt, necktie, formal, heart, holding rose, smirk, ' + CARD + 'brown background, glitter, bokeh, dark background', {}),
    231: ('opq', H + 'dark blue kimono, haori, white tassel, grin, teeth, ' + CARD + 'floral background, pink background, flower', {}),
    232: ('opq', H + 'red sleeveless dress, detached sleeves, soul gem, holding spear, thrusting, attack, angry, open mouth, dynamic pose, ' + CARD + 'star (symbol), pastel background, orange background', {}),
    233: ('opq', H + 'red sleeveless dress, detached sleeves, pink skirt, holding umbrella, red umbrella, one eye closed, smile, dynamic pose, cowboy shot, striped background, vertical stripes, pastel colors', {}),
    234: ('opq', H + 'red sleeveless dress, detached sleeves, pink skirt, holding spear, polearm, standing, cowboy shot, looking at viewer, striped background, vertical stripes, pastel colors, lace', {}),
    235: ('opq', H + 'pink cardigan, open cardigan, white t-shirt, print shirt, belt, plaid skirt, arms behind head, arms up, cowboy shot, looking at viewer, floral background, pink background', {}),
    236: ('opq', H + 'grey coat, leopard print, fur scarf, dark red dress, hand to own mouth, eating, one eye closed, cowboy shot, floral background, pink background', {}),
    256: ('cut', H + 'holding umbrella, black umbrella, sky print inside umbrella, blue sky and clouds pattern, navy blue dress, white collar, long sleeves, red ribbon, looking at viewer, cowboy shot, ' + WB, {}),
    257: ('sp', '', {'from': 259}),
    258: ('sp', '', {'from': 259}),
    259: ('sp', H + 'hair flower, red bikini, orange sarong, pareo, jumping, midair, arms up, beach ball, from below, blue sky, cumulonimbus cloud, sun, sunlight, lens flare, ocean, rock, summer, full body', {'gw': 1024, 'gh': 1024}),
    260: ('cut', H + 'green kimono, furisode, floral print, long sleeves, obi, hair ornament, zouri, ' + FB, {}),
    261: ('opq', 'shrine, japanese shrine, torii, festival, food stall, yatai, paper lantern, stone pavement, blue sky, cloud, day, wide shot', {'pos': PBG, 'gw': 1216, 'gh': 832}),
    262: ('cut', H + 'white hoodie, pink skirt, brown boots, smile, open mouth, ' + CHIBI, {}),
    263: ('sp', 'cherry blossoms, branch, cherry blossom branch, pink flower, still life, white background, simple background', {'pos': PBG, 'gw': 1024, 'gh': 1024}),
    264: ('cut', H + 'pink hair ribbon, pink jacket, open jacket, white camisole, necklace, denim shorts, sandals, sitting, kneeling, leaning to the side, arm support, looking at viewer, smile, full body, ' + WB, {}),
    265: ('cut', H + 'junihitoe, layered kimono, green kimono, yellow kimono, hair ornament, kanzashi, holding folding fan, arm up, smile, cowboy shot, ' + WB, {}),
    266: ('cut', H + 'red kimono, floral print, obi, holding cotton candy, zouri, smile, ' + FB, {}),
    267: ('cut', H + 'hair flower, blue striped bikini, striped swimsuit, standing on one leg, arm up, waving, smile, barefoot, ' + FB, {}),
    268: ('cut', H + 'top hat, striped hat, white shirt, red vest, bowtie, red striped pants, baggy pants, circus, magician, holding candy, ' + FB, {}),
    269: ('cut', H + 'gothic lolita, holding parasol, pink parasol, green corset, pink frilled skirt, striped thighhighs, one eye closed, smile, ' + FB, {}),
    271: ('cut', H + MG + 'full body, standing, hand on own hip, pocky in mouth, looking to the side, ' + WB, {}),
    272: ('cut', H + 'black coat, red scarf, holding box, pocky box, holding dango, food, smile, open mouth, upper body, ' + WB, {'fit': 'cover', 'gw': 1216, 'gh': 832}),
    273: ('cut', H + 'red-framed eyewear, glasses, red hair ribbon, yellow sweater, holding pocky, grin, teeth, upper body, ' + WB, {'fit': 'cover', 'gw': 1216, 'gh': 832}),
    276: ('cut', H + 'cheerleader, blue and red cheerleader uniform, pleated skirt, orange pom poms, holding pom poms, jumping, standing on one leg, leg up, sneakers, smile, open mouth, full body, ' + WB, {}),
    277: ('cut', H + 'white fur coat, white hood, fluffy, white dress, red pantyhose, white boots, pom pom (clothes), from side, ' + FB, {}),
    278: ('cut', HD + 'white sundress, sleeveless dress, barefoot, dancing, outstretched arms, standing on one leg, smile, full body, ' + WB, {}),
    279: ('cut', H + 'blue polo shirt, short sleeves, black pleated skirt, black kneehighs, loafers, arms at sides, ' + FB, {}),
    280: ('sp', '', {'from': 281}),
    281: ('cut', H + 'hair flower, wa lolita, red kimono dress, floral print, white frills, wide sleeves, obi, hand on own cheek, smile, red shoes, ' + FB, {}),
    283: ('cut', 'short ponytail, red hair, black hair ribbon, chibi, head only, face, closed eyes, > <, open mouth, laughing, head tilt, ' + WB, {'gw': 1024, 'gh': 1024}),
    284: ('cut', H + 'orange hair flower, white dress, off-shoulder dress, bare shoulders, barefoot, holding spear head, nunchaku, chain, standing on cloud, white cloud, yellow-green ribbon, flat color, looking to the side, full body, grey background, simple background', {}),
    285: ('cut', H + 'green kimono, floral print, hair ornament, kanzashi, chibi, smile, ' + FB, {}),
    286: ('cut', 'red hair, hair bun, updo, red eyes, long evening dress, purple dress, maroon dress, bare shoulders, from behind, looking back, high heels, ' + FB, {}),
    287: ('cut', H + 'demon horns, demon tail, red dress, holding trident, pitchfork, black thighhighs, halloween costume, standing on one leg, smirk, ' + FB, {}),
    288: ('cut', HD + 'black hair ribbon, red kimono, sleeveless kimono, detached wide sleeves, black obi, red bow, long red skirt, white frills, layered skirt, black thighhighs, holding spear, polearm, expressionless, ' + FB, {}),
    289: ('cut', H + 'china dress, red chinese clothes, short dress, pink skirt, red high heels, hand on own hip, ' + FB, {}),
    291: ('cut', 'red hair, hair bun, red eyes, green yukata, floral print, obi, squatting, hugging own legs, looking at viewer, sandals, full body, ' + WB, {}),
    292: ('cut', H + 'black cabbie hat, cat ears hat, red t-shirt, black overalls, suspenders, black capri pants, red sneakers, rock, punk, hand in pocket, ' + FB, {}),
    297: ('cut', H + 'white hair ribbon, oni costume, tiger print, tiger print tube top, tiger print baggy pants, holding kanabou, club (weapon), weapon over shoulder, midriff, sandals, ' + FB, {}),
    298: ('cut', 'long hair, red hair, twintails, red eyes, fang, halloween, grim reaper costume, holding scythe, black cape, skull, red crop top, black frilled skirt, jack-o\'-lantern, smile, ' + FB, {}),
    299: ('cut', H + 'purple dress, frills, bowtie, holding playing card, sitting, wariza, macaron, sweets, cake, candy, tower of macarons, smile, full body, ' + WB, {}),
    300: ('cut', H + 'cowboy hat, cowgirl, western, brown vest, red bandana, torn jeans, belt, holster, cowboy boots, hand on headwear, ' + FB, {}),
    301: ('cut', H + 'gym uniform, white t-shirt, navy blue shorts, holding water bottle, bottle to cheek, medal, sweat, smile, barefoot, ' + FB, {}),
    302: ('cut', H + 'yellow hair ribbon, boxing gloves, red boxing gloves, red sports bra, boxing shorts, orange shorts, midriff, fighting stance, barefoot, ' + FB, {}),
    305: ('cut', H + 'mitakihara school uniform, white jacket, red bowtie, black plaid skirt, leaning forward, holding bag, white bag, bare legs, loafers, looking at viewer, ' + FB, {}),
    308: ('opq', 'dark, purple theme, forest, silhouette, fog, night, ruins, gloomy, muted color, abstract background', {'pos': PBG}),
    311: ('cut', H + 'green hoodie, denim shorts, red and white sneakers, eating, holding taiyaki, from side, profile, walking, ' + FB, {}),
    312: ('cut', H + MG + 'holding spear, polearm, long spear, from behind, looking back, dynamic pose, full body, ' + WB, {}),
    315: ('cut', H + 'red sleeveless dress, detached sleeves, soul gem, reaching towards viewer, outstretched hand, foreshortening, evil smile, grin, teeth, blush, floating hair, upper body, purple shadow, ' + WB, {'fit': 'cover', 'gw': 1216, 'gh': 832}),
    316: ('sp', '', {'from': 315}),
    317: ('sp', '', {'from': 315}),
    319: ('opq', 'cityscape, futuristic city, white buildings, skyscraper, blue sky, cloud, sunlight, from above, wide shot, bright, white border, vignetting', {'pos': PBG, 'gw': 1216, 'gh': 832}),
    321: ('cut', H + 'pink yukata, light pink kimono, red sash, holding table tennis paddle, blue paddle, arm up, grin, teeth, onsen, upper body, ' + WB, {'fit': 'cover', 'gw': 1024, 'gh': 1024}),
    354: ('opq', 'long hair, red hair, single braid, side braid, red eyes, fang, red sweater, smile, open mouth, ' + ICON + 'palm leaf, green leaves, white background', {}),
    355: ('opq', H + 'pink pajamas, lying, on stomach, head rest, chin rest, eating, cookie in mouth, ' + ICON + 'bedroom, pastel colors, cushion', {}),
    356: ('opq', H + 'reindeer antlers, antler hairband, green scarf, bell, brown coat, one eye closed, smile, christmas, ' + ICON + 'pink background, snowflakes', {}),
    357: ('opq', H + 'red headband, basketball uniform, red jersey, holding basketball, smile, ' + ICON + 'white background, polka dot background', {}),
    358: ('opq', H + 'cat ears, purple cat ears, cheshire cat, striped arm warmers, purple and pink stripes, paw pose, grin, ' + ICON + 'grey background', {}),
    359: ('opq', H + 'red china dress, gold trim, holding fish, koi, red fish, smile, ' + ICON + 'red background, orange background, egasumi, cloud pattern', {}),
    360: ('opq', 'long hair, bright red hair, high ponytail, black hair ribbon, red eyes, fang, black punk jacket, plaid shirt, pocky in mouth, biting, grin, teeth, ' + ICON + 'yellow background, simple background', {}),
    361: ('opq', H + 'brown school uniform, brown blazer, white frilled collar, from side, profile, looking at viewer, ' + ICON + 'cherry blossoms, pink background, purple background, petals', {}),
    362: ('opq', H + 'demon horns, red strapless dress, bare shoulders, one eye closed, open mouth, smile, holding microphone, ' + ICON + 'red background, black background', {}),
    363: ('opq', H + 'red halterneck swimsuit, holding beach ball, white ball, smile, open mouth, ' + ICON + 'beach, brown background', {}),
    364: ('opq', H + 'pink scarf, olive green jacket, holding can, drink can, open mouth, surprised, ' + ICON + 'yellow background, striped background', {}),
    365: ('opq', H + 'brown plaid scarf, black coat, holding gift bag, blue bag, one eye closed, smile, ' + ICON + 'pink background, red background', {}),
    366: ('opq', 'long hair, bright red hair, high ponytail, polka dot hair ribbon, red eyes, fang, pink cardigan, white shirt, red necktie, grin, teeth, ' + ICON + 'sunset, cityscape, orange sky', {}),
    367: ('opq', H + 'wolf ears, animal ears, fur collar, white fur, closed eyes, > <, yawning, open mouth, arms up, stretching, ' + ICON + 'beige background, wood', {}),
    368: ('opq', H + 'snowboard wear, white and red ski jacket, goggles around neck, red gloves, holding snowboard, light smile, ' + ICON + 'orange background, red background, sparkle, snow', {}),
    369: ('opq', H + 'gold hair ribbon, black kimono, red floral print, furisode, smile, open mouth, ' + ICON + 'light blue background, white background, new year', {}),
    372: ('box', H + 'sunglasses on head, eyewear on head, american flag bikini top, navy blue shorts, hand on own hip, grin, teeth, cowboy shot, miki sayaka behind, summer festival, paper lantern, hibiscus, yellow background, 2girls', {'pos': 'sakura kyoko, mahou shoujo madoka magica, aoki ume, masterpiece, best quality, '}),
    374: ('cut', HD + 'glasses, black-framed eyewear, denim jacket, blue jacket, striped shirt, casual, looking at viewer, light smile, upper body, ' + WB, {'fit': 'cover'}),
    375: ('cut', H + 'white plaid shirt, open shirt, black t-shirt, star print, denim shorts, holding electric guitar, playing guitar, holding drumsticks, rock band, grin, cowboy shot, ' + WB, {'fit': 'cover'}),
    377: ('cut', H + 'hair flower, yellow flower, red bikini, floral print, pareo, sarong, bracelet, heart hands, leaning forward, smile, blush, upper body, ' + WB, {'fit': 'cover', 'gw': 1216, 'gh': 832}),
    378: ('cut', HD + 'green t-shirt, polka dot shirt, short sleeves, holding closed umbrella, red umbrella, smile, open mouth, looking at viewer, upper body, ' + WB, {'fit': 'cover', 'gw': 1024, 'gh': 1024}),
}

# 手元に無かった静止画(key は recreate_g*.py の @reg の文字列そのまま)。番号は 900〜
_SD = 'still:静止画素材/20_ミステリアストレイン直後SD/'
_EXT = 'still:_ext/D/CloudData/GoogleDrive/MAD/魔法少女まどか☆マギカ/杏子整理/'
STILLS = {
    901: (_EXT + '背景/Kyouko_church.jpg', 1280, 720, 'opq', 'church, old stone church, bare tree, winter, leafless trees, fence, overcast, pale sky, muted color, wide shot', {'pos': PBG, 'gw': 1216, 'gh': 832}),
    902: (_SD + 'FABStPUVUAUP9ZL-1_out-1_out.png', 1000, 1300, 'cut', H + MG + 'closed mouth, :3, big head, ' + CHIBI, {'box': [60, 40, 940, 1260]}),
    903: (_SD + 'EzoH1hjVkAIGiHz-1_out-1_out.png', 1000, 1300, 'cut', H + 'cat ears, pink cat ears, cat tail, red dress, smile, closed mouth, big head, ' + CHIBI, {'box': [60, 40, 940, 1260]}),
    904: (_SD + '04_out.png', 1000, 1300, 'cut', 'red hair, bangs, orange eyes, fang, kyubey costume, white animal hood, white kigurumi, cat ears hood, holding apple, open mouth, smile, ' + CHIBI, {'box': [60, 40, 940, 1260]}),
    905: (_SD + '16.png', 1000, 1300, 'cut', 'long hair, bright red hair, high ponytail, red eyes, fang, black rabbit ears, red dress, open mouth, ' + CHIBI, {'box': [60, 40, 940, 1260]}),
    906: (_SD + '12.png', 1000, 1300, 'cut', H + 'hugging object, hugging giant apple, big red apple, sitting, purple dress, ' + CHIBI, {'box': [60, 40, 940, 1260]}),
    907: (_SD + '11-1.png', 1000, 1300, 'cut', H + MG + 'one eye closed, smile, in container, sitting inside golden cup, golden egg-shaped cage, gold ornament, ' + CHIBI, {'box': [60, 40, 940, 1260]}),
    908: (_EXT + '背景/bg.jpg', 1920, 1080, 'sp', '', {}),
    909: (_EXT + '背景/bg[1] (4).jpg', 1920, 1080, 'opq', 'pink sky, pink theme, city skyline, white silhouette, distant buildings, sparkle, bokeh, pastel colors, gradient sky, soft light', {'pos': PBG, 'gw': 1216, 'gh': 832}),
    910: (_EXT + '1111制作素材/08_祝聖_静止画素材/静画素材/75-1.png', 900, 1400, 'cut', H + 'green hoodie, denim shorts, black thighhighs, boots, arms at sides, ' + FB, {'box': [60, 40, 840, 1370]}),
}


def load():
    return json.load(open(MAN, encoding='utf-8')) if os.path.exists(MAN) else {}


def save(m):
    json.dump(m, open(MAN + '.tmp', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    os.replace(MAN + '.tmp', MAN)


def gsize(w, h):
    r = w / h
    return (1216, 832) if r > 1.25 else (832, 1216) if r < 0.8 else (1024, 1024)


def init():
    m = load()
    assign = json.load(open(os.path.join(L.WORK, 'assign.json'), encoding='utf-8'))[AG]
    geom = json.load(open(os.path.join(L.WORK, 'look', 'geom.json'), encoding='utf-8'))
    for a in assign:
        k = str(a['i'])
        e = m.setdefault(k, {})
        g = geom[a['key']]
        e.update(key=a['key'], w=a['w'], h=a['h'], frames=a['frames'], bbox=g['bbox'], alpha=g['alpha'])
        if a['frames'] == 0:
            e.update(mode='skip', status='まだ', note='まだ: 映らない(ルートから映らないので生成していない。取り込み器が仮の板を当てる)')
            continue
        mode, tags, ex = T[a['i']]
        bw, bh = (g['bbox'][2] - g['bbox'][0], g['bbox'][3] - g['bbox'][1]) if mode in ('cut', 'key', 'box') else (a['w'], a['h'])
        gw, gh = gsize(bw, bh)
        e.update(mode=mode, tags=tags, fit=ex.get('fit', 'contain'), pos=ex.get('pos'), src=ex.get('from'),
                 gw=ex.get('gw', gw), gh=ex.get('gh', gh))
        e.setdefault('seed', a['i'] * 1000 + 1)
    for n, (key, w, h, mode, tags, ex) in STILLS.items():
        e = m.setdefault(str(n), {})
        box = ex.get('box', [0, 0, w, h])
        gw, gh = gsize(box[2] - box[0], box[3] - box[1])
        e.update(key=key, w=w, h=h, frames=1, bbox=box, alpha=mode == 'cut', mode=mode, tags=tags, fit='contain', pos=ex.get('pos'), src=None,
                 gw=ex.get('gw', gw), gh=ex.get('gh', gh), still=True)
        e.setdefault('seed', n * 1000 + 1)
    save(m)
    print(len(m), 'entries;', sum(1 for e in m.values() if e['mode'] != 'skip'), 'to make')


def needs_gen(e):
    return e['mode'] in ('cut', 'key', 'opq', 'box') or (e['mode'] == 'sp' and e.get('tags'))


def gen(only=None, redo=None, batch=10):
    m = load()
    todo = []
    for k, e in sorted(m.items(), key=lambda kv: -kv[1].get('frames', 0)):
        if not needs_gen(e) or (only and int(k) not in only):
            continue
        if redo and int(k) in redo:
            e['seed'] += 1
            e['tries'] = e.get('tries', 1) + 1
            for f in ('gen', 'cut', 'out', 'job', 'cjob', 'checked'):
                e.pop(f, None)
        if not e.get('gen'):
            todo.append(k)
    save(m)
    print('gen todo', len(todo))
    for i in range(0, len(todo), batch):
        js = []
        for k in todo[i:i + batch]:
            e = m[k]
            kw = {'pos': e['pos']} if e.get('pos') else {}
            j, _ = L.wai(e['tags'], e['seed'], e['gw'], e['gh'], wait=False, **kw)
            js.append((k, j['id']))
        for k, jid in js:
            s = L.wait_job(jid)
            e = m[k]
            e['job'] = jid
            if s['status'] == 'completed' and s.get('result_asset_ids'):
                e['gen'] = s['result_asset_ids'][0]
            else:
                e['genfail'] = s.get('error_msg')
                print('FAIL', k, s.get('error_msg'))
            save(m)
        print('gen', i + len(js), '/', len(todo), time.strftime('%H:%M'), flush=True)


_paths = {}


def apath(aid):
    if aid not in _paths:
        for a in L.call('GET', f'/api/assets/?project_id={L.PROJECT}'):
            _paths[a['id']] = a['file_path']
    p = _paths[aid]
    assert not any(x in p for x in L.FORBIDDEN), p
    return p


def do_cut(e, crop=True):
    f = 'cut' if crop else 'cutfull'
    if not e.get(f):
        s, c = L.cutout(e['gen'], crop=crop)
        e[f] = c
        e['cjob'] = s['id']
    return Image.open(apath(e[f])).convert('RGBA')


def cuts(only=None, batch=15):
    """切り抜きジョブをまとめて積む(待ち行列をほかの担当と分け合うので、1 個ずつ待たない)。"""
    m = load()
    FULL = (219, 259, 263)
    todo = []
    for k, e in sorted(m.items(), key=lambda kv: -kv[1].get('frames', 0)):
        i = int(k)
        if only and i not in only:
            continue
        if not e.get('gen') or not (e['mode'] in ('cut', 'key') or i in (200, 202, 259, 263)):
            continue
        f = 'cutfull' if i in FULL else 'cut'
        if not e.get(f):
            todo.append((k, f))
    print('cut todo', len(todo), flush=True)
    for s in range(0, len(todo), batch):
        js = [(k, f, L.cutout(m[k]['gen'], crop=(f == 'cut'), wait=False)[0]['id']) for k, f in todo[s:s + batch]]
        for k, f, jid in js:
            r = L.wait_job(jid)
            if r['status'] == 'completed' and r.get('result_asset_ids'):
                m[k][f] = r['result_asset_ids'][0]
                m[k]['cjob'] = jid
            else:
                print('CUT FAIL', k, r.get('error_msg'))
            save(m)
        print('cut', s + len(js), '/', len(todo), time.strftime('%H:%M'), flush=True)


def trim(im):
    bb = im.getchannel('A').point(lambda v: 255 if v > 16 else 0).getbbox()
    return im.crop(bb) if bb else im


def place(fig, w, h, box, fit='contain'):
    """切り抜いた絵 fig を w×h の透明キャンバスの box に置く。contain = 等比で収め足もと・中心合わせ / cover = 箱を覆い上寄せ・中心。"""
    fig = trim(fig)
    bw, bh = box[2] - box[0], box[3] - box[1]
    s = (max if fit == 'cover' else min)(bw / fig.width, bh / fig.height)
    fig = fig.resize((max(1, round(fig.width * s)), max(1, round(fig.height * s))), Image.LANCZOS)
    if fit == 'cover':
        x0 = (fig.width - bw) // 2
        fig = fig.crop((x0, 0, x0 + bw, bh))
        x, y = box[0], box[1]
    else:
        x, y = box[0] + (bw - fig.width) // 2, box[3] - fig.height
    cv = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    cv.paste(fig, (x, y), fig)
    return cv


def cover(im, w, h, top=0.5):
    """不透明の絵を元の縦横比に切って w×h へ。"""
    r = w / h
    if im.width / im.height > r:
        nw = round(im.height * r)
        x = (im.width - nw) // 2
        im = im.crop((x, 0, x + nw, im.height))
    else:
        nh = round(im.width / r)
        y = round((im.height - nh) * top)
        im = im.crop((0, y, im.width, y + nh))
    return im.resize((w, h), Image.LANCZOS)


def whitekey(im, gain=6.0):
    """白背景の絵 → 白でない所を残すアルファ。"""
    r, g, b = im.convert('RGB').split()
    mn = ImageChops.darker(ImageChops.darker(r, g), b)
    return mn.point(lambda v: max(0, min(255, int((255 - v) * gain))))


def gimg(e):
    return Image.open(apath(e['gen'])).convert('RGB')


# ---------------------------------------------------------------- 特別な物

def gold_frame(im, t):
    """金の飾り枠(PIL)。t = 枠の太さ。角は丸く抜く。"""
    w, h = im.size
    fr = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(fr)
    cols = ['#6b4a08', '#c9971c', '#fff3a8', '#e6b422', '#8a6410', '#f7dc6f', '#b8860b', '#5a3d06']
    for i, c in enumerate(cols):
        a, b = t * i / len(cols), t * (i + 1) / len(cols)
        for q in range(int(a), int(b) + 1):
            d.rounded_rectangle([q, q, w - 1 - q, h - 1 - q], radius=max(4, t * 1.2 - q), outline=c, width=2)
    # 左右のねじれ飾り(だ円の鎖)
    for x in (t * 1.9, w - t * 1.9):
        n = 7
        for k in range(n):
            cy = t * 2 + (h - t * 4) * (k + 0.5) / n
            eh = (h - t * 4) / n * 0.62
            d.ellipse([x - t * 0.55, cy - eh, x + t * 0.55, cy + eh], outline='#e6b422', width=max(3, t // 6))
            d.ellipse([x - t * 0.38, cy - eh * 0.8, x + t * 0.38, cy + eh * 0.8], outline='#fff3a8', width=max(2, t // 12))
    # きらめき
    for (sx, sy) in ((t * 2.6, t * 1.8), (w - t * 1.6, h * 0.58), (t * 2.2, h - t * 2.3)):
        for ang in range(0, 180, 45):
            ln = t * (1.5 if ang % 90 == 0 else 0.8)
            dx, dy = math.cos(math.radians(ang)) * ln, math.sin(math.radians(ang)) * ln
            d.line([sx - dx, sy - dy, sx + dx, sy + dy], fill='#ffffff', width=max(2, t // 14))
    out = im.convert('RGBA')
    out.alpha_composite(fr)
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=int(t * 1.2), fill=255)
    out.putalpha(mask)
    return out


def badge(out, cx, cy, r, text):
    d = ImageDraw.Draw(out)
    for rr, c in ((r, '#6b4a08'), (r * 0.94, '#e6b422'), (r * 0.82, '#fff3a8'), (r * 0.76, '#b8860b'), (r * 0.7, '#3a2604')):
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=c)
    f = ImageFont.truetype(FONT, int(r * 0.8))
    bb = d.textbbox((0, 0), text, font=f)
    d.text((cx - (bb[0] + bb[2]) / 2, cy - (bb[1] + bb[3]) / 2), text, font=f, fill='#ffe98a', stroke_width=max(2, int(r * 0.04)), stroke_fill='#6b4a08')
    # 冠・葉の飾り(だ円)
    for k in range(5):
        x = cx - r * 1.1 - k * r * 0.42
        d.ellipse([x - r * 0.3, cy + r * 0.55 - k * 4, x + r * 0.3, cy + r * 0.85 - k * 4], fill='#d4a017', outline='#6b4a08', width=3)


def sp_212(e, m):
    im = cover(gimg(e), e['w'], e['h'], top=0.3)
    out = gold_frame(im, 74)
    badge(out, e['w'] - 260, e['h'] - 250, 170, 'SR')
    return out, '金の飾り枠・SR の印は PIL で描いた(フリーフォント NotoSansJP)。枠の彫り・ばら・羽の飾りは簡略'


def sp_215(e, m):
    src = m['212']
    w, h, bb = e['w'], e['h'], e['bbox']
    im = cover(gimg(src), w, h)
    cx, cy, r = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, (bb[2] - bb[0]) / 2
    big = Image.new('L', (w, h), 0)
    ImageDraw.Draw(big).ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    inner = Image.new('L', (w, h), 0)
    ImageDraw.Draw(inner).ellipse([cx - r * 0.86, cy - r * 0.86, cx + r * 0.86, cy + r * 0.86], fill=255)
    inner = inner.filter(ImageFilter.GaussianBlur(r * 0.05))
    out = Image.composite(im, Image.new('RGB', (w, h), '#ffffff'), inner).convert('RGBA')
    out.putalpha(big.filter(ImageFilter.GaussianBlur(6)))
    e['job'] = src.get('job')
    return out, '#212 と同じ生成絵を丸く抜き、縁を白くぼかした(PIL)'


def sp_200(e, m):
    w, h, bb = e['w'], e['h'], e['bbox']
    cv = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(cv)
    cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2 - 30
    r = (bb[2] - bb[0]) * 0.40
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill='#e60012')
    fig = place(do_cut(e), w, h, [bb[0] + 110, bb[1], bb[2] - 110, bb[3]])
    cv.alpha_composite(fig)
    d = ImageDraw.Draw(cv)
    f = ImageFont.truetype(FONT, 190)
    d.text((bb[0] + 5, cy - 130), '祝', font=f, fill='#ffd400', stroke_width=10, stroke_fill='#ffffff')
    d.text((bb[2] - 150, cy - 130), '!!', font=f, fill='#ffd400', stroke_width=10, stroke_fill='#ffffff')
    return cv, '赤い丸と「祝 !!」の字は PIL(フリーフォント)。字の形・傾きは元と違う'


def sp_202(e, m):
    w, h, bb = e['w'], e['h'], e['bbox']
    cv = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(cv)
    d.rounded_rectangle(bb, radius=50, fill='#f6a5c0', outline='#e60033', width=26)
    inner = [bb[0] + 30, bb[1] + 30, bb[2] - 30, bb[3] - 30]
    fig = place(do_cut(e), w, h, inner, 'cover')
    cv.alpha_composite(fig)
    d = ImageDraw.Draw(cv)

    def vein(cx, cy, s):  # 怒りの印(4 つの弧)
        for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            x, y = cx + sx * s * 0.62, cy + sy * s * 0.62
            a0 = {(-1, -1): 0, (1, -1): 90, (1, 1): 180, (-1, 1): 270}[(sx, sy)]
            d.arc([x - s * 0.5, y - s * 0.5, x + s * 0.5, y + s * 0.5], a0, a0 + 90, fill='#ffffff', width=int(s * 0.34))
            d.arc([x - s * 0.5, y - s * 0.5, x + s * 0.5, y + s * 0.5], a0 + 6, a0 + 84, fill='#e60012', width=int(s * 0.2))
    for (x, y, s) in ((bb[0] + 150, bb[1] + 150, 90), (bb[2] - 150, bb[1] + 150, 90), (bb[0] + 140, bb[3] - 150, 70), (bb[2] - 140, bb[3] - 150, 70)):
        vein(x, y, s)
    return cv, '桃色の角丸の板・赤い縁・怒りの印は PIL。元の顔だけの大写しより体が入る'


def sp_259(e, m):
    return cover(gimg(e), e['w'], e['h']), ''


def _fullcut259(m):
    src = m['259']
    c = do_cut(src, crop=False)
    return cover(c, src['w'], src['h'])


def sp_257(e, m):
    out = _fullcut259(m)
    e['job'] = m['259'].get('job')
    return out, '#259 の生成絵を切り抜いた人物の層(同じ位置)。元の層にある左下の岩は切り抜きに入らない'


def sp_258(e, m):
    c = _fullcut259(m)
    r, g, b, a = c.split()
    # 赤い所(髪・水着)だけ残す: r が g・b よりはっきり大きい
    red = ImageChops.subtract(r, ImageChops.lighter(g, b)).point(lambda v: 255 if v > 50 else 0)
    c.putalpha(ImageChops.multiply(a, red))
    e['job'] = m['259'].get('job')
    return c, '#259 の人物の切り抜きから赤い所(髪・水着)だけを残した層(PIL)。元の層の範囲とは一致しない'


def sp_263(e, m):
    im = gimg(e)
    a = whitekey(im, 7.0)
    c = do_cut(e, crop=False).getchannel('A')
    out = im.convert('RGBA')
    out.putalpha(ImageChops.lighter(a, c))
    bb = e['bbox']
    fig = place(out, e['w'], e['h'], bb, 'contain')
    return fig, '白背景の生成絵を明るさで抜いた(白い花びらの芯は少し透ける)'


def sp_280(e, m):
    src = m['281']
    fig = trim(Image.open(os.path.join(OUT, '281.png')).convert('RGBA'))
    rot = fig.rotate(42, expand=True, resample=Image.BICUBIC)
    e['job'] = src.get('job')
    return place(rot, e['w'], e['h'], e['bbox'], 'cover'), '#281 の切り抜きを 42° 傾けて箱を覆うように置いた(元は同じ絵の傾けた大写し。角度は目分量)'


def _sil315(m):
    fig = Image.open(os.path.join(OUT, '315.png')).convert('RGBA')
    return fig.getchannel('A')


def sp_316(e, m):
    a = _sil315(m)
    bb = e['bbox']
    mask = Image.new('L', a.size, 0)
    # 箱の中の、髪のリボンから右手へ流れる帯だけ(だ円 2 つ)を残す
    d = ImageDraw.Draw(mask)
    bw, bh = bb[2] - bb[0], bb[3] - bb[1]
    d.ellipse([bb[0], bb[1], bb[0] + bw * 0.55, bb[1] + bh * 0.5], fill=255)
    d.ellipse([bb[0] + bw * 0.1, bb[1] + bh * 0.45, bb[2], bb[3] + bh * 0.2], fill=255)
    al = ImageChops.multiply(a, mask)
    out = Image.new('RGBA', a.size, (0, 0, 0, 255))
    out.putalpha(al)
    e['job'] = m['315'].get('job')
    return out, '#315 の切り抜きの形を黒い影絵にし、元の箱の範囲の一部(だ円 2 つ)だけ残した(PIL)。元の影の形とは一致しない'


def sp_317(e, m):
    bb = e['bbox']
    out = Image.new('RGBA', (e['w'], e['h']), (0, 0, 0, 0))
    d = ImageDraw.Draw(out)
    d.polygon([(bb[0], bb[1]), (bb[0] + 30, bb[1] + 8), (bb[2], bb[3]), (bb[2] - 40, bb[3] - 20)], fill=(0, 0, 0, 255))
    e['job'] = None
    return out, '元は #316 の影絵のかけら(96×83 の小さな黒い片)。同じ場所に黒い片を PIL で描いた(生成なし)'


def sp_908(e, m):
    import random
    rnd = random.Random(908)
    w, h = e['w'], e['h']
    im = Image.new('RGB', (w * 2, h * 2), '#ffffff')
    d = ImageDraw.Draw(im, 'RGBA')
    for col, cnt, sz in (('#f29cc2', 40, 120), ('#b5d640', 26, 130), ('#7fb6de', 32, 120), ('#f0e070', 32, 110), ('#f7c9dc', 40, 70), ('#c9d3de', 14, 160)):
        rgb = tuple(int(col[i:i + 2], 16) for i in (1, 3, 5))
        for _ in range(cnt):
            r = sz * rnd.uniform(0.25, 1.0)
            x, y = rnd.uniform(0, w * 2), rnd.uniform(0, h * 2)
            d.ellipse([x - r, y - r, x + r, y + r], fill=rgb + (225,))
    e['job'] = None
    return im.resize((w, h), Image.LANCZOS), '白地にパステルの水玉(PIL。完成版 4580〜4667 のぼけた水玉を見て色を決めた)。生成でなく手続き'


SPECIAL = {200: sp_200, 202: sp_202, 212: sp_212, 215: sp_215, 257: sp_257, 258: sp_258, 259: sp_259, 263: sp_263, 280: sp_280, 316: sp_316, 317: sp_317, 908: sp_908}
ORDER_LAST = (215, 257, 258, 280, 316, 317)   # ほかの絵から作る物はあと


def post(only=None, force=False):
    os.makedirs(OUT, exist_ok=True)
    m = load()
    ks = [k for k in m if m[k]['mode'] != 'skip' and (not only or int(k) in only)]
    ks.sort(key=lambda k: (int(k) in ORDER_LAST, -m[k].get('frames', 0)))
    n = 0
    for k in ks:
        e = m[k]
        i = int(k)
        if e.get('out') and not force:
            continue
        srcs = [e] if needs_gen(e) else ([m[str(e['src'])]] if e.get('src') else [])
        if any(not s.get('gen') for s in srcs):
            print('skip (no gen yet)', k)
            continue
        if i in (280,) and not os.path.exists(os.path.join(OUT, '281.png')):
            continue
        if i in (316,) and not os.path.exists(os.path.join(OUT, '315.png')):
            continue
        w, h, bb = e['w'], e['h'], e['bbox']
        extra = ''
        if e['mode'] == 'sp':
            out, extra = SPECIAL[i](e, m)
            proc = '特別: ' + SPECIAL[i].__name__
        elif e['mode'] == 'cut':
            out = place(do_cut(e), w, h, bb, e['fit'])
            proc = f"cutout(isnet-anime job {e.get('cjob')}) → 元の箱 {bb} に {e['fit']} で配置"
        elif e['mode'] == 'key':
            im = gimg(e)
            c = do_cut(e, crop=False).getchannel('A')
            o = im.convert('RGBA')
            o.putalpha(ImageChops.lighter(c, whitekey(im, 5.0)))
            out = place(o, w, h, bb, 'contain')
            proc = f"cutout + 白でない所(効果)を残す → 元の箱 {bb} に配置"
        elif e['mode'] == 'opq':
            out = cover(gimg(e), w, h)
            proc = f'元の縦横比に切って {w}×{h} へ(Lanczos)'
        elif e['mode'] == 'box':
            out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
            out.paste(cover(gimg(e), bb[2] - bb[0], bb[3] - bb[1]), (bb[0], bb[1]))
            proc = f'不透明のまま元の箱 {bb} に置いた(外は透明)'
        assert out.size == (w, h), (k, out.size)
        ext = 'png' if out.mode == 'RGBA' else 'jpg'
        p = os.path.join(OUT, f'{k}.{ext}')
        out.save(p, **({'quality': 93} if ext == 'jpg' else {}))
        a = L.upload(p, f'genb_{k}.{ext}')
        e['out'] = a['id']
        e['outfile'] = p
        e['extra'] = extra
        e['proc'] = proc
        save(m)
        put_one(k, e)
        n += 1
        if n % 30 == 0:
            os.system(f'echo "[GEN_B] $(date +%H:%M) 後処理・置き換え表 {n} 個ぶん書いた" >> {L.WORK}/LOG.md')
        print('post', k, e['out'], flush=True)


def put_one(k, e):
    i = int(k)
    if e['mode'] == 'skip':
        return
    nogen = e.get('job') is None and not e.get('gen')
    if nogen:
        kind, how = 'proc', f"PIL: {e.get('proc')}"
    else:
        src = e if e.get('gen') else None
        tags = (e.get('pos') or L.WAI_POS) + e['tags'] if e.get('tags') else f"(#{e.get('src')} の生成絵から)"
        how = f"WAI txt2img job {e.get('job')} seed {e['seed'] if e.get('tags') else '-'} {e['gw']}x{e['gh']} tags: {tags} → {e.get('proc')}"
        kind = 'gen' if e['mode'] == 'opq' and not e.get('still') else 'gen+proc'
        if e.get('still') and e['mode'] != 'sp':
            kind = 'gen'
    note = e.get('note') or '絵は出来・未確認'
    if e.get('extra'):
        note += '。' + e['extra']
    L.put(AG, e['key'], e['out'], e['w'], e['h'], kind, how, '仮', note)


def reput(only=None):
    m = load()
    for k, e in m.items():
        if e.get('out') and (not only or int(k) in only):
            put_one(k, e)


def sheet(only=None, tag='sheet'):
    m = load()
    ks = sorted((k for k in m if m[k].get('out') and (not only or int(k) in only)), key=int)
    f = ImageFont.truetype(FONT, 22)
    for s in range(0, len(ks), 20):
        sh = Image.new('RGB', (5 * 400, 4 * 440), '#606878')
        d = ImageDraw.Draw(sh)
        for j, k in enumerate(ks[s:s + 20]):
            e = m[k]
            im = Image.open(e['outfile'])
            bg = Image.new('RGBA', im.size, '#8890a0')
            bg.alpha_composite(im.convert('RGBA'))
            bg.thumbnail((390, 400), Image.LANCZOS)
            x, y = (j % 5) * 400, (j // 5) * 440
            sh.paste(bg.convert('RGB'), (x + (400 - bg.width) // 2, y + 34))
            d.text((x + 6, y + 2), f"#{k} a{e['out']} {e['w']}x{e['h']} s{e.get('seed', 0) % 1000}", font=f, fill='#ffee00')
        p = os.path.join(R, f'{tag}_{s // 20:02d}.jpg')
        sh.save(p, quality=88)
        print(p)


def ledger():
    m = load()
    rows = ['# GEN_B 台帳(元素材 #200〜#378 の 143 個 + 手元に無かった静止画)', '',
            '状態: 仮 = 絵は出来たがユーザー未確認 / まだ = 作っていない', '',
            '| 番号 | key(末尾) | 大きさ | コマ | 状態 | asset | 作り方 | 注 |', '|---|---|---|---|---|---|---|---|']
    for k in sorted(m, key=int):
        e = m[k]
        if e['mode'] == 'skip':
            rows.append(f"| #{k} | {e['key'][-40:]} | {e['w']}×{e['h']} | 0 | まだ | - | 生成していない | 映らない |")
            continue
        how = (f"WAI job {e.get('job')} seed {e.get('seed')} → {e.get('proc', '')}" if e.get('job') else f"PIL {e.get('proc', '')}")
        note = (e.get('note') or '絵は出来・未確認') + (('。' + e['extra']) if e.get('extra') else '')
        st = '仮' if e.get('out') else 'まだ'
        rows.append(f"| #{k} | {e['key'][-40:]} | {e['w']}×{e['h']} | {e.get('frames')} | {st} | {e.get('out', '-')} | {how} | {note} |")
    open(os.path.join(R, 'LEDGER.md'), 'w', encoding='utf-8').write('\n'.join(rows) + '\n')
    print('ledger', len(rows) - 6)


def _ids(a, name):
    return {int(x) for x in a[a.index(name) + 1].split(',')} if name in a else None


if __name__ == '__main__':
    a = sys.argv[1:]
    cmd = a[0]
    if cmd == 'init':
        init()
    elif cmd == 'gen':
        gen(_ids(a, '--only'), _ids(a, '--redo'))
    elif cmd == 'cuts':
        cuts(_ids(a, '--only'))
    elif cmd == 'post':
        post(_ids(a, '--only'), '--force' in a)
    elif cmd == 'sheet':
        sheet(_ids(a, '--only'), a[a.index('--tag') + 1] if '--tag' in a else 'sheet')
    elif cmd == 'reput':
        reput(_ids(a, '--only'))
    elif cmd == 'ledger':
        ledger()
