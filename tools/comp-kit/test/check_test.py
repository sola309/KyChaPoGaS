#!/usr/bin/env python
"""comp-kit の数値の約束を確かめる。

  check_test.py            # 全部
  check_test.py --quick    # 決定論・プレビュー一致は例を 1 つずつだけ

確かめること:
  1. 不透明度 50% の赤 → 画素が rgba(255,0,0,128)(ストレートアルファで出る)
  2. 画像を 100% で置く → 元の画素と 1 バイトも違わない(軽いエフェクト・位置の足し算を付けても同じ)
  3. 決定論: コマを描く順を変えても同じ絵(md5)
  4. プレビュー経路 = 書き出し経路(同じ GL なら同じ絵)
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import io
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_test as rt  # noqa: E402

KIT = rt.KIT


def comp(layers, w=200, h=200, bg=None, dur=10):
    return {"id": "chk", "name": "chk", "width": w, "height": h, "fps": 30, "duration_frames": dur, "data": {"version": 1, "bg": bg, "layers": layers}}


async def grab(c: dict, frames: list[int], base: str, mode="capture", example="") -> dict[int, bytes]:
    out = Path(tempfile.mkdtemp(prefix="compkit_chk_"))
    await rt.render_frames(c, frames, out, base, mode, example, "x")
    return {f: (out / f"x_{f:04d}.png").read_bytes() for f in frames}


def px(png: bytes):
    from PIL import Image
    return Image.open(io.BytesIO(png)).convert("RGBA")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    a = ap.parse_args()
    from PIL import Image
    import random
    srv, base = rt.start_server()
    fails = []

    def ok(name, cond, extra=""):
        print(f"  {'OK ' if cond else 'NG '} {name} {extra}")
        if not cond:
            fails.append(name)

    try:
        # 1. 50% の赤
        c = comp([{"id": "r", "type": "solid", "in": 0, "out": 10, "transform": {"opacity": 50}, "source": {"color": "#ff0000", "width": 100, "height": 100}}])
        im = px(asyncio.run(grab(c, [0], base))[0])
        ok("50% 赤 = rgba(255,0,0,128)", im.getpixel((100, 100)) == (255, 0, 0, 128), str(im.getpixel((100, 100))))
        ok("外は透明", im.getpixel((5, 5)) == (0, 0, 0, 0), str(im.getpixel((5, 5))))

        # 2. 画像 100%
        rnd = random.Random(3)
        src = Image.new("RGBA", (64, 48))
        src.putdata([(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256), 255) for _ in range(64 * 48)])
        buf = io.BytesIO(); src.save(buf, "PNG")
        url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
        variants = {
            "そのまま": {},
            "offset つき": {"effects": [{"type": "offset", "params": {"position": [10, -6]}}]},
            "切り抜きつき(crop 0・clip_line の外)": {"effects": [{"type": "clip_line", "params": {"angle": 0, "width": 0, "cy": 100}}, {"type": "color", "params": {}}]},
            "複製 1 個": {"repeater": {"count": 1}},
            "グループの中": {"_group": True},
        }
        for name, extra in variants.items():
            extra = dict(extra)
            layers = [{"id": "i", "type": "image", "in": 0, "out": 10, "transform": {"position": [100, 100]}, "source": {"url": url}, **{k: v for k, v in extra.items() if not k.startswith("_")}}]
            if extra.get("_group"):
                layers.insert(0, {"id": "g", "type": "group", "scope": 1, "in": 0, "out": 10, "transform": {"position": [120, 110]}})
            im = px(asyncio.run(grab(comp(layers, bg="#000000"), [0], base))[0])
            dx, dy = (10, -6) if "offset" in name else (20, 10) if extra.get("_group") else (0, 0)
            crop = im.crop((100 - 32 + dx, 100 - 24 + dy, 100 + 32 + dx, 100 + 24 + dy))
            ok(f"画像 100%: {name}", crop.tobytes() == src.tobytes())

        # 3. 決定論 / 4. プレビュー一致
        exs = ["05_particles_adjustment", "10_text"] if a.quick else ["01_kinetic_type", "04_mask_matte_fx", "05_particles_adjustment", "08_repeater_shapes", "10_text", "11_character_card", "12_petals_3d_dof"]
        for ex in exs:
            c = json.loads((KIT / "examples" / f"{ex}.json").read_text(encoding="utf-8"))
            d = c["duration_frames"]
            fr = [d // 5, d // 2, d - 3]
            a1 = asyncio.run(grab(c, fr, base))
            a2 = asyncio.run(grab(c, [fr[2], fr[0], fr[1]], base))
            ok(f"決定論(描く順): {ex}", all(hashlib.md5(a1[f]).digest() == hashlib.md5(a2[f]).digest() for f in fr))
            pv = asyncio.run(grab(c, [fr[1]], base, "preview", f"{ex}.json"))
            same = px(pv[fr[1]]).tobytes() == px(a1[fr[1]]).tobytes()
            ok(f"プレビュー = 書き出し: {ex}", same)
    finally:
        srv.shutdown()
    print("\n" + ("すべて OK" if not fails else f"NG {len(fails)} 件: {fails}"))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
