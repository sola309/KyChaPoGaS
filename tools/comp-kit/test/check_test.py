#!/usr/bin/env python
"""comp-kit の数値の約束を確かめる。

  check_test.py            # 全部
  check_test.py --quick    # 決定論・プレビュー一致は例を 1 つずつだけ

確かめること:
  1. 不透明度 50% の赤 → 画素が rgba(255,0,0,128)(ストレートアルファで出る)
  2. 画像を 100% で置く → 元の画素と 1 バイトも違わない(軽いエフェクト・位置の足し算を付けても同じ)
  2f. puppet レイヤー: 動かさない姿 = PNG を重ねた絵・決定論・首ふりで目が動く・髪の根元は固定
  2g. puppet のボーン: 肩 90° で腕が真横・動かさない姿 = PNG・決定論・preset wave で腕が上がる
  2e. mesh レイヤー: 光なしの箱の画素数・faces の並びと回転の向き・破片の progress 0 = 元の板・comp テクスチャ = comp レイヤー・立体文字の輪郭・複製の決定論・被写界深度・マネキン(手先の位置・ひじ 90 度・角度のキーフレーム・歩きの位相)
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

        # 2f. 足した効果(極座標の項目・減色・ラフエッジ・ブロックノイズ・フレア・屈折・モーションブラーの書き方)
        GR = {"gradient": {"angle": 90, "stops": [[0, "#ff0000"], [1, "#0000ff"]]}}
        fxl = lambda effects=None, **kw: comp([{"id": "s", "type": "shape", "in": 0, "out": 10, "transform": {"position": [100, 100]}, "source": {"kind": "rect", "width": 100, "height": 100, "fill": GR},  # noqa: E731
                                               **({"effects": effects} if effects else {}), **kw}])
        shot = lambda c, f=0: px(asyncio.run(grab(c, [f], base))[f])  # noqa: E731
        plain_im = shot(fxl())
        near = lambda p_, q_, t=4: all(abs(x - y) <= t for x, y in zip(p_, q_))  # noqa: E731
        im = shot(fxl([{"type": "polar", "params": {"fit": "cover"}}]))
        ok("polar fit: cover = 角度だけで色が決まる(同じ向きの 2 点が同じ色・右と左は違う色)・四隅まで埋まる",
           near(im.getpixel((125, 100)), im.getpixel((145, 100))) and not near(im.getpixel((130, 100)), im.getpixel((70, 100)), 30) and im.getpixel((52, 52))[3] == 255 and im.getpixel((147, 147))[3] == 255,
           f"{im.getpixel((125, 100))} {im.getpixel((145, 100))} {im.getpixel((70, 100))} {im.getpixel((52, 52))}")
        im0 = shot(fxl([{"type": "polar", "params": {}}]))
        ok("polar(項目なし)= 今までどおりの式(円の外は透明・何かは映る)", im0.getpixel((52, 52))[3] == 0 and any(im0.getpixel((x, y))[3] > 0 for y in range(50, 150, 5) for x in range(50, 150, 5)), f"{im0.getpixel((52, 52))}")
        im = shot(fxl([{"type": "palette", "params": {"colors": ["#ff0000", "#0000ff"]}}]))
        cols = {im.getpixel((x, y))[:3] for y in range(55, 145, 3) for x in range(55, 145)}
        ok("palette: 決めた 2 色だけになる", cols == {(255, 0, 0), (0, 0, 255)}, f"{sorted(cols)[:6]}")
        ok("rough_edges 量 0・しきい値 0 / block_noise 効く割合 0 / refract 強さ 0 は元の絵と同じ",
           shot(fxl([{"type": "rough_edges", "params": {"amount": 0, "threshold": 0}}])).tobytes() == plain_im.tobytes()
           and shot(fxl([{"type": "block_noise", "params": {"amount": 0}}])).tobytes() == plain_im.tobytes()
           and max(abs(x - y) for x, y in zip(shot(fxl([{"type": "refract", "params": {"amount": 0}}])).tobytes(), plain_im.tobytes())) <= 1)
        r1 = shot(fxl([{"type": "rough_edges", "params": {"amount": 30, "size": 20}}]), 0); r2 = shot(fxl([{"type": "rough_edges", "params": {"amount": 30, "size": 20}}]), 7)
        ed = [r1.getpixel((x, 100))[3] for x in range(20, 180)]
        ok("rough_edges: 縁がずれる・アルファは 2 値に近い・コマで変わらない(evolution を動かさなければ)", r1.tobytes() != plain_im.tobytes() and r1.tobytes() == r2.tobytes() and sum(1 for v in ed if 20 < v < 235) <= 8, f"中間のアルファ {sum(1 for v in ed if 20 < v < 235)}")
        b1 = shot(fxl([{"type": "block_noise", "params": {"count": [8, 8], "width": [30, 60], "height": [10, 30], "speed": 0}}]), 0); b2 = shot(fxl([{"type": "block_noise", "params": {"count": [8, 8], "width": [30, 60], "height": [10, 30], "speed": 0}}]), 5)
        ok("block_noise: 区画がずれる・speed 0 ならコマで変わらない", b1.tobytes() != plain_im.tobytes() and b1.tobytes() == b2.tobytes())
        fl = shot(comp([{"id": "s", "type": "shape", "in": 0, "out": 10, "transform": {"position": [100, 100]}, "source": {"kind": "rect", "width": 200, "height": 200, "fill": "#00000000"},
                         "effects": [{"type": "lens_flare", "params": {"radius": 20, "streak_length": 90, "rays": 1, "angle": 90}}]}]))
        ok("lens_flare: 中心は白・光芒は横(右 60px は光る・上 60px は光らない)・角は透明",
           min(fl.getpixel((100, 100))) > 240 and fl.getpixel((160, 100))[3] > 20 and fl.getpixel((100, 40))[3] < 12 and fl.getpixel((4, 4))[3] < 4, f"{fl.getpixel((100, 100))} {fl.getpixel((160, 100))} {fl.getpixel((100, 40))}")
        le = shot(fxl([{"type": "refract", "params": {"amount": 60, "radius": 40}}]))
        ok("refract(レンズ): 中をふくらませる(中心は同じ色・半径の中は中心寄りの色・外はそのまま)",
           near(le.getpixel((100, 100)), plain_im.getpixel((100, 100)), 6) and near(le.getpixel((120, 100)), plain_im.getpixel((110, 100)), 40) and not near(le.getpixel((120, 100)), plain_im.getpixel((120, 100)), 12) and le.getpixel((146, 100)) == plain_im.getpixel((146, 100)),
           f"{le.getpixel((120, 100))} 元 {plain_im.getpixel((120, 100))} 中心寄り {plain_im.getpixel((110, 100))}")
        MV = {"k": [{"f": 0, "v": [60, 100]}, {"f": 4, "v": [140, 100]}]}
        mbc = lambda mb: comp([{"id": "s", "type": "solid", "in": 0, "out": 10, "transform": {"position": MV}, "source": {"color": "#ff0000", "width": 20, "height": 20}, "motion_blur": mb}])  # noqa: E731
        m0 = shot(mbc(True), 2); m1 = shot(mbc({"samples": 16, "shutter": 0.5, "phase": -0.5}), 2); m2 = shot(mbc({"samples": 16, "shutter": 1, "phase": -1}), 2)
        cov = lambda im_: [x for x in range(200) if im_.getpixel((x, 100))[3] > 8]  # noqa: E731
        c0, c2 = cov(m0), cov(m2)
        ok("motion_blur {samples,shutter,phase}: 既定の値は true と同じ絵・phase -1 / shutter 1 は手前(左)へ 1 コマぶん尾を引く",
           m0.tobytes() == m1.tobytes() and c2 and c0 and abs((c2[-1] - c2[0]) - 39) <= 3 and abs(c2[-1] - 110) <= 2 and abs((c0[-1] - c0[0]) - 29) <= 3, f"true {c0[0]}..{c0[-1]} / 尾 {c2[0]}..{c2[-1]}")

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
        # マネキン(関節つきの人形): 手先が体格の式どおりの位置に来る・ひじを 90 度曲げると前腕ぶん動く・角度のキーフレーム・位相は 1 で 1 周
        MH = 160.0; Bq = MH - MH / 6.5; msw, mU, mF, mr = 0.118 * Bq, 0.19 * Bq, 0.17 * Bq, 0.012 * MH
        mT = Bq - 0.05 * Bq - 0.59 * Bq; msh = 0.59 * Bq + 0.6 * mT + 0.4 * mT - 0.03 * Bq   # 肩の高さ(足もとから)
        mq = lambda **kw: comp([mesh([{"geometry": "mannequin", "style": "stick", "position": [0, 80, 0], "body": {"height": MH, "heads": 6.5}, "colors": {"skin": "#ff0000", "top": "#00ff00", "bottom": "#0000ff", "shoes": "#0000ff"}, **kw}], unlit=True)])  # noqa: E731
        def hand(im, left=True):
            pts = [(x, y) for y in range(200) for x in (range(128, 200) if left else range(0, 72)) if im.getpixel((x, y))[0] > 200 and im.getpixel((x, y))[1] < 60 and im.getpixel((x, y))[3] > 200]
            return (sum(q[0] for q in pts) / len(pts) + 0.5, sum(q[1] for q in pts) / len(pts) + 0.5) if pts else (-1, -1)
        near = lambda a, b, tol=1.2: abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol  # noqa: E731
        imT = px(asyncio.run(grab(mq(preset="t_pose"), [0], base))[0])
        hl, hr = hand(imT), hand(imT, False)
        wantT = (100 + msw + mU + mF + mr, 180 - msh)
        ok("mesh: マネキンの T の字 = 手先が (肩幅 + 上腕 + 前腕) の位置・左右対称", near(hl, wantT) and near(hr, (200 - wantT[0], wantT[1])), f"左 {hl} 右 {hr} 期待 {wantT}")
        bent = {"shoulder_l": [0, -90, 90], "elbow_l": 90}
        imB = px(asyncio.run(grab(mq(preset="t_pose", pose=bent), [0], base))[0])
        hb = hand(imB)
        wantB = (100 + msw + mU, 180 - msh - mF - mr)
        ok("mesh: マネキンのひじを 90 度曲げる(上腕を外へひねって)→ 手先が前腕ぶん内へ・上へ", near(hb, wantB) and near(hand(imB, False), (200 - wantT[0], wantT[1])), f"{hb} 期待 {wantB}")
        gk = asyncio.run(grab(mq(preset="t_pose", pose={"shoulder_l": [0, -90, 90], "elbow_l": {"k": [{"f": 0, "v": 0}, {"f": 8, "v": 90}]}}), [0, 4, 8], base))
        ok("mesh: マネキンの角度はキーフレームにできる(0 コマ = T の字、8 コマ = 90 度と同じ絵、途中は別の絵)", px(gk[0]).tobytes() == imT.tobytes() and px(gk[8]).tobytes() == imB.tobytes() and px(gk[4]).tobytes() not in (imT.tobytes(), imB.tobytes()))
        wk = [px(asyncio.run(grab(mq(preset="walk", phase=ph, rotation=[0, 70, 0], hair={"style": "ponytail"}), [0], base))[0]) for ph in (0, 1, 0.25)]
        dif = lambda a, b: sum(1 for u, v in zip(a.tobytes(), b.tobytes()) if abs(u - v) > 8)  # noqa: E731
        ok("mesh: マネキンの歩き = 位相 1 で 1 周(0 と同じ絵)・0.25 は別の絵", dif(wk[0], wk[1]) < 8 and dif(wk[0], wk[2]) > 300, f"0↔1 の差 {dif(wk[0], wk[1])}・0↔0.25 の差 {dif(wk[0], wk[2])}")

        # 2f. puppet レイヤー(本番の既存のパペット kyoko_flat を /api/puppet/ から読む。無ければ飛ばす)
        try:
            import urllib.request
            man = json.loads(urllib.request.urlopen(f"{rt.BACKEND}/api/puppet/kyoko_flat/manifest", timeout=10).read())
        except Exception:  # noqa: BLE001
            man = None
            print("  -- puppet: 本番にパペット kyoko_flat が無いので飛ばす")
        if man:
            crop = [440, 40, 840, 440]
            pl = lambda **src: comp([{"id": "p", "type": "puppet", "in": 0, "out": 120, "transform": {"position": [200, 200]}, "source": {"puppet_id": "kyoko_flat", "crop": crop, **src}}], 400, 400, dur=120)  # noqa: E731
            # 何も動かさない(呼吸 0・ゆれ 0)= レイヤーの PNG を z 順に重ねただけの絵
            flat = Image.new("RGBA", tuple(man["canvas"]))
            for ly in sorted(man["layers"], key=lambda x: x["z"]):
                flat.alpha_composite(Image.open(io.BytesIO(urllib.request.urlopen(f"{rt.BACKEND}/api/puppet/kyoko_flat/layer/{ly['file']}", timeout=20).read())).convert("RGBA"))
            want = flat.crop(tuple(crop))
            got = px(asyncio.run(grab(pl(breath=0, sway=0), [7], base))[7])
            # 半透明の線を何枚も重ねる所は、8 ビットの乗算済みの丸めで数段ずれる(PIL はストレートで計算する)
            dif = [max(abs(x - y) for x, y in zip(p1, p2)) if p1[3] > 250 and p2[3] > 250 else abs(p1[3] - p2[3]) for p1, p2 in zip(got.getdata(), want.getdata())]
            n3 = sum(1 for v in dif if v > 3)
            ok("puppet: 動かさない姿 = レイヤーの PNG を重ねた絵(最大の差 10 以下・差 3 超えは 0.5% 未満)", max(dif) <= 10 and n3 < len(dif) * 0.005, f"最大の差 {max(dif)}・差 3 超え {n3} 画素")
            mv = pl(auto_blink=True, blink_interval=0.6, mouth={"k": [{"f": 0, "v": 0}, {"f": 30, "v": 1}]}, head_turn={"k": [{"f": 0, "v": -1}, {"f": 60, "v": 1}]}, head_tilt={"k": [{"f": 0, "v": 0}, {"f": 80, "v": 9}]},
                    body_lean={"k": [{"f": 0, "v": -3}, {"f": 90, "v": 3}]}, wind={"k": [{"f": 0, "v": 0}, {"f": 50, "v": 1}]}, sway=1.5)
            p1 = asyncio.run(grab(mv, [5, 41, 77], base))
            p2 = asyncio.run(grab(mv, [77, 5, 41], base))
            ok("puppet: 決定論(描く順を変えても同じ絵・コマごとに違う絵)", all(p1[f] == p2[f] for f in (5, 41, 77)) and len({hashlib.md5(p1[f]).digest() for f in (5, 41, 77)}) == 3)
            # 首ふり: 顔の中心(目・鼻・口)が輪郭より大きく動く = 画面の重心が首ふりの向きへ寄る。根元の固定: 風を変えても頭頂は動かない
            t0, t1 = (px(asyncio.run(grab(pl(breath=0, sway=0, head_turn=v), [0], base))[0]) for v in (-1, 1))
            dark = lambda im_: [x for y in range(150, 200) for x in range(100, 300) if im_.getpixel((x, y))[0] > 190 and 60 < im_.getpixel((x, y))[1] < 150 and im_.getpixel((x, y))[2] < 60]  # noqa: E731  橙の虹彩の画素の x
            m0, m1 = (sum(d_) / max(1, len(d_)) for d_ in (dark(t0), dark(t1)))
            ok("puppet: 首ふりで目が左右へ動く(右向き − 左向き > 12px)", m1 - m0 > 12, f"目の重心 x {m0:.1f} → {m1:.1f}")
            w0, w1 = (px(asyncio.run(grab(pl(breath=0, sway=2, wind=v), [20], base))[20]) for v in (-1, 1))
            top_same = w0.crop((0, 0, 400, 45)).tobytes() == w1.crop((0, 0, 400, 45)).tobytes()
            ok("puppet: 風を変えても髪の根元(頭頂)は動かず、毛先は動く", top_same and w0.crop((0, 250, 400, 400)).tobytes() != w1.crop((0, 250, 400, 400)).tobytes())

        # 2g. puppet のボーン(bones.png のある kyoko_parka_r2。無ければ飛ばす)
        try:
            import urllib.request
            urllib.request.urlopen(f"{rt.BACKEND}/api/puppet/kyoko_parka_r2/layer/bones.png", timeout=10).read()
            manb = json.loads(urllib.request.urlopen(f"{rt.BACKEND}/api/puppet/kyoko_parka_r2/manifest", timeout=10).read())
        except Exception:  # noqa: BLE001
            manb = None
            print("  -- puppet のボーン: 本番に kyoko_parka_r2 の bones.png が無いので飛ばす")
        if manb:
            import struct
            raw = Image.open(io.BytesIO(urllib.request.urlopen(f"{rt.BACKEND}/api/puppet/kyoko_parka_r2/layer/bones.png", timeout=10).read())).convert("RGB").tobytes()
            bj = json.loads(raw[4:4 + struct.unpack(">I", raw[:4])[0]].decode("utf-8"))["joints"]
            pb = lambda **src: comp([{"id": "p", "type": "puppet", "in": 0, "out": 120, "transform": {"position": [320, 320], "scale": [50, 50]}, "source": {"puppet_id": "kyoko_parka_r2", "breath": 0, "sway": 0, **src}}], 640, 640, dur=120)  # noqa: E731
            at = lambda im_, p_: im_.getpixel((int(round(p_[0] / 2)), int(round(p_[1] / 2))))  # noqa: E731  キャンバスの px → 画面(50%)
            mint = lambda c_: c_[3] > 200 and c_[1] > c_[0] + 15 and c_[2] > c_[0] + 8  # noqa: E731  パーカーの袖の色
            sh, el = bj["shoulder_l"], bj["elbow_l"]
            ulen = ((el[0] - sh[0]) ** 2 + (el[1] - sh[1]) ** 2) ** 0.5
            r0 = px(asyncio.run(grab(pb(), [0], base))[0])
            r1 = px(asyncio.run(grab(pb(pose={"shoulder_l": 90}), [0], base))[0])
            side_pt = (sh[0] + ulen * 0.9, sh[1])  # 肩から真横(画面の右)へ上腕の長さの 9 割
            ok("puppet のボーン: shoulder_l 90° で左腕(画面の右)が真横へ出る", mint(at(r0, el)) and not mint(at(r0, side_pt)) and mint(at(r1, side_pt)), f"元のひじ {at(r0, el)}・真横(前 {at(r0, side_pt)} → 後 {at(r1, side_pt)})")
            # 何も動かさないとき、ボーンつきでも絵は PNG を重ねたもの(左右に分けた層・格子が絵を壊していない)
            flatb = Image.new("RGBA", tuple(manb["canvas"]))
            for ly in sorted(manb["layers"], key=lambda x: x["z"]):
                flatb.alpha_composite(Image.open(io.BytesIO(urllib.request.urlopen(f"{rt.BACKEND}/api/puppet/kyoko_parka_r2/layer/{ly['file']}", timeout=20).read())).convert("RGBA"))
            cropb = [440, 300, 840, 700]
            gotb = px(asyncio.run(grab(comp([{"id": "p", "type": "puppet", "in": 0, "out": 10, "transform": {"position": [200, 200]}, "source": {"puppet_id": "kyoko_parka_r2", "crop": cropb, "breath": 0, "sway": 0}}], 400, 400), [3], base))[3])
            difb = [max(abs(x - y) for x, y in zip(p1, p2)) if p1[3] > 250 and p2[3] > 250 else abs(p1[3] - p2[3]) for p1, p2 in zip(gotb.getdata(), flatb.crop(tuple(cropb)).getdata())]
            nb3 = sum(1 for v in difb if v > 3)
            ok("puppet のボーン: 動かさない姿 = PNG を重ねた絵(差 3 超えは 0.5% 未満)", nb3 < len(difb) * 0.005, f"最大の差 {max(difb)}・差 3 超え {nb3} 画素")
            wk = pb(pose_preset="walk", pose_phase={"k": [{"f": 0, "v": 0}, {"f": 100, "v": 2}]}, pose={"elbow_r": {"k": [{"f": 0, "v": 0}, {"f": 100, "v": -60}]}})
            w1 = asyncio.run(grab(wk, [4, 33, 71], base)); w2 = asyncio.run(grab(wk, [71, 4, 33], base))
            ok("puppet のボーン: 決定論(walk + 関節のキー。描く順を変えても同じ絵・コマごとに違う絵)", all(w1[f] == w2[f] for f in (4, 33, 71)) and len({hashlib.md5(w1[f]).digest() for f in (4, 33, 71)}) == 3)
            # wave: 右手(画面の左)が肩より上へ上がる
            wv = px(asyncio.run(grab(pb(pose_preset="wave"), [0], base))[0])
            shr = bj["shoulder_r"]
            up = sum(1 for y in range(int(shr[1] / 2) - 110, int(shr[1] / 2) - 30) for x in range(int(shr[0] / 2) - 130, int(shr[0] / 2) - 20) if mint(wv.getpixel((x, y)))) 
            up0 = sum(1 for y in range(int(shr[1] / 2) - 110, int(shr[1] / 2) - 30) for x in range(int(shr[0] / 2) - 130, int(shr[0] / 2) - 20) if mint(r0.getpixel((x, y))))
            ok("puppet のボーン: preset wave で右腕(画面の左)が肩より上に来る", up > up0 + 150, f"肩より上の袖の画素 {up0} → {up}")

        # 3. 決定論 / 4. プレビュー一致
        exs = ["05_particles_adjustment", "10_text"] if a.quick else ["01_kinetic_type", "04_mask_matte_fx", "05_particles_adjustment", "08_repeater_shapes", "10_text", "11_character_card", "12_petals_3d_dof", "14_mesh_3d", "15_confetti_shatter", "puppet_01_idle"]
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
