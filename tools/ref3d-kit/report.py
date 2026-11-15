#!/usr/bin/env python3
"""REF3D: 納品物を作る(比較動画・連続コマのシート・速さの曲線の図)。字は PIL。
usage: report.py audio | grid | strips | curves | all
"""
import json, os, sys, subprocess, glob
import numpy as np
from PIL import Image, ImageDraw, ImageFont
R = '/tmp/claude-1000/sakura-rebuild/REF3D'
REPO = '/home/kigarashi309/workspace/projects/KyChaPoGaS/repo'
OUT = f'{REPO}/outputs/pocky2026/finish/v13/_share/ref3d_test'
PY = f'{REPO}/backend/.venv/bin/python'; K = f'{REPO}/tools/feel-kit'
W, H, N = 1344, 768, 124
BEATS = [round(i * 9.6) for i in range(13)]
LABEL = {'M1A': 'Ref2V 手本A(素体モデル)', 'M1B': 'Ref2V 手本B(灰色人形)', 'M1C': 'Ref2V 手本C(棒人形)', 'M2X': 'ControlNet 深度0.3+骨0.7', 'M2Dh': 'ControlNet 深度 1.0', 'M2Dm': 'ControlNet 深度 0.6',
         'M2Ph': 'ControlNet 骨 1.0', 'M2Pm': 'ControlNet 骨 0.6'}
ORDER = ['M1A', 'M1B', 'M1C', 'M2X', 'M2Dh', 'M2Ph', 'M2Dm', 'M2Pm']
OUTFIT = {'B': '星柄B', 'P': 'パーカー'}


def font(sz):
    for p in ('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'):
        if os.path.exists(p): return ImageFont.truetype(p, sz)
    return ImageFont.load_default()


