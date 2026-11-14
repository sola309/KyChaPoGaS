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

        # 2b. 箱の決まり(AviUtl 取り込みで見つけたもの。ENGINE_ISSUES B-8 / B-9 / B-11 ほか)
        def span(im, bg=(0, 0, 0)):
            w, h = im.size
            pxs = im.load()
            xs = [x for x in range(w) if any(pxs[x, y][:3] != bg for y in range(0, h, 2))]
            ys = [y for y in range(h) if any(pxs[x, y][:3] != bg for x in range(0, w, 2))]
            return (xs[0], xs[-1] + 1, ys[0], ys[-1] + 1) if xs and ys else None
        so = {"type": "stroke_outline", "params": {"width": 20, "color": "#0000ff", "blur": 0}}
        cr = {"type": "crop", "params": {"top": 50, "bottom": 50, "left": 50, "right": 50}}
        # 120×80 の箱 + 縁取り 20 → 箱は 160×120(x 20〜180, y 40〜160)。そこから 50 ずつ切る → x 70〜130, y 90〜110
        for name, lay in {"solid(パス)": {"type": "solid", "source": {"color": "#ffff00", "width": 120, "height": 80}},
                          "shape(形に畳み込み)": {"type": "shape", "source": {"kind": "rect", "width": 120, "height": 80, "fill": "#ffff00"}}}.items():
            c = comp([{"id": "a", "in": 0, "out": 10, "transform": {"position": [100, 100]}, "effects": [so, cr], **lay}], bg="#000000")
            sp = span(px(asyncio.run(grab(c, [0], base))[0]))
            ok(f"縁取り → crop は広がった箱から測る: {name}", sp == (70, 130, 90, 110), str(sp))
        # stroke_in_box: 線の外側までが箱。外形 120×80(線 20 の中心は 100×60)+ crop 5 → x 45〜155, y 65〜135。無ければ線の中心の箱から(x 55〜145)
        for flag, want in ((True, (45, 155, 65, 135)), (False, (55, 145, 75, 125))):
            c = comp([{"id": "a", "type": "shape", "in": 0, "out": 10, "transform": {"position": [100, 100]}, "source": {"kind": "rect", "width": 100, "height": 60, "fill": None, "stroke": "#ffff00", "stroke_width": 20, "join": "miter", "stroke_in_box": flag},
                       "effects": [{"type": "crop", "params": {"top": 5, "bottom": 5, "left": 5, "right": 5}}]}], bg="#000000")
            sp = span(px(asyncio.run(grab(c, [0], base))[0]))
            ok(f"shape の stroke_in_box = {flag}: crop の基準", sp == want, str(sp))
        # ぼかしのあとの flip(画面より大きいレイヤーでも反転する)。左が赤・右が緑の 2 枚組をぼかして左右反転 → 左が緑
        half = lambda col, x: {"id": col, "type": "solid", "in": 0, "out": 10, "transform": {"position": [x, 300]}, "source": {"color": col, "width": 800, "height": 1200}}  # noqa: E731
        sub = {"id": 9950, "name": "sub", "width": 1600, "height": 1200, "fps": 30, "duration_frames": 10, "data": {"version": 1, "bg": None, "layers": [half("#ff0000", 400), half("#00ff00", 1200)]}}
        tmpd = Path(tempfile.mkdtemp(prefix="compkit_chk_sub_"))
        (tmpd / "sub.json").write_text(json.dumps(sub), encoding="utf-8")
        old_extra = rt.EXTRA_DIR
        rt.EXTRA_DIR = tmpd
        c = comp([{"id": "n", "type": "comp", "in": 0, "out": 10, "transform": {"position": [100, 100]}, "source": {"comp_id": 9950}, "effects": [{"type": "blur", "params": {"radius": 30}}, {"type": "flip", "params": {"h": True}}]}], bg="#000000")
        im = px(asyncio.run(grab(c, [0], base))[0])
        l_, r_ = im.getpixel((20, 100)), im.getpixel((180, 100))
        ok("ぼかし → flip(大きなレイヤー): 左右が入れ替わる", l_[1] > 200 and l_[0] < 50 and r_[0] > 200 and r_[1] < 50, f"{l_} {r_}")
        # comp レイヤーの transparent: 子の背景色を塗らない
        sub2 = dict(sub, id=9951, width=200, height=200, data={"version": 1, "bg": "#000000", "layers": [{"id": "s", "type": "solid", "in": 0, "out": 10, "transform": {"position": [50, 50]}, "source": {"color": "#ffffff", "width": 40, "height": 40}}]})
        (tmpd / "sub2.json").write_text(json.dumps(sub2), encoding="utf-8")
        for flag, want in ((False, (0, 0, 0, 255)), (True, (0, 0, 255, 255))):
            c = comp([{"id": "n", "type": "comp", "in": 0, "out": 10, "transform": {"position": [100, 100]}, "source": {"comp_id": 9951, "transparent": flag}}], bg="#0000ff")
            im = px(asyncio.run(grab(c, [0], base))[0])
            ok(f"comp の transparent = {flag}: 子の背景", im.getpixel((150, 150)) == want and im.getpixel((50, 50)) == (255, 255, 255, 255), str(im.getpixel((150, 150))))
        rt.EXTRA_DIR = old_extra
        # matte.layers(時間で入れ替わるマット元)と matte.absent
        red = {"id": "r", "type": "solid", "in": 0, "out": 10, "transform": {"position": [100, 100]}, "source": {"color": "#ff0000", "width": 200, "height": 200}}
        m1 = {"id": "m1", "type": "solid", "in": 0, "out": 3, "transform": {"position": [50, 100]}, "source": {"color": "#ffffff", "width": 100, "height": 200}}
        m2 = {"id": "m2", "type": "solid", "in": 3, "out": 6, "transform": {"position": [150, 100]}, "source": {"color": "#ffffff", "width": 100, "height": 200}}
        for absent, want6 in (("show", (255, 0, 0, 255)), (None, (0, 0, 0, 0))):
            mt = {"layer": "m1", "layers": ["m1", "m2"], "mode": "alpha", **({"absent": absent} if absent else {})}
            fr = asyncio.run(grab(comp([dict(red, matte=mt), m1, m2]), [1, 4, 7], base))
            g = lambda f, x: px(fr[f]).getpixel((x, 100))  # noqa: E731
            ok(f"matte.layers: その時刻のマット元で切る(absent = {absent})", g(1, 50)[3] == 255 and g(1, 150)[3] == 0 and g(4, 50)[3] == 0 and g(4, 150)[3] == 255 and g(7, 50) == want6, f"{g(1, 50)} {g(1, 150)} {g(4, 50)} {g(4, 150)} {g(7, 50)}")
        # vignette_blur の shape: circle = どの向きにも同じ距離で効く / brightness = 周辺を明るく
        vg = lambda **p: comp([{"id": "adj", "type": "adjustment", "in": 0, "out": 10, "effects": [{"type": "vignette_blur", "params": {"blur": 0, "radius": 20, "softness": 30, "amount": 0, **p}}]},  # noqa: E731
                               {"id": "s", "type": "solid", "in": 0, "out": 10, "source": {"color": "#808080"}}], w=400, h=200)
        im = px(asyncio.run(grab(vg(shape="circle", ramp="linear", brightness=120), [0], base))[0])
        ctr, rgt, dwn, far = im.getpixel((200, 100))[0], im.getpixel((280, 100))[0], im.getpixel((200, 180))[0], im.getpixel((395, 100))[0]
        ok("vignette_blur circle + brightness: 横と縦で同じ・周辺が +20%", ctr == 128 and abs(rgt - dwn) <= 1 and rgt > 130 and abs(far - (128 + 51)) <= 1, f"{ctr} {rgt} {dwn} {far}")
        im = px(asyncio.run(grab(vg(amount=50), [0], base))[0])
        ok("vignette_blur 既定(箱のだ円): 横と縦で違う", im.getpixel((280, 100))[0] > im.getpixel((200, 180))[0] + 5, f"{im.getpixel((280, 100))[0]} {im.getpixel((200, 180))[0]}")

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
