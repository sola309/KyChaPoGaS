#!/usr/bin/env python
"""comp-kit の数値の約束を確かめる。

  check_test.py            # 全部
  check_test.py --quick    # 決定論・プレビュー一致は例を 1 つずつだけ

確かめること:
  1. 不透明度 50% の赤 → 画素が rgba(255,0,0,128)(ストレートアルファで出る)
  2. 画像を 100% で置く → 元の画素と 1 バイトも違わない(軽いエフェクト・位置の足し算を付けても同じ)
  2e. mesh レイヤー: 光なしの箱の画素数・faces の並びと回転の向き・破片の progress 0 = 元の板・comp テクスチャ = comp レイヤー・立体文字の輪郭・複製の決定論・被写界深度
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

        # 2a. source.fit(N px に合わせる)。64×48 の画像を 200×200 の画面に置く
        def span0(im):
            w, h = im.size
            pxs = im.load()
            xs = [x for x in range(w) if any(pxs[x, y][3] > 127 for y in range(h))]
            ys = [y for y in range(h) if any(pxs[x, y][3] > 127 for x in range(w))]
            return (xs[0], xs[-1] + 1, ys[0], ys[-1] + 1) if xs and ys else None
        fitlay = lambda fit, **kw: comp([{"id": "i", "type": "image", "in": 0, "out": 10, "transform": {"position": [100, 100], **kw}, "source": {"url": url, **({"fit": fit} if fit is not None else {})}}])  # noqa: E731
        plain_png = asyncio.run(grab(fitlay(None), [0], base))[0]
        for name, fit, kw, want in [
            ("幅 128 → 128×96", {"width": 128}, {}, (36, 164, 52, 148)),
            ("高さ 96 → 128×96", {"height": 96}, {}, (36, 164, 52, 148)),
            ("箱 120×120 contain(既定)→ 120×90", {"width": 120, "height": 120}, {}, (40, 160, 55, 145)),
            ("箱 120×120 cover → 120×120(はみ出しは切る)", {"width": 120, "height": 120, "mode": "cover"}, {}, (40, 160, 40, 160)),
            ("箱 120×60 stretch → 120×60", {"width": 120, "height": 60, "mode": "stretch"}, {}, (40, 160, 70, 130)),
            ("何も書かない contain = 画面に収める → 200×150", {}, {}, (0, 200, 25, 175)),
            ("mode cover だけ = 画面を覆う → 200×200", {"mode": "cover"}, {}, (0, 200, 0, 200)),
            ("幅 128 + scale 50% → 64×48(scale は合わせた大きさに掛かる)", {"width": 128}, {"scale": [50, 50]}, (68, 132, 76, 124)),
        ]:
            sp = span0(px(asyncio.run(grab(fitlay(fit, **kw), [0], base))[0]))
            ok(f"fit: {name}", sp == want, str(sp))
        # 素材と同じ大きさを指定 → fit なしと 1 バイトも違わない(幅だけ・高さだけ・両方)
        for name, fit in [("幅 64", {"width": 64}), ("高さ 48", {"height": 48}), ("64×48 cover", {"width": 64, "height": 48, "mode": "cover"})]:
            ok(f"fit: 素材と同じ大きさ({name})= fit なしと同じ絵", px(asyncio.run(grab(fitlay(fit), [0], base))[0]).tobytes() == px(plain_png).tobytes())
        # cover は中央を映す: 左半分が赤・右半分が緑の 80×40 を 40×40 に cover → 左が赤・右が緑、上下は切れない
        two = Image.new("RGBA", (80, 40), (255, 0, 0, 255)); two.paste((0, 255, 0, 255), (40, 0, 80, 40)); two.paste((0, 0, 255, 255), (0, 0, 10, 40))
        b2 = io.BytesIO(); two.save(b2, "PNG")
        u2 = "data:image/png;base64," + base64.b64encode(b2.getvalue()).decode()
        im = px(asyncio.run(grab(comp([{"id": "i", "type": "image", "in": 0, "out": 10, "transform": {"position": [100, 100]}, "source": {"url": u2, "fit": {"width": 40, "height": 40, "mode": "cover"}}}]), [0], base))[0])
        ok("fit cover: 中央を映す(左端の青い帯は切れる)", im.getpixel((84, 100)) == (255, 0, 0, 255) and im.getpixel((116, 100)) == (0, 255, 0, 255) and im.getpixel((81, 100)) == (255, 0, 0, 255) and im.getpixel((78, 100))[3] == 0, f"{im.getpixel((81, 100))} {im.getpixel((84, 100))} {im.getpixel((116, 100))}")
        # fit のあとの crop は合わせたあとの箱から測る(幅 128×96 から左右 14 ずつ → 100×96)
        sp = span0(px(asyncio.run(grab(comp([{"id": "i", "type": "image", "in": 0, "out": 10, "transform": {"position": [100, 100]}, "source": {"url": url, "fit": {"width": 128}}, "effects": [{"type": "crop", "params": {"left": 14, "right": 14}}]}]), [0], base))[0]))
        ok("fit → crop は合わせたあとの箱の px", sp == (50, 150, 52, 148), str(sp))

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

        # 2c. trace_outline の破線(ENGINE_ISSUES R-2)。100×100 の四角の輪郭、周期 25 %・すき間 12.5 % → 真上から時計回りに 45° ごとに 線・すき間
        tr = lambda **p: comp([{"id": "s", "type": "solid", "in": 0, "out": 10, "transform": {"position": [100, 100]}, "source": {"color": "#ff0000", "width": 100, "height": 100},  # noqa: E731
                                "effects": [{"type": "trace_outline", "params": {"width": 8, "color": "#ffffff", "only_line": True, **p}}]}])
        im = px(asyncio.run(grab(tr(dash_period=25, dash_gap=12.5), [0], base))[0])
        on = [im.getpixel(q)[3] for q in ((121, 50), (150, 121), (79, 150), (50, 79))]      # 22.5° + 90°×n = 線
        off = [im.getpixel(q)[3] for q in ((150, 79), (121, 150), (50, 121), (79, 50))]     # 67.5° + 90°×n = すき間
        ok("trace_outline の破線: 線とすき間が交互", min(on) > 200 and max(off) < 30, f"{on} {off}")
        solid_png = px(asyncio.run(grab(tr(), [0], base))[0]).tobytes()
        ok("trace_outline: dash_period 0・すき間 0 は実線と同じ絵", px(asyncio.run(grab(tr(dash_period=0, dash_gap=30), [0], base))[0]).tobytes() == solid_png and px(asyncio.run(grab(tr(dash_period=25, dash_gap=0), [0], base))[0]).tobytes() == solid_png)
        # 2d. 円周の文字の deg_per_px(R-4)。180/π/半径 を書けば既定(字幅 ÷ 半径)と同じ絵、2 倍にすれば文字の間が開く
        import math
        oc = lambda **p: comp([{"id": "t", "type": "text", "in": 0, "out": 10, "transform": {"position": [200, 200]}, "source": {"text": "ABCDEFG", "font": "Noto Sans JP", "size": 40, "fill": "#ffffff", "on_circle": {"radius": 120, "rotation": 0, **p}}}], w=400, h=400, bg="#000000")  # noqa: E731
        g0 = px(asyncio.run(grab(oc(), [0], base))[0]); g1 = px(asyncio.run(grab(oc(deg_per_px=180 / math.pi / 120), [0], base))[0]); g2 = px(asyncio.run(grab(oc(deg_per_px=2 * 180 / math.pi / 120), [0], base))[0])
        d01 = sum(1 for a_, b_ in zip(g0.tobytes(), g1.tobytes()) if abs(a_ - b_) > 8)
        s0, s2 = span(g0), span(g2)
        ok("on_circle.deg_per_px = 180/π/半径 は既定と同じ並び", d01 < 40, f"違う画素 {d01}")
        ok("on_circle.deg_per_px を 2 倍 → 横に広がる", s2 and s0 and (s2[1] - s2[0]) > (s0[1] - s0[0]) * 1.4, f"{s0} {s2}")

        # 2e. mesh レイヤー(手続きの 3D)
        mesh = lambda objs, **src: {"id": "m", "type": "mesh", "in": 0, "out": 60, "transform": {"position": [100, 100, 0]}, "source": {"objects": objs, **src}}  # noqa: E731
        # 光なしの赤い箱 100×60×40。手前の面を z = 0 に置く → 画面では 100×60 px ちょうど(既定のカメラは z = 0 が等倍)
        im = px(asyncio.run(grab(comp([mesh([{"geometry": "box", "size": [100, 60, 40], "position": [0, 0, 20], "material": {"color": "#ff0000"}}], unlit=True)]), [0], base))[0])
        on = [(x, y) for y in range(200) for x in range(200) if im.getpixel((x, y))[3] > 0]
        bb = (min(q[0] for q in on), min(q[1] for q in on), max(q[0] for q in on), max(q[1] for q in on)) if on else None
        ok("mesh: 光なしの赤い箱(手前の面が z = 0)は 100×60 px・rgba(255,0,0,255)", len(on) == 6000 and bb == (50, 70, 149, 129) and all(im.getpixel(q) == (255, 0, 0, 255) for q in on), f"{len(on)} px {bb}")
        # 面ごとのマテリアル(箱 = 右・左・上・下・手前・奥)と回転の向き(y = 右が奥へ → 左の面が見える、x = 上が奥へ → 下の面が見える)
        fcs = [{"color": c} for c in ("#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff")]
        seen = []
        for rot in ([0, 0, 0], [0, 90, 0], [0, -90, 0], [90, 0, 0], [-90, 0, 0], [0, 180, 0]):
            im = px(asyncio.run(grab(comp([mesh([{"geometry": "box", "size": [80, 80, 80], "rotation": rot, "faces": fcs}], unlit=True)]), [0], base))[0])
            seen.append(im.getpixel((100, 100))[:3])
        ok("mesh: faces の並びと回転の向き(手前・左・右・下・上・奥の順に見える)", seen == [(255, 0, 255), (0, 255, 0), (255, 0, 0), (255, 255, 0), (0, 0, 255), (0, 255, 255)], str(seen))
        # 破片: progress 0 は、絵を貼った板そのもの(継ぎ目なし・画像レイヤーと同じ絵)
        timg = Image.new("RGBA", (120, 80))
        timg.putdata([(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256), 255) for _ in range(120 * 80)])
        from PIL import ImageDraw, ImageFilter
        ImageDraw.Draw(timg).rectangle([0, 0, 39, 29], fill=(255, 255, 255, 255))  # 左上の白(向きの目印)
        timg = timg.filter(ImageFilter.GaussianBlur(3)).convert("RGBA")  # なだらかな絵にする(くっきりした境目は、uv の補間のわずかな差が 2〜3 階調に化ける)
        tb = io.BytesIO(); timg.save(tb, "PNG")
        turl = "data:image/png;base64," + base64.b64encode(tb.getvalue()).decode()
        ref = px(asyncio.run(grab(comp([{"id": "i", "type": "image", "in": 0, "out": 60, "transform": {"position": [100, 100]}, "source": {"url": turl}}]), [0], base))[0])
        sh = lambda p: comp([mesh([{"geometry": "shards", "size": [120, 80], "count": 40, "seed": 5, "progress": p, "spread": 60, "material": {"type": "basic", "texture": {"url": turl}}}])])  # noqa: E731
        got = px(asyncio.run(grab(sh(0), [0], base))[0])
        # 比べるのは板の中(40,60)〜(160,140)。外は、mesh の側が完全に透明であること(画像レイヤーは縁の AA で 1/255 だけにじむ)
        inbox = (40, 60, 160, 140)
        outside = lambda im_: sum(1 for y in range(200) for x in range(200) if not (40 <= x < 160 and 60 <= y < 140) and im_.getpixel((x, y))[3] > 0)  # noqa: E731
        dmax = max(abs(a_ - b_) for a_, b_ in zip(got.crop(inbox).tobytes(), ref.crop(inbox).tobytes()))
        ok("mesh: 破片の progress 0 = 絵を貼った板(画像レイヤーと同じ・継ぎ目なし)", dmax <= 1 and min(got.getpixel((48, 68))[:3]) > 240 and outside(got) == 0, f"最大の差 {dmax}・外の画素 {outside(got)}")
        got = px(asyncio.run(grab(sh(0.6), [0], base))[0])
        holes = sum(1 for y in range(60, 140) for x in range(40, 160) if got.getpixel((x, y))[3] < 128)
        ok("mesh: 破片の progress 0.6 は板が割れて散る(すき間ができ、外へはみ出す)", holes > 300 and sum(1 for x in range(200) if got.getpixel((x, 30))[3] > 0 or got.getpixel((x, 170))[3] > 0) > 0, f"すき間 {holes} px")
        # 入れ子の絵をテクスチャに: 板(子と同じ大きさ・光なし)= comp レイヤーで置いた絵
        tmpm = Path(tempfile.mkdtemp(prefix="compkit_mesh_"))
        subm = {"id": 9960, "name": "meshsub", "width": 120, "height": 80, "fps": 30, "duration_frames": 30, "data": {"version": 1, "bg": "#204060", "layers": [
            {"id": "a", "type": "solid", "in": 0, "out": 30, "transform": {"position": [20, 15]}, "source": {"color": "#ffffff", "width": 40, "height": 30}},
            {"id": "b", "type": "shape", "in": 0, "out": 30, "transform": {"position": {"k": [{"f": 0, "v": [40, 50]}, {"f": 20, "v": [100, 50]}]}}, "source": {"kind": "ellipse", "width": 30, "height": 30, "fill": "#ff8000"}}]}}
        (tmpm / "meshsub.json").write_text(json.dumps(subm), encoding="utf-8")
        old_extra = rt.EXTRA_DIR
        rt.EXTRA_DIR = tmpm
        ref = asyncio.run(grab(comp([{"id": "n", "type": "comp", "in": 0, "out": 60, "transform": {"position": [100, 100]}, "source": {"comp_id": 9960}}]), [0, 10], base))
        got = asyncio.run(grab(comp([mesh([{"geometry": "plane", "size": [120, 80], "material": {"type": "basic", "texture": {"comp_id": 9960}}}])]), [0, 10], base))
        dmax = max(max(abs(a_ - b_) for a_, b_ in zip(px(got[f]).crop(inbox).tobytes(), px(ref[f]).crop(inbox).tobytes())) for f in (0, 10))
        ok("mesh: comp をテクスチャにした板 = comp レイヤー(向き・色・時刻が同じ)", dmax <= 1 and px(got[0]).tobytes() != px(got[10]).tobytes() and outside(px(got[0])) == 0, f"最大の差 {dmax}")
        rt.EXTRA_DIR = old_extra
        # 立体文字の輪郭: 厚み 0・光なしの白い文字は、テキストレイヤーの文字とほぼ同じ形(大きさ・面積)
        tx = px(asyncio.run(grab(comp([{"id": "t", "type": "text", "in": 0, "out": 60, "transform": {"position": [100, 100]}, "source": {"text": "愛あ", "font": "Noto Sans JP", "weight": 700, "size": 80, "fill": "#ffffff"}}]), [0], base))[0])
        mx = px(asyncio.run(grab(comp([mesh([{"geometry": "text", "text": "愛あ", "font": "Noto Sans JP", "weight": 700, "font_size": 80, "depth": 0, "material": {"color": "#ffffff"}}], unlit=True)]), [0], base))[0])
        def ink(im_):
            pts = [(x, y) for y in range(200) for x in range(200) if im_.getpixel((x, y))[3] > 127]
            return (max(q[0] for q in pts) - min(q[0] for q in pts), max(q[1] for q in pts) - min(q[1] for q in pts), len(pts)) if pts else (0, 0, 0)
        ti, mi = ink(tx), ink(mx)
        ok("mesh: 立体文字(日本語)の輪郭はテキストレイヤーの字と同じ大きさ", ti[2] > 2000 and abs(ti[0] - mi[0]) <= 2 and abs(ti[1] - mi[1]) <= 2 and abs(ti[2] - mi[2]) < ti[2] * 0.03, f"text {ti} mesh {mi}")
        # 複製(3D の紙吹雪): コマを描く順を変えても同じ絵
        conf = comp([mesh([{"geometry": "plane", "size": [10, 6], "material": {"color": "#ffffff"}, "instances": {
            "count": 300, "seed": 4, "layout": "box", "area": [260, 60, 200], "velocity": [0, 80, 0], "velocity_random": [30, 30, 20], "gravity": [0, 60, 0], "spin": [200, 150, 90], "spin_random": [200, 200, 200],
            "rotation_random": [180, 180, 180], "sway": {"amp": [20, 0, 10], "freq": 0.6}, "lifetime": 1.5, "loop": True, "colors": ["#ff5d73", "#ffd23f", "#3fd2c7"], "fade_in": 0.2, "fade_out": 0.3}}])], dur=60)
        c1 = asyncio.run(grab(conf, [3, 17, 40], base))
        c2 = asyncio.run(grab(conf, [40, 3, 17], base))
        ok("mesh: 複製(300 個)の決定論(描く順を変えても同じ絵・コマごとに違う絵)", all(c1[f] == c2[f] for f in (3, 17, 40)) and len({hashlib.md5(c1[f]).digest() for f in (3, 17, 40)}) == 3)
        # 被写界深度: ピントから外れた mesh レイヤーは、model と同じくレイヤーごとぼける
        dofc = lambda dof: comp([{"id": "cam", "type": "camera", "in": 0, "out": 60, "source": {"zoom": 400, **({"dof": {"focus_distance": 400, "aperture": 40}} if dof else {})}},  # noqa: E731
                                 {"id": "m", "type": "mesh", "in": 0, "out": 60, "transform": {"position": [100, 100, 600]}, "source": {"unlit": True, "objects": [{"geometry": "box", "size": [120, 120, 10], "material": {"color": "#ffffff"}}]}}])
        soft = lambda im_: sum(1 for y in range(0, 200, 2) for x in range(0, 200, 2) if 8 < im_.getpixel((x, y))[3] < 247)  # noqa: E731
        s0, s1 = soft(px(asyncio.run(grab(dofc(False), [0], base))[0])), soft(px(asyncio.run(grab(dofc(True), [0], base))[0]))
        ok("mesh: 被写界深度が掛かる(ぼけて半透明の縁が広がる)", s1 > s0 + 200, f"半透明の画素 {s0} → {s1}")

        # 3. 決定論 / 4. プレビュー一致
        exs = ["05_particles_adjustment", "10_text"] if a.quick else ["01_kinetic_type", "04_mask_matte_fx", "05_particles_adjustment", "08_repeater_shapes", "10_text", "11_character_card", "12_petals_3d_dof", "14_mesh_3d", "15_confetti_shatter"]
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