def frames(path, w, h):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vf', f'scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def audio():
    """完成版(さくら)の 2172 コマ目(60fps、小節の頭)から。拍 24.3 コマ(60fps)を手本の 9.6 コマ(24fps)に合わせるため 1.0125 倍速"""
    os.makedirs(OUT, exist_ok=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{2172 / 60:.4f}', '-t', '5.4', '-i', '/tmp/claude-1000/sakura-rebuild/FEEL/final.wav', '-af', 'atempo=1.0125', '-t', f'{N / 24:.4f}', f'{R}/clip.wav'], check=True)
    a = json.load(open('/tmp/claude-1000/sakura-rebuild/FEEL/audio.json'))
    cv = lambda f: (f - 2172) / 60 * 24 / 1.0125
    b = dict(a, fps=24, frames=N, beats=[cv(x) for x in a['beats'] if 0 <= cv(x) < N + 1], downbeats=[cv(x) for x in a['downbeats'] if 0 <= cv(x) < N + 1],
             onsets={k: [[cv(f), s] for f, s in v if 0 <= cv(f) < N] for k, v in a['onsets'].items()})
    for k in ('rms', 'band', 'stem_rms', 'sections', 'beat_pos'): b.pop(k, None)
    json.dump(b, open(f'{R}/clip_audio.json', 'w'))
    print('beats(24fps)', [round(x, 1) for x in b['beats']])


def tile_label(text, w, sub=''):
    im = Image.new('RGB', (w, 34), (18, 20, 26)); d = ImageDraw.Draw(im)
    d.text((6, 4), text, font=font(19), fill=(240, 240, 240))
    if sub: d.text((w - 8 - d.textlength(sub, font=font(15)), 8), sub, font=font(15), fill=(160, 200, 255))
    return np.asarray(im)


def grid_one(name, tiles, cols=3, tw=640, th=366):
    """tiles = [(ラベル, 補足, mp4)] → 並べた動画(拍のコマで左上に白い印・下にコマ番号)"""
    rows = -(-len(tiles) // cols); Wd, Hd = cols * tw, rows * (th + 34)
    Wd += Wd % 2; Hd += Hd % 2
    vids = [frames(p, tw, th) for _, _, p in tiles]
    labs = [tile_label(a, tw, b) for a, b, _ in tiles]
    tmp = f'{R}/tmp_{name}.mp4'
    ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{Wd}x{Hd}', '-r', '24', '-i', '-', '-i', f'{R}/clip.wav', '-c:v', 'libx264', '-crf', '17', '-pix_fmt', 'yuv420p',
                           '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', f'{OUT}/{name}.mp4'], stdin=subprocess.PIPE)
    fn = font(16)
    for f in range(N):
        cv = np.zeros((Hd, Wd, 3), np.uint8)
        for i, v in enumerate(vids):
            x, y = (i % cols) * tw, (i // cols) * (th + 34)
            cv[y:y + 34, x:x + tw] = labs[i]
            fr = v[min(f, len(v) - 1)].copy()
            if any(abs(f - b) <= 0 for b in BEATS): fr[4:28, 4:28] = 255
            cv[y + 34:y + 34 + th, x:x + tw] = fr
        im = Image.fromarray(cv); d = ImageDraw.Draw(im); d.text((Wd - 70, Hd - 24), f'f{f:03d}', font=fn, fill=(255, 255, 0))
        ff.stdin.write(np.asarray(im).tobytes())
    ff.stdin.close(); ff.wait(); print(f'{OUT}/{name}.mp4')


def runs():
    return sorted(os.path.basename(p)[:-4] for p in glob.glob(f'{R}/out/*.mp4'))


def grid():
    M = json.load(open(f'{R}/metrics.json')) if os.path.exists(f'{R}/metrics.json') else {}
    rs = runs()
    for cut in ('c1', 'c2', 'c3'):
        for s in ('s1', 's2'):
            for o in ('B', 'P'):
                mine = [n for n in rs if n.split('_')[0] == cut and n.split('_')[2] == o and n.split('_')[3] == s]
                if not mine: continue
                mine.sort(key=lambda n: ORDER.index(n.split('_')[1]))
                tiles = [('手本 B(灰色人形)', '', f'{R}/guides/{cut}B.mp4')]
                for n in mine:
                    m = M.get(n, {})
                    tiles.append((LABEL[n.split('_')[1]], f"相関 {m.get('corr', 0):.2f}" if m else '', f'{R}/out/{n}.mp4'))
                grid_one(f'cmp_{cut}_{OUTFIT_KEY[o]}_{s}', tiles)
    for cut in ('c1', 'c2', 'c3'):   # 手本 5 種を並べた動画
        grid_one(f'guide_{cut}', [(t, '', f'{R}/guides/{cut}{v}.mp4') for v, t in (('A', '手本 A: VRM そのまま'), ('B', '手本 B: 灰色人形'), ('C', '手本 C: 棒人形'), ('D', '制御用: 深度(近い = 白)'), ('P', '制御用: OpenPose 形式の骨'))])


OUTFIT_KEY = {'B': 'starB', 'P': 'parka'}
STRIP = {'c1': [(26, 46, 2), (54, 68, 2)], 'c2': [(28, 46, 2), (66, 84, 2)], 'c3': [(0, 124, 12), (62, 84, 2)]}


def strips():
    rs = runs()
    fl = font(20)
    for cut in ('c1', 'c2', 'c3'):
        for s in ('s1', 's2'):
            mine = [n for n in rs if n.split('_')[0] == cut and n.split('_')[3] == s]
            if not mine: continue
            mine.sort(key=lambda n: (n.split('_')[2] != 'B', ORDER.index(n.split('_')[1])))
            rows = [('手本 A', f'{R}/guides/{cut}A.mp4'), ('手本 B', f'{R}/guides/{cut}B.mp4')] + [(LABEL[n.split('_')[1]].replace('ControlNet', 'CN') + (' / パーカー' if n.split('_')[2] == 'P' else ''), f'{R}/out/{n}.mp4') for n in mine]
            for k, (a, b, st) in enumerate(STRIP[cut]):
                fs = list(range(a, min(b, N - 1) + 1, st)); tw, th = 320, 183
                sheet = Image.new('RGB', (230 + tw * len(fs), 26 + th * len(rows)), (18, 20, 26)); d = ImageDraw.Draw(sheet)
                for i, f in enumerate(fs): d.text((230 + tw * i + 6, 2), f'f{f}' + (' ●拍' if f in BEATS else ''), font=fl, fill=(255, 255, 0))
                for j, (lab, p) in enumerate(rows):
                    v = frames(p, tw, th)
                    d.text((4, 26 + th * j + 6), lab[:22], font=font(16), fill=(240, 240, 240)); d.text((4, 26 + th * j + 30), lab[22:], font=font(16), fill=(240, 240, 240))
                    for i, f in enumerate(fs): sheet.paste(Image.fromarray(v[min(f, len(v) - 1)]), (230 + tw * i, 26 + th * j))
                o = f'{OUT}/strip_{cut}_{s}_{k + 1}.jpg'; sheet.save(o, quality=88); print(o)


def curves():
    rs = runs()
    for cut in ('c1', 'c2', 'c3'):
        for s in ('s1', 's2'):
            for grp, modes in (('ref2v', ['M1A', 'M1B', 'M1C']), ('controlnet', ['M2X', 'M2Dh', 'M2Ph', 'M2Dm', 'M2Pm'])):
                mine = [n for n in rs if n.split('_')[0] == cut and n.split('_')[3] == s and n.split('_')[2] == 'B' and n.split('_')[1] in modes]
                if not mine: continue
                mine.sort(key=lambda n: ORDER.index(n.split('_')[1]))
                SH = {'M1A': 'R2V-A', 'M1B': 'R2V-B', 'M1C': 'R2V-C', 'M2X': 'CN両方', 'M2Dh': 'CN深度1.0', 'M2Ph': 'CN骨1.0', 'M2Dm': 'CN深度0.6', 'M2Pm': 'CN骨0.6'}
                ser = [f'手本B={R}/npz/g_{cut}B.npz'] + [f"{SH[n.split('_')[1]]}={R}/npz/{n}.npz" for n in mine]
                o = f'{OUT}/curve_{cut}_{s}_{grp}.png'
                r = subprocess.run([PY, f'{K}/plot.py', 'curves', '--audio', f'{R}/clip_audio.json', '--out', o, '--range', '0', str(N), '--series', *ser, '--title', f'{cut} {s} {grp}'], capture_output=True, text=True)
                print(o, r.returncode, r.stderr[-300:])


if __name__ == '__main__':
    c = sys.argv[1]
    if c in ('audio', 'all'): audio()
    if c in ('grid', 'all'): grid()
    if c in ('strips', 'all'): strips()
    if c in ('curves', 'all'): curves()
