#!/usr/bin/env python3
"""
fast_rig — 量産向け即席リグ強化(全CPU・数秒)。

SDXL inpaint(face_variants.py, 数分+GPU)の代わりに、テンプレート描画で
口形素・まぶた差分を即席生成する。加えて髪レイヤーを輪郭ギャップで房分割し、
房ごとの揺れ(根元剛・毛先柔は既存verletHairが担う)を可能にする。
Anime2.5DRig(MIT)の「差分はテンプレで作る/髪は輪郭から房を切る」という
思想を参考に、当リポジトリのmanifest v2形式へ独自実装したもの。

出力はface_variants.pyと同一のパッチ形式(全キャンバスRGBA+楕円フェザーα)
なので、PuppetStage側の変更は不要。

usage:
  fast_rig.py <puppet_dir> [--no-variants] [--no-strands] [--max-strands 6]
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


# ── 共通 ──────────────────────────────────────────────────────────────────────

def flatten(mdir: Path, m: dict, skip_hair: bool = False) -> Image.Image:
    """skip_hair=True: 髪グループ抜きで平坦化。差分パッチは前髪の下に
    合成されるため、髪ピクセルを焼き込むと実機で二重描画(にじみ)になる。"""
    canvas = Image.new("RGBA", tuple(m["canvas"]), (255, 255, 255, 255))
    for layer in sorted(m["layers"], key=lambda x: x["z"]):
        if skip_hair and layer.get("group") in ("backhair", "fronthair"):
            continue
        canvas.alpha_composite(Image.open(mdir / layer["file"]).convert("RGBA"))
    return canvas.convert("RGB")


def region_mask(canvas_size, region, kind):
    """face_variants.py と同一のフェザー楕円(パッチ互換性の要)。"""
    l, t, r, b = [int(v) for v in region]
    w, h = r - l, b - t
    if kind == "mouth":
        l -= int(w * .45); r += int(w * .45)
        t -= int(h * .55); b += int(h * 1.9)
    else:
        l -= int(w * .16); r += int(w * .16)
        t -= int(h * .55); b += int(h * .55)
    mask = Image.new("L", tuple(canvas_size), 0)
    ImageDraw.Draw(mask).ellipse([l, t, r, b], fill=255)
    return mask.filter(ImageFilter.GaussianBlur(6)), (l, t, r, b)


def _hex(c):
    return tuple(int(c.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))


def _shade(rgb, f, tint=(0, 0, 0)):
    return tuple(max(0, min(255, int(v * f + t * (1 - f)))) for v, t in zip(rgb, tint))


# ── 1) テンプレ差分: まぶた ────────────────────────────────────────────────────

def _sample_skin(base: Image.Image, x: float, y: float, r: int = 6):
    """実画像から局所肌色を採る(skinColor定数だとカバーが浮く)。"""
    px = base.convert("RGB")
    xs = range(max(0, int(x) - r), min(px.width, int(x) + r))
    ys = range(max(0, int(y) - r), min(px.height, int(y) + r))
    vals = [px.getpixel((ix, iy)) for ix in xs for iy in ys]
    n = max(1, len(vals))
    return tuple(sum(v[i] for v in vals) // n for i in range(3))


def draw_eyes(base: Image.Image, m: dict, closed: float, mdir: Path = None, scale: int = 1):
    """既存レイヤー変形方式: 目の開口部(eyewhite+iridesのα)を肌で埋め、
    キャラ自身のまつ毛レイヤーを縦に潰して閉じ目線にする(画風保存・左右対称)。
    closed=1.0 全閉 / 0.5 半目。戻り値: (画像, パッチ用タイトαマスク)"""
    files = {l["name"]: l["file"] for l in m["layers"]}
    def L(name):
        f = files.get(name)
        return Image.open(mdir / f).convert("RGBA") if f else None
    white, iris, lash = L("eyewhite"), L("irides"), L("eyelash")
    out = base.copy()
    W0, H0 = out.size
    up = (lambda im: im.resize((W0, H0), Image.LANCZOS)) if scale != 1 else (lambda im: im)

    # 開口部マスク = eyewhite ∪ irides (少し膨張)
    open_mask = Image.new("L", (W0, H0), 0)
    for im in (white, iris):
        if im is not None:
            open_mask.paste(255, (0, 0), up(im).split()[3].point(lambda v: 255 if v > 20 else 0))
    open_grow = open_mask.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(3))

    l, t, r, b = [v for v in m["rig"]["eye"]["region"]]
    eh = b - t
    patch_mask = Image.new("L", (W0, H0), 0)
    patch_mask.paste(open_grow, (0, 0))

    for cx, cy in (m["rig"]["eye"]["left"], m["rig"]["eye"]["right"]):
        skin = _sample_skin(base, cx, b + eh * 0.55)
        cover = Image.new("RGBA", (W0, H0), (*skin, 255))
        # この目の周辺だけ肌で埋める(開口部マスク∩目近傍)
        near = Image.new("L", (W0, H0), 0)
        ImageDraw.Draw(near).ellipse([cx - eh * 1.1, cy - eh * .9,
                                      cx + eh * 1.1, cy + eh * .9], fill=255)
        from PIL import ImageChops
        emask = ImageChops.multiply(open_grow, near)
        if closed < 1:
            # 半目: 開口部の上半分だけ埋める
            half = Image.new("L", (W0, H0), 0)
            ImageDraw.Draw(half).rectangle([0, 0, W0, int(cy + eh * 0.02)], fill=255)
            emask = ImageChops.multiply(emask, half)
        out.paste(cover, (0, 0), emask)

    # まつ毛レイヤーを縦潰しして閉じ目線に(全閉0.32 / 半目0.62)
    if lash is not None:
        la = up(lash)
        bbox = la.split()[3].getbbox()
        if bbox:
            lx0, ly0, lx1, ly1 = bbox
            lh = ly1 - ly0
            f = 0.32 if closed >= 1 else 0.62
            squashed = la.crop(bbox).resize((lx1 - lx0, max(2, int(lh * f))), Image.LANCZOS)
            # 下端を「元のまつ毛の下端より少し下」= 閉じた瞼の位置へ
            py = ly1 - squashed.height + int(eh * (0.22 if closed >= 1 else 0.10))
            out.alpha_composite(squashed, (lx0, py))
            lm = squashed.split()[3].point(lambda v: 255 if v > 16 else 0)
            patch_mask.paste(255, (lx0, py), lm)

    patch_mask = patch_mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(4))
    return out, patch_mask


# ── 1) テンプレ差分: 口形素 ────────────────────────────────────────────────────

VOWEL_SHAPES = {   # (幅倍率, 高さ倍率, 歯を見せるか)
    "a": (1.00, 1.65, False),
    "i": (1.30, 0.50, True),
    "u": (0.55, 0.95, False),
    "e": (1.15, 1.00, True),
    "o": (0.80, 1.25, False),
}


def draw_mouth(base: Image.Image, m: dict, vowel: str, openness: float, smile: bool):
    rig = m["rig"]
    _ml, _mt, _mr, _mb = rig["mouth"]["region"]
    _mw = max(20, _mr - _ml)
    _pts = [(_ml - _mw * .9, (_mt + _mb) / 2), (_mr + _mw * .9, (_mt + _mb) / 2),
            ((_ml + _mr) / 2, _mt - _mw * .55)]
    _cols = [_sample_skin(base, x, y) for x, y in _pts]
    skin = tuple(sorted(c[i] for c in _cols)[1] for i in range(3))   # 中央値(影に強い)
    lip = _shade(skin, 0.5, (90, 30, 45))
    cavity = (74, 32, 40)
    tongue = (176, 85, 95)
    teeth = (250, 246, 240)
    out = base.copy()
    d = ImageDraw.Draw(out)
    cx, cy = rig["mouth"]["center"]
    ml, mt, mr, mb = rig["mouth"]["region"]
    bw = max(24.0, (mr - ml) * 1.15)               # 基準幅(閉じ口の線の長さ)
    # 元の口を肌で消す
    d.rounded_rectangle([ml - bw * .35, mt - bw * .35, mr + bw * .35, mb + bw * .8],
                        radius=bw * .3, fill=(*skin, 255))
    w, h, show_teeth = VOWEL_SHAPES[vowel]
    w = bw * w * 0.62
    h = bw * h * 0.52 * openness
    if h < bw * 0.09:                               # ほぼ閉じ → 線だけ
        bow = bw * (0.22 if smile else 0.06)
        pts = [(cx - w / 2 + w * i / 16,
                cy + (bow * math.sin(math.pi * i / 16)) * (-1 if smile else 1) * -1)
               for i in range(17)]
        d.line(pts, fill=(*lip, 255), width=max(2, int(bw * 0.07)), joint="curve")
        return out
    top = cy - h * (0.62 if smile else 0.5)
    # 口腔
    d.ellipse([cx - w / 2, top, cx + w / 2, top + h], fill=(*cavity, 255))
    # 歯(上帯) / 舌(下)
    if show_teeth:
        d.rectangle([cx - w / 2 + w * .08, top + h * .06,
                     cx + w / 2 - w * .08, top + h * .32], fill=(*teeth, 255))
    d.ellipse([cx - w * .32, top + h * .58, cx + w * .32, top + h * 1.02],
              fill=(*tongue, 255))
    # 再クリップ(舌が口腔からはみ出さない)
    clip = Image.new("L", out.size, 0)
    ImageDraw.Draw(clip).ellipse([cx - w / 2, top, cx + w / 2, top + h], fill=255)
    lipped = base.copy()
    lipped.paste(out, (0, 0), clip)
    d2 = ImageDraw.Draw(lipped)
    # 唇ライン
    d2.ellipse([cx - w / 2, top, cx + w / 2, top + h],
               outline=(*lip, 255), width=max(2, int(bw * 0.055)))
    # 元の口消し(唇ラインの外側)をもう一度上描き…は不要(clip外=base)。
    # ただし元のmouthレイヤー痕が残るので肌カバーだけ再適用
    cover = Image.new("L", out.size, 0)
    ImageDraw.Draw(cover).rounded_rectangle(
        [ml - bw * .35, mt - bw * .35, mr + bw * .35, mb + bw * .8],
        radius=bw * .3, fill=255)
    ImageDraw.Draw(cover).ellipse([cx - w / 2 - 2, top - 2, cx + w / 2 + 2, top + h + 2], fill=0)
    skin_img = Image.new("RGBA", out.size, (*skin, 255))
    lipped.paste(skin_img, (0, 0), cover)
    return lipped


SS = 3   # スーパーサンプリング倍率(ImageDrawはAAなし→ジャギー対策で3xで描いて縮小)


def _scaled_rig(m: dict, s: int) -> dict:
    """描画に使う座標だけ s 倍したマニフェストコピー。"""
    import copy
    m2 = copy.deepcopy(m)
    m2["canvas"] = [m["canvas"][0] * s, m["canvas"][1] * s]
    r = m2["rig"]
    for k in ("eye", "mouth"):
        for kk, v in list(r[k].items()):
            if isinstance(v, (list, tuple)) and all(isinstance(x, (int, float)) for x in v):
                r[k][kk] = [x * s for x in v]
    return m2


def gen_variants(mdir: Path, m: dict) -> dict:
    base = flatten(mdir, m, skip_hair=True).convert("RGBA")
    # 3xキャンバスで描いて等倍へ縮小(輪郭がなめらかに)
    m_ss = _scaled_rig(m, SS)
    base_ss = base.resize((base.width * SS, base.height * SS), Image.LANCZOS)
    vdir = mdir / "variants_fast"
    vdir.mkdir(exist_ok=True)
    canvas = tuple(m["canvas"])
    out_meta: dict = {}

    def save(name: str, img_ss: Image.Image, kind: str):
        img = img_ss.resize(canvas, Image.LANCZOS)
        if True:
            # 口: 元regionが極小な立ち絵があるため、描画サイズ(bw基準)で
            # マスクを張り直す(はみ出すと上端が半透明カットされ灰色化する)
            ml, mt, mr, mb = m["rig"]["mouth"]["region"]
            cx, cy = m["rig"]["mouth"]["center"]
            bw = max(24.0, (mr - ml) * 1.15)
            region = [cx - bw * 0.75, cy - bw * 0.95, cx + bw * 0.75, cy + bw * 0.75]
        mask, _ = region_mask(canvas, region, "mouth" if kind != "eyes" else "eyes")
        patch = Image.new("RGBA", canvas, (0, 0, 0, 0))
        patch.paste(img.convert("RGB"), (0, 0))
        patch.putalpha(mask)
        patch.save(vdir / f"{name}.png")
        rel = f"variants_fast/{name}.png"
        if kind == "mouthHalf":
            out_meta.setdefault("mouthHalf", {})[name.split("_")[1]] = rel
        elif kind == "mouthSmile":
            out_meta.setdefault("mouthSmile", {})[name.split("_")[1]] = rel
        else:
            out_meta.setdefault(kind, {})[name.split("_", 1)[1]] = rel

    for v in VOWEL_SHAPES:
        save(f"mouth_{v}", draw_mouth(base_ss, m_ss, v, 1.0, False), "mouth")
        save(f"mouth_{v}_h", draw_mouth(base_ss, m_ss, v, 0.55, False), "mouthHalf")
        save(f"mouth_{v}_s", draw_mouth(base_ss, m_ss, v, 0.85, True), "mouthSmile")
    for name, cl in (("eyes_closed", 1.0), ("eyes_half", 0.5)):
        img_e, mask_e = draw_eyes(base, m, cl, mdir=mdir)
        patch = Image.new("RGBA", canvas, (0, 0, 0, 0))
        patch.paste(img_e.convert("RGB"), (0, 0))
        patch.putalpha(mask_e)
        patch.save(vdir / f"{name}.png")
        out_meta.setdefault("eyes", {})[name.split("_", 1)[1]] = f"variants_fast/{name}.png"
    return out_meta


# ── 2) 髪房分割: 輪郭ギャップ検出 ─────────────────────────────────────────────

def split_strands(mdir: Path, m: dict, max_strands: int = 6) -> int:
    """sway.type==hair のレイヤーを、下端輪郭の谷(房の切れ目)で最大N房に分割。
    各房は独立レイヤーになり、既存のverletHairが房ごとに揺らす。"""
    new_layers = []
    n_split = 0
    for layer in m["layers"]:
        sway = layer.get("sway") or {}
        if sway.get("type") != "hair":
            new_layers.append(layer)
            continue
        im = Image.open(mdir / layer["file"]).convert("RGBA")
        a = np.asarray(im)[:, :, 3]
        cols = np.where(a.max(axis=0) > 8)[0]
        if len(cols) < 60:
            new_layers.append(layer)
            continue
        x0, x1 = cols[0], cols[-1]
        # 下端プロファイル: 列ごとの「髪が届く最下端」
        prof = np.zeros(x1 - x0 + 1)
        for i, x in enumerate(range(x0, x1 + 1)):
            ys = np.where(a[:, x] > 8)[0]
            prof[i] = ys[-1] if len(ys) else 0
        k = max(9, len(prof) // 40) | 1
        prof_s = np.convolve(prof, np.ones(k) / k, mode="same")
        # 谷 = 房の切れ目(局所最小 かつ 山からの落差が十分)
        rng = prof_s.max() - prof_s.min()
        valleys = []
        if rng > 12:
            for i in range(k, len(prof_s) - k):
                seg = prof_s[i - k:i + k + 1]
                if prof_s[i] <= seg.min() + 1e-6 and seg.max() - prof_s[i] > rng * 0.18:
                    if not valleys or i - valleys[-1] > len(prof_s) / (max_strands * 1.6):
                        valleys.append(i)
        cuts = [0] + valleys[:max_strands - 1] + [len(prof_s)]
        if len(cuts) <= 2:
            new_layers.append(layer)
            continue
        feather = int(max(4, (x1 - x0) // 90))
        for si in range(len(cuts) - 1):
            gx0, gx1 = cuts[si], cuts[si + 1]
            mask = np.zeros(a.shape, dtype=np.float32)
            mask[:, x0 + gx0:x0 + gx1] = 1.0
            # 境界フェザー(縦線が見えないように)
            mimg = Image.fromarray((mask * 255).astype(np.uint8)).filter(
                ImageFilter.GaussianBlur(feather))
            strand = np.asarray(im).copy()
            strand[:, :, 3] = (strand[:, :, 3].astype(np.float32)
                               * (np.asarray(mimg, dtype=np.float32) / 255)).astype(np.uint8)
            sfile = f"{Path(layer['file']).stem}_s{si}.png"
            Image.fromarray(strand).save(mdir / sfile)
            ys, xs = np.where(strand[:, :, 3] > 8)
            bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] \
                if len(xs) else layer["bbox"]
            amp = sway.get("amp", 1.0) * (0.82 + 0.36 * (si % 3) / 2)   # 房ごとに揺れ差
            new_layers.append({**layer, "name": f"{layer['name']} s{si}",
                               "file": sfile, "bbox": bbox,
                               "sway": {**sway, "amp": round(amp, 2)}})
        n_split += 1
        print(f"  strands: {layer['file']} → {len(cuts) - 1}房")
    m["layers"] = new_layers
    return n_split


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("puppet_dir")
    ap.add_argument("--no-variants", action="store_true")
    ap.add_argument("--no-strands", action="store_true")
    ap.add_argument("--max-strands", type=int, default=6)
    a = ap.parse_args()
    mdir = Path(a.puppet_dir)
    m = json.loads((mdir / "manifest.json").read_text())

    t0 = time.time()
    if not a.no_variants:
        meta = gen_variants(mdir, m)
        m["rig"]["variants"] = meta
        m["rig"]["variantsMode"] = "fast"
        print(f"variants(fast): {sum(len(v) for v in meta.values())}枚 "
              f"({time.time() - t0:.1f}s)")
    t1 = time.time()
    if not a.no_strands:
        n = split_strands(mdir, m, a.max_strands)
        print(f"strand split: {n}レイヤー分割 ({time.time() - t1:.1f}s)")

    (mdir / "manifest.json").write_text(json.dumps(m, ensure_ascii=False))
    print(f"fast_rig done: {time.time() - t0:.1f}s total → {mdir / 'manifest.json'}")


if __name__ == "__main__":
    main()
