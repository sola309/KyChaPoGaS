#!/usr/bin/env python3
"""
cutout-kit — 生成イラストの高品質切り抜き(マッティング+デフリンジ)。

従来の白マット除去(prep_assets.unmatte_white)の置き換え。
  * マスク: rembg (birefnet-general 既定 / isnet-anime はアニメ線画向け)
  * デフリンジ: 半透明エッジの色から背景成分を除去(白背景生成の定石)
  * 掃除: 小さな浮きゴミ成分の除去 + エッジの軽いフェザー

CLI:  python cutout.py IN.png [OUT.png] [--model birefnet-general|isnet-anime]
      [--bg white|none] [--feather 1] [--min-blob 0.0004]
backend からは cut_image() を直接呼ぶ(同じvenv)。
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

_SESSIONS: dict = {}


def _session(model: str):
    if model not in _SESSIONS:
        from rembg import new_session
        _SESSIONS[model] = new_session(model)
    return _SESSIONS[model]


def _despeckle(alpha: np.ndarray, min_frac: float) -> np.ndarray:
    """本体以外の小さな浮き成分(背景の残り)を落とす。"""
    from scipy import ndimage
    solid = alpha > 96
    lab, n = ndimage.label(solid)
    if n <= 1:
        return alpha
    sizes = ndimage.sum(solid, lab, range(1, n + 1))
    keep = {i + 1 for i, s in enumerate(sizes) if s >= alpha.size * min_frac}
    if not keep:
        keep = {int(np.argmax(sizes)) + 1}
    # keep成分を少し膨らませた範囲の外はalpha 0(AAエッジは残す)
    mask = np.isin(lab, list(keep))
    mask = ndimage.binary_dilation(mask, iterations=3)
    out = alpha.copy()
    out[~mask] = 0
    return out


def _defringe_white(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """白背景に描かれた絵: C_obs = a*C + (1-a)*255 を逆算して縁の白かぶりを除去。"""
    a = alpha.astype(np.float32) / 255.0
    edge = (a > 0.02) & (a < 0.995)
    if not edge.any():
        return rgb
    af = a[edge][:, None]
    c = rgb[edge].astype(np.float32)
    rgb = rgb.copy()
    rgb[edge] = np.clip((c - (1.0 - af) * 255.0) / np.maximum(af, 0.10), 0, 255).astype(np.uint8)
    return rgb


def _deshadow(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """白背景生成に落ちがちなドロップシャドウ(半透明・低彩度・暗)を alpha から除く。
    不透明な暗部(黒髪リボン等)は残る — alpha が低い画素だけが対象。"""
    r = rgb.astype(np.int16)
    chroma = r.max(axis=2) - r.min(axis=2)
    shadow = (alpha < 150) & (chroma < 26) & (r.max(axis=2) < 215)
    out = alpha.copy()
    out[shadow] = 0
    return out


def cut_image(src: Image.Image, model: str = "isnet-anime", bg: str = "white",
              feather: float = 1.0, min_blob: float = 0.0004,
              deshadow: bool | None = None) -> Image.Image:
    """イラスト → 透過PNG。戻り値はRGBA(入力サイズ維持、cropしない)。"""
    from rembg import remove
    im = src.convert("RGB")
    out = remove(im, session=_session(model))  # RGBA
    arr = np.asarray(out).copy()
    rgb, alpha = arr[:, :, :3], arr[:, :, 3]

    alpha = _despeckle(alpha, min_blob)
    if deshadow is None:
        deshadow = bg == "white"
    if deshadow:
        alpha = _deshadow(rgb, alpha)
    if bg == "white":
        rgb = _defringe_white(rgb, alpha)
    if feather > 0:
        a_im = Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(feather))
        # フェザーは外側のみ(内側の不透明は保つ)
        alpha = np.minimum(alpha, np.asarray(a_im))

    return Image.fromarray(np.dstack([rgb, alpha]), "RGBA")


def crop_alpha(im: Image.Image, pad: int = 6) -> Image.Image:
    bbox = im.getchannel("A").getbbox()
    if not bbox:
        return im
    l, t, r, b = bbox
    return im.crop((max(0, l - pad), max(0, t - pad),
                    min(im.width, r + pad), min(im.height, b + pad)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst", nargs="?")
    ap.add_argument("--model", default="isnet-anime",
                    help="isnet-anime(既定: アニメ生成向け・輪郭最良) / birefnet-general(写真・汎用)")
    ap.add_argument("--bg", default="white", choices=["white", "none"],
                    help="生成時の背景色(デフリンジに使用)。写真等は none")
    ap.add_argument("--feather", type=float, default=1.0)
    ap.add_argument("--min-blob", type=float, default=0.0004)
    ap.add_argument("--no-crop", action="store_true")
    ap.add_argument("--no-deshadow", action="store_true")
    a = ap.parse_args()
    src = Path(a.src)
    dst = Path(a.dst) if a.dst else src.with_name(src.stem + "_cut.png")
    im = cut_image(Image.open(src), a.model, a.bg, a.feather, a.min_blob,
                   deshadow=False if a.no_deshadow else None)
    if not a.no_crop:
        im = crop_alpha(im)
    im.save(dst)
    print(dst)


if __name__ == "__main__":
    main()
