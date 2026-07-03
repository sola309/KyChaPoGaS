#!/usr/bin/env python3
"""
bleed — 画像の縁にのりしろを足す(パン/ズーム/視差で切れ目が見えない様に)。

ミラー反転で外周を延長し、外側ほどぼかす。背景・中景素材の前処理。
  python bleed.py IN.jpg [OUT.png] [--frac 0.10] [--blur 18]
"""
import argparse
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps


def add_bleed(im: Image.Image, frac: float = 0.10, blur: int = 18) -> Image.Image:
    w, h = im.size
    bw, bh = int(w * frac), int(h * frac)
    big = Image.new(im.mode, (w + bw * 2, h + bh * 2))
    big.paste(ImageOps.mirror(im), (bw - w, bh))            # 左
    big.paste(ImageOps.mirror(im), (bw + w, bh))            # 右
    big.paste(ImageOps.flip(im), (bw, bh - h))              # 上
    big.paste(ImageOps.flip(im), (bw, bh + h))              # 下
    for dx, dy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):     # 四隅は両反転
        big.paste(ImageOps.flip(ImageOps.mirror(im)), (bw + dx * w, bh + dy * h))
    big.paste(im, (bw, bh))
    # のりしろ部分だけぼかす(継ぎ目とミラーの不自然さを溶かす)
    blurred = big.filter(ImageFilter.GaussianBlur(blur))
    mask = Image.new("L", big.size, 255)
    mask.paste(0, (bw + blur, bh + blur, bw + w - blur, bh + h - blur))
    mask = mask.filter(ImageFilter.GaussianBlur(blur))
    return Image.composite(blurred, big, mask)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst", nargs="?")
    ap.add_argument("--frac", type=float, default=0.10)
    ap.add_argument("--blur", type=int, default=18)
    a = ap.parse_args()
    src = Path(a.src)
    dst = Path(a.dst) if a.dst else src.with_name(src.stem + "_bleed.png")
    add_bleed(Image.open(src), a.frac, a.blur).save(dst)
    print(dst)


if __name__ == "__main__":
    main()
