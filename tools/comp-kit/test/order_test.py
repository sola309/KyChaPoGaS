#!/usr/bin/env python
"""エフェクトは「書いた順」に掛かる、を確かめる(B-3 の再発防止)。

  order_test.py        # 全部
  order_test.py -v     # 1 組ずつ出す

軽いエフェクト(シェーダの中で済ませる op)と形のエフェクト(flip / repeat)から 2 個を選び、順番つきの全部の組について
  [A, B]            … 速い経路(RT を使わずシェーダと行列でまとめる)
  [A, (区切り), B]  … 手本。間に「半径 0 のぼかし」を挟むと、A を RT に描き出してから B を掛ける(= 文字どおり順番に掛ける)
の 2 枚が同じ絵になることを見る。さらに、順番で絵が変わるはずの組([A, B] と [B, A])が本当に違う絵になることも見る。
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_test as rt  # noqa: E402

W, H = 240, 160

PAGE_JS = """() => {
  window.__warn = []
  const ow = console.warn
  console.warn = (...a) => { window.__warn.push(a.map(String).join(' ')); ow.apply(console, a) }
  const grab = async (comp) => {
    const e = window.__compEngine
    e.update(comp)
    await e.renderFrame(0)
    const gl = e.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    return px
  }
  // 2 枚の差: mean = 平均絶対差(0〜255)、big = 32 以上違う画素の割合、ink = 1 枚目に何か映っている画素の割合
  window.__diff = async (a, b, alphaOnly) => {
    window.__warn.length = 0
    const pa = await grab(a), pb = await grab(b)
    let sum = 0, big = 0, ink = 0
    for (let i = 0; i < pa.length; i += 4) {
      let d = 0
      // alphaOnly: 透明な所の色は RT に描き出すと残らない(乗算済みで持つので)。そこを見せる組はアルファだけ比べる
      for (let k = alphaOnly ? 3 : 0; k < 4; k++) d = Math.max(d, Math.abs(pa[i + k] - pb[i + k]))
      sum += d; if (d >= 32) big++
      if (pa[i + 3] > 8) ink++
    }
    const n = pa.length / 4
    return { mean: sum / n, big: big / n, ink: ink / n, warn: window.__warn.slice() }
  }
}"""


def data_url(im) -> str:
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def fixtures():
    """左右・上下・色・透明がどれも非対称な絵(順番が入れ替わるとすぐ分かる)と、重ねる用の絵"""
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", (120, 80), (0, 0, 0, 0))
    px = im.load()
    for y in range(80):
        for x in range(120):
            px[x, y] = (40 + x * 215 // 120, 30 + y * 225 // 80, 200 - x, 255)
    d = ImageDraw.Draw(im)
    d.rectangle([8, 8, 40, 30], fill=(255, 255, 255, 255))
    d.ellipse([70, 40, 110, 74], fill=(20, 20, 20, 255))
    d.rectangle([90, 0, 119, 20], fill=(0, 0, 0, 0))        # 右上は透明
    d.polygon([(0, 79), (0, 50), (30, 79)], fill=(255, 0, 0, 128))  # 左下は半透明
    ov = Image.new("RGBA", (60, 60), (0, 0, 0, 0))
    d2 = ImageDraw.Draw(ov)
    d2.ellipse([4, 4, 56, 56], fill=(0, 220, 255, 255))
    d2.rectangle([20, 20, 40, 40], fill=(255, 240, 0, 200))
    return data_url(im), data_url(ov)


def effects(ov_url):
    """名前 → エフェクト。どれも位置・向きが非対称になるようにしてある"""
    return {
        "clip_line": {"type": "clip_line", "params": {"cx": 12, "cy": -6, "angle": 25, "width": 0, "feather": 6}},
        "clip_band": {"type": "clip_line", "params": {"cx": -10, "cy": 0, "angle": 100, "width": 50}},
        "crop": {"type": "crop", "params": {"top": 12, "left": 26, "right": 4}},
        "mask_shape": {"type": "mask_shape", "params": {"shape": "ellipse", "x": 18, "y": -8, "size": 70, "aspect": 20}},
        "blinds": {"type": "blinds", "params": {"ratio": 60, "pitch": 22, "angle": 35}},
        "clip_sector": {"type": "clip_sector", "params": {"start": 20, "sweep": 100, "cx": 10, "cy": 5}},
        "iris": {"type": "iris", "params": {"progress": 55, "shape": "star", "cx": -12, "cy": 6}},
        "wipe": {"type": "wipe", "params": {"progress": 40, "angle": 70, "feather": 8}},
        "opacity": {"type": "opacity", "params": {"amount": 60}},
        "fill": {"type": "fill", "params": {"color": "#e03060", "amount": 70}},
        "fill_keep": {"type": "fill", "params": {"color": "#20a0e0", "amount": 100, "keep_luma": True}},
        "color": {"type": "color", "params": {"hue": 90, "contrast": 30, "brightness": -10}},
        "threshold": {"type": "threshold", "params": {"level": 120, "light": "#ffe080", "dark": "#30208000"}},
        "duotone": {"type": "duotone", "params": {"dark": "#201040", "light": "#ffd0a0"}},
        "invert": {"type": "invert", "params": {}},
        "invert_alpha": {"type": "invert_alpha", "params": {}},
        "luma_key": {"type": "luma_key", "params": {"threshold": 90, "softness": 20}},
        "gradient_overlay": {"type": "gradient_overlay", "params": {"angle": 60, "color": "#ffffff", "color2": "#000000", "blend": "multiply"}},
        "vignette": {"type": "vignette", "params": {"amount": 90, "radius": 20, "cx": 25, "cy": -10}},
        "lightleak": {"type": "lightleak", "params": {"x": -30, "y": 20, "radius": 40, "amount": 90}},
        "border": {"type": "border", "params": {"width": 6, "color": "#00ff80", "position": "outside"}},
        "overlay_over": {"type": "overlay_source", "params": {"url": ov_url, "mode": "over", "x": 34, "y": -14}},
        "overlay_under": {"type": "overlay_source", "params": {"url": ov_url, "mode": "under", "x": -30, "y": 10}},
        "overlay_replace": {"type": "overlay_source", "params": {"url": ov_url, "mode": "replace_color", "x": 10, "y": 6}},
        "flip_h": {"type": "flip", "params": {"h": True}},
        "flip_v": {"type": "flip", "params": {"h": False, "v": True}},
        "flip_luma": {"type": "flip", "params": {"h": False, "luma": True}},
        "repeat_line": {"type": "repeat", "params": {"mode": "line", "count": 2, "gap": 46, "angle": 90}},
        "repeat_grid": {"type": "repeat", "params": {"mode": "grid", "count_x": 2, "count_y": 1, "gap_x": 100, "gap_y": 100}},
    }


# 順番を入れ替えると絵が変わるはずの組(片方向だけ書く)
MUST_DIFFER = [
    ("flip_v", "clip_line"), ("flip_h", "clip_line"), ("flip_h", "crop"), ("flip_v", "mask_shape"), ("flip_h", "blinds"),
    ("flip_h", "gradient_overlay"), ("flip_v", "vignette"), ("flip_h", "wipe"), ("flip_h", "clip_sector"), ("flip_h", "iris"),
    ("flip_h", "overlay_over"), ("flip_v", "overlay_replace"), ("flip_h", "lightleak"),
    ("clip_line", "invert_alpha"), ("mask_shape", "invert_alpha"), ("blinds", "invert_alpha"),
    ("clip_line", "overlay_over"), ("clip_line", "overlay_under"), ("mask_shape", "overlay_under"),
    ("crop", "border"), ("clip_band", "overlay_under"), ("crop", "clip_line"), ("crop", "vignette"),
    ("repeat_line", "clip_line"), ("repeat_line", "mask_shape"), ("repeat_grid", "crop"), ("repeat_line", "gradient_overlay"),
    ("repeat_line", "flip_h"), ("fill", "color"), ("fill", "threshold"), ("invert", "fill_keep"), ("threshold", "invert_alpha"),
    ("luma_key", "invert"), ("overlay_over", "fill"), ("border", "fill"), ("overlay_over", "invert_alpha"),
]


def comp(url, fx):
    lay = {"id": "t", "type": "image", "in": 0, "out": 10, "transform": {"position": [W / 2, H / 2]}, "source": {"url": url}, "effects": fx}
    return {"id": "ord", "name": "ord", "width": W, "height": H, "fps": 30, "duration_frames": 10, "data": {"version": 1, "bg": None, "layers": [lay]}}


SEP = {"type": "blur", "params": {"radius": 0}}  # 半径 0 のぼかし = 絵は変えずに、ここまでを RT に描き出させる


async def run(verbose: bool):
    from playwright.async_api import async_playwright
    url, ov = fixtures()
    FX = effects(ov)
    names = list(FX)
    srv, base = rt.start_server()
    fails, n = [], 0
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=rt.CHROME_ARGS)
        page = await browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.set_content(rt.build_html(comp(url, []), "capture", base), wait_until="load")
        await page.evaluate("window.__madAssetsReady || 0")
        await page.evaluate(PAGE_JS)
        diff = lambda a, b, ao=False: page.evaluate("([a, b, ao]) => window.__diff(a, b, ao)", [a, b, ao])  # noqa: E731
        await diff(comp(url, list(FX.values())[:3]), comp(url, [FX["overlay_over"]]))  # 素材を読ませておく

        # 1 個ずつ: 手本の経路(区切りつき)でも同じ絵か、そもそも絵が変わるか
        for a in names:
            r = await diff(comp(url, [FX[a]]), comp(url, [FX[a], SEP]))
            r0 = await diff(comp(url, [FX[a]]), comp(url, []))
            n += 2
            if r["mean"] > 0.6 or r["big"] > 0.004:
                fails.append(f"単独 {a}: 区切りを足すと絵が変わる mean {r['mean']:.2f} big {r['big']:.4f}")
            if r0["mean"] < 0.3:
                fails.append(f"単独 {a}: 掛けても絵が変わらない")
            if r["warn"] or errs:
                fails.append(f"単独 {a}: {r['warn'] + errs}"); errs.clear()

        # 順番つきの全部の組: 速い経路 = 手本
        for a in names:
            for b in names:
                if a == b:
                    continue
                r = await diff(comp(url, [FX[a], FX[b]]), comp(url, [FX[a], SEP, FX[b]]), b == "invert_alpha")
                n += 1
                bad = r["mean"] > 0.8 or r["big"] > 0.006
                if verbose or bad:
                    print(f"  {'NG' if bad else 'ok'} [{a}, {b}]  mean {r['mean']:.3f}  big {r['big']:.4f}")
                if bad:
                    fails.append(f"[{a}, {b}]: 手本(1 個ずつ RT に描く)と違う mean {r['mean']:.2f} big {r['big']:.4f}")
                if r["warn"] or errs:
                    fails.append(f"[{a}, {b}]: {r['warn'] + errs}"); errs.clear()

        # 重いエフェクトのあとの切り抜き: 「あとで切る範囲だけ RT に描く」近道(先読み)と、近道なしが同じ絵か。
        # 幅 0 の枠は何も描かないが、アルファを足す種類なので先読みがそこで止まる(= 近道なしの手本になる)
        BAR = {"type": "border", "params": {"width": 0}}
        HEAVY = {
            "drop_shadow": {"type": "drop_shadow", "params": {"distance": 14, "angle": 120, "blur": 6, "opacity": 90, "color": "#102040"}},
            "outline_thick": {"type": "stroke_outline", "params": {"width": 8, "color": "#ffe000"}},
            "outline_thin": {"type": "stroke_outline", "params": {"width": 2, "color": "#00e0ff"}},
            "blur": {"type": "blur", "params": {"radius": 6}},
            "glow": {"type": "glow", "params": {"radius": 12, "strength": 1.5, "threshold": 30}},
        }
        for hn, h in HEAVY.items():
            for cn in ("clip_line", "clip_band", "crop", "mask_shape", "iris"):
                for extra in ([], [FX["fill"]]):
                    r = await diff(comp(url, [h, *extra, FX[cn]]), comp(url, [h, BAR, *extra, FX[cn]]))
                    n += 1
                    bad = r["mean"] > 0.3 or r["big"] > 0.002
                    if verbose or bad:
                        print(f"  {'NG' if bad else 'ok'} [{hn}, {'fill, ' if extra else ''}{cn}] 先読み  mean {r['mean']:.3f}  big {r['big']:.4f}  ink {r['ink']:.3f}")
                    if bad:
                        fails.append(f"[{hn}, {cn}]: 先読みで切った絵が、切らずに掛けた絵と違う mean {r['mean']:.2f} big {r['big']:.4f}")
                    if r["ink"] < 0.01:
                        fails.append(f"[{hn}, {cn}]: 何も映っていない")

        # 順番で変わるはずの組が、本当に違う絵になるか
        for a, b in MUST_DIFFER:
            r = await diff(comp(url, [FX[a], FX[b]]), comp(url, [FX[b], FX[a]]))
            n += 1
            bad = r["big"] < 0.004
            if verbose or bad:
                print(f"  {'NG' if bad else 'ok'} [{a}, {b}] ≠ [{b}, {a}]  mean {r['mean']:.3f}  big {r['big']:.4f}")
            if bad:
                fails.append(f"[{a}, {b}] と [{b}, {a}] が同じ絵(順番が効いていない) big {r['big']:.4f}")
        await browser.close()
    srv.shutdown()
    print(f"比べた回数: {n}(エフェクト {len(names)} 種、順番つきの組 {len(names) * (len(names) - 1)}、順番で変わるはずの組 {len(MUST_DIFFER)})")
    if fails:
        print(f"NG {len(fails)} 件")
        for f in fails:
            print("  ", f[:300])
        sys.exit(1)
    print("順番どおり: OK")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", action="store_true")
    asyncio.run(run(ap.parse_args().v))
