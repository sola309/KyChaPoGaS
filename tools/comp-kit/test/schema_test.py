#!/usr/bin/env python
"""schema.json が本当にエンジンで通るかを確かめる。

  schema_test.py           # 全部
  schema_test.py -v        # 効き目の無かった項目も 1 つずつ出す

確かめること(どれも書き出しと同じ経路 = capture・SwiftShader で 1 コマ描く):
  - effects の全種類: 既定値のまま掛けて、警告・エラーが出ない
  - effects の各項目: 値を変えると絵が変わる(変わらない項目は「効き目なし」として数える。名前の書き間違いを見つけるため)
  - layer_types の全種類: default_source + default_layer で警告なし。source の各項目を既定値で書いても警告なし
  - layer_common の各項目・合成モード・イージング・プリセット: 警告なし
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_test as rt  # noqa: E402

KIT = rt.KIT
W, H = 320, 180

PAGE_JS = """() => {
  window.__warn = []
  const ow = console.warn, oe = console.error
  console.warn = (...a) => { window.__warn.push(a.map(String).join(' ')); ow.apply(console, a) }
  console.error = (...a) => { window.__warn.push(a.map(String).join(' ')); oe.apply(console, a) }
  window.__run = async (comp, f) => {
    const e = window.__compEngine
    window.__warn.length = 0
    e.update(comp)
    await e.renderFrame(f)
    const gl = e.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    let hash = 2166136261, sum = 0
    for (let i = 0; i < px.length; i++) { hash = Math.imul(hash ^ px[i], 16777619); sum += px[i] }
    return { hash: hash >>> 0, sum, warn: window.__warn.slice() }
  }
}"""


def comp(layers, bg=None):
    return {"id": "schema", "name": "schema", "width": W, "height": H, "fps": 30, "duration_frames": 60, "data": {"version": 1, "bg": bg, "layers": layers}}


def base_layer(effects=None, **extra):
    """エフェクトを掛ける相手: 色・縁・透明のある絵"""
    lay = {"id": "t", "type": "shape", "in": 0, "out": 60, "transform": {"position": [W / 2, H / 2]},
           "source": {"kind": "star", "sides": 5, "inner": 0.5, "width": 150, "height": 150, "stroke": "#ffffff", "stroke_width": 6,
                      "fill": {"gradient": {"angle": 120, "stops": [[0, "#ff3355"], [0.5, "#33cc66"], [1, "#2244ff"]]}}}}
    if effects is not None:
        lay["effects"] = effects
    lay.update(extra)
    return lay


def set_path(obj, path, value):
    keys = path.split(".")
    for k in keys[:-1]:
        if not isinstance(obj.get(k), dict):
            obj[k] = {}
        obj = obj[k]
    obj[keys[-1]] = value


def other_value(d):
    """既定値と違う値(効き目を見る用)。作れなければ None"""
    t, dv = d.get("type"), d.get("default")
    if t in ("number", "percent", "angle"):
        lo, hi = d.get("min"), d.get("max")
        base = dv if isinstance(dv, (int, float)) else (lo if lo is not None else 0)
        span = (hi - lo) if lo is not None and hi is not None else 100
        cand = base + max(span * 0.12, d.get("step") or 1) * (1 if hi is None or base + span * 0.12 <= hi else -1)
        if t == "angle":
            cand = base + 47
        return cand
    if t == "bool":
        return not bool(dv)
    if t == "select":
        if not isinstance(d.get("options"), list):
            return None
        opts = [o["value"] for o in d.get("options", []) if o["value"] != dv and o["value"] is not None]
        return opts[0] if opts else None
    if t == "color":
        return "#12c8f0" if dv != "#12c8f0" else "#f0c812"
    if t == "vec2":
        return [(dv[0] if dv else 0) + 23, (dv[1] if dv else 0) + 11]
    if t == "vec3":
        return [(dv[0] if dv else 0) + 23, (dv[1] if dv else 0) + 11, (dv[2] if dv and len(dv) > 2 else 0)]
    if t == "colors":
        return ["#102030", "#f0c812", "#ff00aa"]
    return None


async def run(verbose: bool):
    from playwright.async_api import async_playwright
    schema = json.loads((KIT / "schema.json").read_text(encoding="utf-8"))
    srv, base = rt.start_server()
    fails, noeffect, count = [], [], 0
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=rt.CHROME_ARGS)
        page = await browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.set_content(rt.build_html(comp([]), "capture", base), wait_until="load")
        await page.evaluate("window.__madAssetsReady || 0")
        await page.evaluate(PAGE_JS)

        async def draw(c, name, f=20):
            nonlocal count
            count += 1
            r = await page.evaluate("([c, f]) => window.__run(c, f)", [c, f])
            if r["warn"] or errs:
                fails.append((name, r["warn"] + errs))
                errs.clear()
            return r

        # ---- effects ----
        plain = await draw(comp([base_layer()]), "base")
        for et, ed in schema["effects"].items():
            params = {k: d["default"] for k, d in ed["params"].items() if d.get("default") is not None}
            r0 = await draw(comp([base_layer([{"type": et, "params": params}])]), f"effect {et}")
            if r0["sum"] == 0 and et not in ("opacity",):
                fails.append((f"effect {et}", ["既定値で何も映らない"]))
            for k, d in ed["params"].items():
                if "asset" in d:
                    continue
                v = other_value(d)
                if v is None:
                    continue
                p2 = dict(params); p2[k] = v
                r1 = await draw(comp([base_layer([{"type": et, "params": p2}])]), f"effect {et}.{k}")
                # 既定値では何もしないエフェクトもあるので、「既定値の絵」とも「素の絵」とも比べる
                if r1["hash"] == r0["hash"]:
                    noeffect.append(f"{et}.{k}")
        for al, real in schema.get("effect_aliases", {}).items():
            params = {k: d["default"] for k, d in schema["effects"][real]["params"].items() if d.get("default") is not None}
            a1 = await draw(comp([base_layer([{"type": al, "params": params}])]), f"alias {al}")
            a2 = await draw(comp([base_layer([{"type": real, "params": params}])]), f"alias {real}")
            if a1["hash"] != a2["hash"]:
                fails.append((f"alias {al}", [f"{real} と絵が違う"]))

        # ---- マスク ----
        for k, d in schema["mask"].items():
            m = {kk: dd["default"] for kk, dd in schema["mask"].items() if dd.get("default") is not None}
            v = other_value(d)
            if v is not None:
                m[k] = v
            await draw(comp([base_layer(masks=[m])]), f"mask.{k}")
        for o in schema["mask"]["shape"]["options"]:
            m = {"shape": o["value"], "x": 20, "y": 20, "w": 100, "h": 100}
            if o["value"] in ("polygon", "path"):
                m["points"] = [[10, 10], [120, 30], [90, 130], [20, 100]]
            r = await draw(comp([base_layer(masks=[m])]), f"mask shape {o['value']}")
            if r["hash"] == plain["hash"]:
                fails.append((f"mask shape {o['value']}", ["絵が変わらない"]))

        # ---- レイヤーの種類 ----
        for lt, ld in schema["layer_types"].items():
            lay = {"id": "x", "type": lt, "in": 0, "out": 60, "three_d": lt in ("model",), "transform": {"position": [W / 2, H / 2]}, "source": copy.deepcopy(ld["default_source"])}
            lay.update(copy.deepcopy(ld["default_layer"]))
            others = [base_layer()] if lt in ("adjustment", "group", "camera", "null") else []
            await draw(comp([lay] + others), f"layer {lt}")
            # source の各項目を既定値で(optional も含めて)1 つずつ足す
            for k, d in ld["source"].items():
                if d.get("default") is None or "asset" in d:
                    continue
                l2 = copy.deepcopy(lay)
                set_path(l2["source"], k, d["default"])
                r0 = await draw(comp([l2] + others), f"layer {lt}.source.{k}")
                v = other_value(d)
                if v is not None and lt not in ("camera", "null", "group", "model", "image", "video", "sequence", "comp", "adjustment"):
                    l3 = copy.deepcopy(l2)
                    set_path(l3["source"], k, v)
                    r1 = await draw(comp([l3] + others), f"layer {lt}.source.{k}*")
                    if r1["hash"] == r0["hash"]:
                        noeffect.append(f"{lt}.source.{k}")
                # オブジェクト型(座布団・影・カウンターなど)は fields の既定値を入れて描く
                if d.get("type") == "object" and d.get("fields"):
                    l4 = copy.deepcopy(lay)
                    set_path(l4["source"], k, {fk: fd["default"] for fk, fd in d["fields"].items() if fd.get("default") is not None and fd.get("type") != "object"})
                    await draw(comp([l4] + others), f"layer {lt}.source.{k}{{}}")
            for k, d in ld["source"].items():
                if d.get("type") == "object" and d.get("fields") and d.get("default") is None:
                    l4 = copy.deepcopy(lay)
                    obj = {}
                    for fk, fd in d["fields"].items():
                        if fd.get("type") == "object":
                            obj[fk] = {a: b["default"] for a, b in fd["fields"].items() if b.get("default") is not None}
                        elif fd.get("default") is not None:
                            obj[fk] = fd["default"]
                    set_path(l4["source"], k, obj)
                    await draw(comp([l4] + others), f"layer {lt}.source.{k}{{fields}}")

        # ---- レイヤー共通 ----
        for k, d in schema["layer_common"].items():
            if d.get("default") is None:
                continue
            types = d.get("types") or ["shape"]
            lay = base_layer() if types == ["shape"] else {"id": "t", "type": types[0], "in": 0, "out": 60, "source": copy.deepcopy(schema["layer_types"][types[0]]["default_source"])}
            if k.startswith("repeater.") and k != "repeater.count":
                set_path(lay, "repeater.count", 4)
                if k.startswith("repeater.grid"): set_path(lay, "repeater.mode", "grid")
                if k.startswith("repeater.radial"): set_path(lay, "repeater.mode", "radial")
                if k.startswith("repeater.random"): set_path(lay, "repeater.mode", "random")
            dv = d["default"] if d.get("options") != "blend_modes" else "normal"
            set_path(lay, k, dv)
            layers = [lay] + ([base_layer(id="u")] if lay["type"] in ("group", "camera", "adjustment") else [])
            r0 = await draw(comp(layers, bg="#203040"), f"common {k}", f=3)
            v = other_value(d)
            if v is not None and types == ["shape"] and k not in ("visible", "locked", "solo", "guide", "in", "out", "double_sided", "billboard"):
                l2 = copy.deepcopy(lay)
                if k.startswith("transition_") and not k.endswith(".type"):
                    pass
                set_path(l2, k, v)
                if k in ("three_d",): pass
                r1 = await draw(comp([l2], bg="#203040"), f"common {k}*", f=3)
                if r1["hash"] == r0["hash"]:
                    noeffect.append(f"layer.{k}")
        for o in schema["layer_common"]["transition_in.type"]["options"]:
            for side in ("transition_in", "transition_out"):
                lay = base_layer(**{side: {"type": o["value"], "duration": 30}})
                r = await draw(comp([lay], bg="#203040"), f"{side} {o['value']}", f=10 if side == "transition_in" else 50)
                if r["hash"] == (await draw(comp([base_layer()], bg="#203040"), "plain", f=10))["hash"]:
                    fails.append((f"{side} {o['value']}", ["絵が変わらない"]))
        for o in schema["blend_modes"]:
            await draw(comp([base_layer(blend=o["value"]), {"id": "b", "type": "solid", "in": 0, "out": 60, "source": {"color": "#806040"}}]), f"blend {o['value']}")
        for o in schema["easings"]:
            lay = base_layer()
            lay["transform"]["position"] = {"k": [{"f": 0, "v": [60, 90], "e": o["value"]}, {"f": 40, "v": [260, 90]}]}
            await draw(comp([lay]), f"easing {o['value']}")
        # ---- 模様の全種類・シェイプの全種類 ----
        for o in schema["layer_types"]["pattern"]["source"]["kind"]["options"]:
            r = await draw(comp([{"id": "p", "type": "pattern", "in": 0, "out": 60, "source": {"kind": o["value"], "colors": ["#e65163", "#ffffff", "#3b2d59"], "size": 30}}]), f"pattern {o['value']}")
            if r["sum"] == 0:
                fails.append((f"pattern {o['value']}", ["何も映らない"]))
        for o in schema["layer_types"]["shape"]["source"]["kind"]["options"]:
            r = await draw(comp([{"id": "s", "type": "shape", "in": 0, "out": 60, "transform": {"position": [160, 90]}, "source": {"kind": o["value"], "width": 120, "height": 100, "fill": "#e65163", "stroke": "#ffffff", "stroke_width": 4}}]), f"shape {o['value']}")
            if r["sum"] == 0:
                fails.append((f"shape {o['value']}", ["何も映らない"]))
        # ---- プリセット ----
        for kind, items in schema["presets"].items():
            for pr in items:
                lay = base_layer() if kind == "layer" else {"id": "t", "type": "text", "in": 0, "out": 60, "transform": {"position": [160, 90]}, "source": {"text": "見本 Sample", "size": 40, "fill": "#ffffff"}}
                for path, val in pr["apply"].items():
                    val = json.loads(json.dumps(val).replace('"out"', "60"))
                    if path == "effects+":
                        lay.setdefault("effects", []).extend(val)
                    else:
                        set_path(lay, path, val)
                await draw(comp([lay], bg="#203040"), f"preset {pr['id']}", f=8)
        await browser.close()
    srv.shutdown()
    print(f"描いた回数: {count}")
    print(f"効き目なし(値を変えても絵が同じ): {len(noeffect)} 件")
    if verbose or len(noeffect) < 60:
        for n in noeffect:
            print("   ", n)
    if fails:
        print(f"NG {len(fails)} 件")
        for name, w in fails:
            print("  ", name, "→", "; ".join(w)[:300])
        sys.exit(1)
    print("警告・エラーなし: OK")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", action="store_true")
    a = ap.parse_args()
    asyncio.run(run(a.v))
