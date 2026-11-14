#!/usr/bin/env python
"""schema.json が本当にエンジンで通るかを確かめる。

  schema_test.py           # 全部
  schema_test.py -v        # 効き目の無かった項目も 1 つずつ出す

確かめること(どれも書き出しと同じ経路 = capture・SwiftShader で 1 コマ描く):
  - effects の全種類: 既定値のまま掛けて、警告・エラーが出ない
  - effects の **全項目**: 値を既定値から別の値へ動かすと絵が変わる。変わらなければ NG(死んだ項目・名前の書き間違い)。
    項目ごとに「効き目が見える場面」が違うので、エフェクトごとの下ごしらえ(FX_FIXTURE: 土台の値・項目ごとの前提・動かす先の値)を持つ
  - レイヤーの source・共通項目: 同じく動かして比べる。こちらは変わらない項目を「効き目なし」として一覧に出す(SRC_CTX に前提を書いたものは NG にする)
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


def other_from(d, cur):
    """いまの値 cur と違う、効き目の出そうな値"""
    t = d.get("type")
    if t in ("number", "percent", "angle"):
        lo, hi = d.get("min"), d.get("max")
        base = cur if isinstance(cur, (int, float)) and not isinstance(cur, bool) else (lo if lo is not None else 0)
        if t == "angle":
            return base + 47
        span = (hi - lo) if lo is not None and hi is not None else 100
        stepv = max(span * 0.12, d.get("step") or 1)
        return base + stepv if hi is None or base + stepv <= hi else base - stepv
    if t == "bool":
        return not bool(cur)
    if t == "select":
        if not isinstance(d.get("options"), list):
            return None
        opts = [o["value"] for o in d["options"] if o["value"] != cur and o["value"] is not None]
        return opts[0] if opts else None
    if t == "color":
        return "#12c8f0" if cur != "#12c8f0" else "#f0c812"
    if t == "vec2":
        return [(cur[0] if cur else 0) + 23, (cur[1] if cur else 0) + 11]
    if t == "vec3":
        return [(cur[0] if cur else 0) + 23, (cur[1] if cur else 0) + 11, (cur[2] if cur and len(cur) > 2 else 0)]
    if t == "colors":
        return ["#102030", "#f0c812", "#ff00aa"]
    return None


def test_images():
    """マスク・合成に使う絵(アルファも輝度もまだらで、左右・上下が非対称)"""
    import base64, io
    from PIL import Image, ImageDraw
    def url(im):
        b = io.BytesIO(); im.save(b, "PNG")
        return "data:image/png;base64," + base64.b64encode(b.getvalue()).decode()
    m = Image.new("RGBA", (120, 90), (0, 0, 0, 0))
    d = ImageDraw.Draw(m)
    d.ellipse([10, 8, 80, 78], fill=(255, 255, 255, 255))
    d.rectangle([60, 40, 115, 85], fill=(60, 60, 60, 255))
    d.polygon([(0, 89), (40, 89), (0, 50)], fill=(200, 200, 200, 120))
    o = Image.new("RGBA", (70, 50), (0, 0, 0, 0))
    d = ImageDraw.Draw(o)
    d.rectangle([4, 4, 50, 40], fill=(0, 220, 255, 255))
    d.ellipse([30, 15, 66, 46], fill=(255, 240, 0, 200))
    return url(m), url(o)


def fx_fixtures(mask_url, ov_url):
    """エフェクトごとの下ごしらえ。
      base  … 既定値の上に重ねる値(既定値のままでは何もしないエフェクトを、効く状態にする)
      per   … 項目ごと: ctx = その項目の効き目が見える前提、value = 動かす先(省略時は other_from)
      layer … 土台のレイヤーへの上書き(点つきの道)
      skip  … 動かして比べない項目(理由つき)"""
    A = "asset_id は本番の素材が要るので、同じ読み口の url で代用して確かめる"
    return {
        "clip_line": {"base": {"angle": 30}, "per": {"feather_mode": {"ctx": {"width": 80, "feather": 60}, "value": "inside"}}},
        "crop": {"base": {"top": 20}, "per": {"feather": {"value": 10}}},
        "blinds": {"base": {"pitch": 40}, "per": {"stagger": {"value": 150}}},
        "radial_wipe": {"base": {"sweep": 200}},
        "iris": {"base": {"progress": 50, "shape": "star"}},
        "wipe": {"base": {"progress": 40}},
        "mask_shape": {"base": {"size": 100}, "per": {"rotation": {"ctx": {"shape": "rect", "aspect": 40}}, "radius": {"ctx": {"shape": "rect"}, "value": 30}, "expansion": {"value": 12}}},
        "mask_image": {"base": {"url": mask_url}, "skip": {"asset_id": A}, "per": {"size": {"value": 70}, "feather": {"value": 8}, "channel": {"value": "luma"}}},
        "repeat": {"layer": {"transform.scale": 30}, "base": {"gap_x": 110, "gap_y": 110}, "per": {
            "scroll_x": {"value": 37}, "scroll_y": {"value": 23},
            "angle": {"ctx": {"mode": "line"}}, "both": {"ctx": {"mode": "line"}},
            "radius": {"ctx": {"mode": "circle"}, "value": 60}, "sweep": {"ctx": {"mode": "circle", "radius": 60}, "value": 180}, "rotate": {"ctx": {"mode": "circle", "radius": 60}},
            "area_x": {"ctx": {"mode": "random"}, "value": 150}, "area_y": {"ctx": {"mode": "random"}, "value": 100}, "seed": {"ctx": {"mode": "random", "area_x": 200, "area_y": 120}},
            "random_rotation": {"ctx": {"mode": "random", "area_x": 200, "area_y": 120}, "value": 90},
            "scale_min": {"ctx": {"mode": "random", "area_x": 200, "area_y": 120}, "value": 40}, "scale_max": {"ctx": {"mode": "random", "area_x": 200, "area_y": 120}, "value": 180},
            "spin": {"ctx": {"mode": "random", "area_x": 200, "area_y": 120}, "value": 600}, "drift_x": {"ctx": {"mode": "random", "area_x": 200, "area_y": 120}, "value": 400},
            "drift_y": {"ctx": {"mode": "random", "area_x": 200, "area_y": 120}, "value": 400},
            "copy_scale": {"ctx": {"mode": "circle", "radius": 60}, "value": 50}, "copy_rotation": {"ctx": {"mode": "circle", "radius": 60}, "value": 40}}},
        "lightleak": {"base": {"radius": 80, "stretch": 3}},
        "gradient_overlay": {"per": {"cx": {"ctx": {"angle": 90}}, "width": {"value": 60}}},
        "overlay_source": {"base": {"url": ov_url}, "skip": {"asset_id": A}, "per": {
            "tile": {"ctx": {"scale": 40}}, "anchor": {"ctx": {"scale": 40}, "value": "top_left"}, "start": {"ctx": {"url": None, "comp_id": 9001, "scale": 20}, "value": 40}, "speed": {"ctx": {"url": None, "comp_id": 9001, "scale": 20}, "value": 3}}},
        "trace_outline": {"per": {"start": {"ctx": {"progress": 50}, "value": 30}, "dash_period": {"ctx": {"dash_gap": 5}, "value": 20}, "dash_gap": {"ctx": {"dash_period": 20}, "value": 10}}},
        "halftone": {"per": {"self_mask": {"ctx": {"bg": "#ffffff"}}}},
        "mirror": {"per": {"cy": {"ctx": {"angle": 30}}}},
        "glow": {"base": {"threshold": 20}},
        "wave": {"per": {"speed": {"value": 2.3}}},
        "raster": {"per": {"speed": {"value": 2.3}}},
    }


# レイヤーの source の項目: その項目が効く前提(kind など)。ここに書いた項目は、動かして絵が変わらなければ NG
SRC_CTX = {
    "pattern": {
        "stagger": {"kind": "dots"}, "slope": {"kind": "yagasuri"}, "rings": {"kind": "seigaiha"}, "count": {"kind": "rays"}, "jitter": {"kind": "rays"}, "inner": {"kind": "rays"},
        "amplitude": {"kind": "waves"}, "wavelength": {"kind": "waves"}, "contrast": {"kind": "noise"}, "seed": {"kind": "noise"},
        "grad_angle": {"kind": "halftone", "grad_length": 200}, "grad_length": {"kind": "halftone"}, "dot_min": {"kind": "halftone", "grad_length": 200}, "dot_max": {"kind": "halftone", "grad_length": 200},
        "line_width": {"kind": "grid"}, "ratio": {"kind": "stripes"}, "cols": {"kind": "checker", "size": 30, "rows": 3}, "rows": {"kind": "checker", "size": 30, "cols": 5}, "origin": {"kind": "checker", "size": 50, "width": 175, "height": 125},
    },
    "shape": {
        "sides": {"kind": "polygon"}, "inner": {"kind": "star"}, "start": {"kind": "arc", "stroke": "#ffffff", "stroke_width": 8, "width": 120, "height": 120}, "end": {"kind": "arc", "stroke": "#ffffff", "stroke_width": 8, "width": 120, "height": 120, "_value": 200},
        "thickness": {"kind": "cross"}, "head": {"kind": "arrow"}, "shaft": {"kind": "arrow"}, "petals": {"kind": "flower"}, "jitter": {"kind": "burst"}, "seed": {"kind": "burst", "jitter": 0.5},
        "stroke_width": {"stroke": "#ffffff"}, "join": {"kind": "star", "stroke": "#ffffff", "stroke_width": 14}, "cap": {"kind": "line", "stroke": "#ffffff", "stroke_width": 20, "fill": None},
        "trim": {"stroke": "#ffffff", "stroke_width": 8, "width": 120, "height": 100, "_value": [0, 40]},
        "trim_offset": {"stroke": "#ffffff", "stroke_width": 8, "trim": [0, 50], "width": 120, "height": 100, "_value": 30},
        "dash_offset": {"stroke": "#ffffff", "stroke_width": 8, "dash": [20, 12], "width": 120, "height": 100, "_value": 9},
        "radius": {"kind": "rect", "width": 120, "height": 100, "_value": 30}, "height": {"kind": "rect", "width": 120, "_value": 60},
        "closed": {"kind": "path", "points": [[-60, -40], [60, -40], [0, 50]], "fill": None, "stroke": "#ffffff", "stroke_width": 6},
        "morph": {"kind": "path", "points": [[-60, -40], [60, -40], [0, 50]], "morph_to": [[-20, -60], [70, 10], [-50, 40]], "_value": 60},
    },
    "text": {
        "weight": {"_value": 300}, "align": {"text": "あいうえお\nAB"}, "wrap_width": {"text": "あいうえおかきくけこさしすせそ", "size": 30, "_value": 100}, "stroke_width": {"stroke": "#ff0000"}, "stroke_over": {"stroke": "#ff0000", "stroke_width": 8},
        "vertical_latin": {"writing": "vertical", "text": "あA1"}, "leading": {"text": "あい\nうえ"}, "tracking": {"text": "あいう"},
    },
}


# 既定の source では画面に映らない種類は、映る土台から始める(その種類の項目はぜんぶ「変わらなければ NG」)
SRC_BASE = {
    "particles": {"seed": 1, "emitter": {"position": [0, 0, 0], "emit": "box", "area": [200, 100, 0], "rate": 80, "life": 1.5, "speed": 40, "sprite": "petal", "blend": "normal", "size": [16, 6], "spread": 360}},
}
SRC_CTX["particles"] = {
    "emitter.burst": {"_value": 60}, "emitter.life_random": {"_value": 0.8}, "emitter.speed_random": {"_value": 0.9}, "emitter.direction": {"emitter.spread": 30},
    "emitter.gravity": {"_value": [0, 300, 0]}, "emitter.wind": {"_value": [200, 0, 0]}, "emitter.drag": {"_value": 3}, "emitter.spin": {"_value": 200}, "emitter.flutter": {"_value": 300},
    "emitter.z_speed": {"_value": 400, "_three_d": True}, "emitter.size": {"_value": [30, 2]}, "emitter.opacity": {"_value": [40, 100]}, "emitter.size_random": {"_value": 0.9},
    "emitter.area": {"_value": [60, 160, 0]}, "emitter.position": {"_value": [60, 30, 0]}, "emitter.preset": {"_value": "confetti"}, "emitter.sprite": {"_value": "heart"}, "emitter.blend": {"_value": "add"},
}

# mesh(手続きの 3D): source 直下の項目は、光・影・映り込みが見える土台から動かす
SRC_BASE["mesh"] = {"light": {"shadows": True, "shadow_area": 600}, "objects": [
    {"geometry": "sphere", "radius": 45, "position": [-60, -10, 0], "material": {"color": "#d4af37", "metalness": 1, "roughness": 0.2}},
    {"geometry": "box", "size": [60, 60, 60], "position": [60, -10, 0], "rotation": [20, 30, 0], "material": {"color": "#4f9dff"}},
    {"geometry": "plane", "size": [400, 300], "position": [0, 40, 0], "rotation": [80, 0, 0], "material": {"color": "#cccccc"}}]}
SRC_CTX["mesh"] = {"light.direction": {"_value": [0.8, -1, -0.3]}}

# mesh の objects の 1 件の項目: 土台の箱(MESH_OBJ)に前提を重ねてから、その項目を動かす。どの項目も、絵が変わらなければ NG
#   キー = 項目の道(material.color など)。値の中の _ つきは指示: _value = 動かす先 / _extra = いっしょに置くオブジェクト / _source = source に重ねる値
MESH_OBJ = {"geometry": "box", "size": [90, 70, 60], "rotation": [25, 35, 0], "material": {"color": "#d08040", "roughness": 0.4}}
_HELIX = {"type": "helix", "radius": 50, "turns": 2, "height": 80}
_PTS = {"type": "points", "points": [[-60, 20, 0], [-10, -40, 30], [60, 10, -20]]}
_SH = {"geometry": "shards", "size": [160, 100], "count": 30, "progress": 0.5, "spread": 40, "rotation": [0, 0, 0]}
_IN = {"geometry": "box", "size": [14, 10, 6], "rotation": [0, 0, 0], "instances": {"count": 40, "seed": 1, "layout": "box", "area": [240, 130, 60]}}
def _g(geo, **kw): return {"geometry": geo, **kw}
def _sh(**kw): return {**_SH, **kw}
def _in(_value=None, **inst):
    d = {**_IN, "instances": {**_IN["instances"], **inst}}
    if _value is not None: d["_value"] = _value
    return d
def _path(pd, **kw): return {"geometry": "tube", "tube": 5, "path": pd, **kw}
def _mat(**kw): return {"material": {"color": "#d08040", "roughness": 0.4, **kw}}
def mesh_ctx(tex_a, tex_b):
    """tex_a = 透明な所のある絵、tex_b = 別の絵(どちらも data URL)"""
    texm = lambda **kw: {"geometry": "plane", "size": [150, 110], "rotation": [0, 0, 0], "material": {"type": "basic", "texture": {"url": tex_a}, **kw}}  # noqa: E731
    compm = lambda **kw: {"geometry": "plane", "size": [240, 135], "rotation": [0, 0, 0], "material": {"type": "basic", "texture": {"comp_id": 9001, **kw}}}  # noqa: E731
    floor = {"geometry": "plane", "size": [300, 300], "position": [0, 50, 0], "rotation": [80, 0, 0], "material": {"color": "#cccccc"}}
    ctx = {
        "geometry": {"_value": "sphere"}, "position": {}, "rotation": {}, "scale": {"_value": [1.3, 0.7, 1]}, "visible": {}, "size": {},
        "radius": _g("sphere"), "radius_top": _g("cylinder", _value=30), "radius_bottom": _g("cylinder", _value=30), "height": _g("cylinder", _value=90), "open_ended": _g("cylinder", rotation=[60, 0, 0]),
        "tube": _g("torus", radius=50), "inner": _g("ring"), "outer": _g("ring", _value=80), "arc": _g("torus", radius=50, _value=200), "start": _g("ring", arc=200),
        "detail": _g("icosahedron", radius=60, _value=2), "segments": _g("sphere", radius=60, _value=5), "radial_segments": _g("torus", radius=50, _value=3),
        "profile": _g("lathe", _value=[[0, -40], [50, 0], [0, 40]]), "smooth": _g("lathe", profile=[[0, -40], [40, -10], [20, 30], [0, 40]], _value=6),
        "shape": _g("extrude", size=[90, 90], _value="heart"), "shape_sides": _g("extrude", size=[90, 90], shape="polygon", _value=3), "shape_inner": _g("extrude", size=[90, 90], shape="star", _value=0.8),
        "shape_radius": _g("extrude", size=[90, 90], shape="rect", _value=30), "points": _g("extrude", _value=[[-40, -30], [40, -30], [0, 40]]),
        "holes": _g("extrude", points=[[-45, -45], [45, -45], [45, 45], [-45, 45]], _value=[[[-15, -15], [15, -15], [15, 15], [-15, 15]]]),
        "depth": _g("extrude", size=[90, 90]), "bevel.size": _g("extrude", size=[90, 90], bevel={"size": 6, "segments": 3}, _value=12), "bevel.thickness": _g("extrude", size=[90, 90], bevel={"size": 6}, _value=14),
        "bevel.segments": _g("extrude", size=[90, 90], bevel={"size": 8, "segments": 3}, _value=1), "bevel.offset": _g("extrude", size=[90, 90], bevel={"size": 6}, _value=-5),
        "smooth_angle": _g("extrude", size=[90, 90], shape="ellipse", _value=0),
        "text": _g("text", font_size=70, text="あA", _value="愛"), "font": _g("text", font_size=70, text="あA", _value="Noto Serif JP"), "weight": _g("text", font_size=70, text="あA", _value=300), "italic": _g("text", font_size=70, text="あA"),
        "font_size": _g("text", font_size=70, text="あA", _value=50), "tracking": _g("text", font_size=60, text="あA", _value=20), "leading": _g("text", font_size=45, text="あ\nA", _value=1.6), "align": _g("text", font_size=45, text="ああ\nA", _value="left"),
        "path.type": _path(_HELIX, _value="circle"), "path.radius": _path(_HELIX, _value=30), "path.radius_end": _path(_HELIX, _value=10), "path.turns": _path(_HELIX, _value=3.5), "path.height": _path(_HELIX, _value=30),
        "path.axis": _path(_HELIX, _value="x"), "path.start": _path(_HELIX), "path.arc": _path({"type": "circle", "radius": 50}, _value=200),
        "path.from": _path({"type": "line"}, _value=[-60, 30, 0]), "path.to": _path({"type": "line"}, _value=[60, 30, 0]),
        "path.points": _path(_PTS, _value=[[-60, 0, 0], [0, 40, 0], [60, 0, 0]]), "path.closed": _path(_PTS), "path.curve": _path(_PTS, _value="linear"), "path.tension": _path(_PTS, _value=0),
        "count": _sh(_value=60), "seed": _sh(), "cut": _sh(_value="triangles"), "jitter": _sh(_value=0), "progress": _sh(_value=0.8), "stagger": _sh(_value="left_to_right"), "stagger_amount": _sh(stagger="left_to_right", _value=0.1),
        "direction": _sh(_value=[30, 10, 0]), "spread": _sh(_value=90), "spread_z": _sh(_value=300), "origin": _sh(_value=[60, 30]), "spin": _sh(_value=20), "gravity": _sh(_value=[0, 40, 0]), "scale_end": _sh(_value=0.3), "fade": _sh(_value=0.8),
        "material.type": {"_value": "basic"}, "material.color": {}, "material.opacity": {"_value": 0.5}, "material.metalness": {"_value": 1}, "material.roughness": {**_mat(metalness=1), "_value": 0.05},
        "material.emissive": {"_value": "#404000"}, "material.emissive_intensity": {**_mat(emissive="#303030"), "_value": 3}, "material.env_intensity": {**_mat(metalness=1), "_value": 3}, "material.clearcoat": {"_value": 1},
        "material.side": _g("plane", size=[120, 90], rotation=[0, 150, 0], _value="front"), "material.flat": _g("sphere", radius=60, segments=8), "material.wireframe": {},
        "material.transparent": texm(), "material.alpha_test": {**texm(), "_value": 0.5}, "material.toon_steps": {**_g("sphere", radius=60), **_mat(type="toon"), "_value": 8},
        "material.texture.url": {**texm(), "_value": tex_b}, "material.texture.comp_id": {**texm(), "_value": 9001},
        "material.texture.frame": {**compm(), "_value": 100}, "material.texture.start": {**compm(), "_value": 60}, "material.texture.speed": {**compm(), "_value": 4}, "material.texture.loop": compm(start=200), "material.texture.transparent": compm(),
        "material.texture_repeat": {**texm(), "_value": [2, 3]}, "material.texture_offset": {**texm(), "_value": [0.3, 0.2]},
        "instances.count": _in(80), "instances.seed": _in(), "instances.layout": _in("sphere"), "instances.area": _in([120, 160, 60]), "instances.grid": _in([4, 3, 2], layout="grid", spacing=[40, 30, 20]), "instances.spacing": _in([40, 30, 20], layout="grid"),
        "instances.radius": _in(40, layout="ring", radius=70), "instances.surface": _in(layout="sphere", radius=80), "instances.axis": _in("z", layout="ring", radius=70), "instances.start": _in(layout="ring", radius=70, arc=180),
        "instances.arc": _in(200, layout="ring", radius=70), "instances.offset": _in(0.01, layout="ring", radius=70), "instances.align": _in(layout="ring", radius=70),
        "instances.scale": _in([0.4, 2]), "instances.rotation": _in([30, 40, 50]), "instances.rotation_random": _in([90, 90, 90]), "instances.velocity": _in([60, 20, 0]), "instances.velocity_random": _in([80, 80, 0]),
        "instances.radial": _in([40, 90]), "instances.gravity": _in([0, 200, 0]), "instances.drag": _in(3, velocity=[150, 0, 0]), "instances.spin": _in([90, 120, 60]), "instances.spin_random": _in([200, 200, 200]),
        "instances.sway.amp": _in([0, 40, 0], sway={"amp": [30, 0, 0], "freq": 0.5}), "instances.sway.freq": _in(1.3, sway={"amp": [30, 0, 0], "freq": 0.5}),
        "instances.lifetime": _in(0.4, emit_duration=0.5), "instances.lifetime_random": _in(0.9, lifetime=1), "instances.loop": _in(lifetime=1, velocity=[100, 0, 0]), "instances.prewarm": _in(lifetime=1, loop=True),
        "instances.emit_duration": _in(0.9, velocity=[100, 0, 0]), "instances.colors": _in(["#102030", "#f0c812", "#ff00aa"]), "instances.fade_in": _in(2), "instances.fade_out": _in(0.8, lifetime=1),
        "instances.fade_mode": _in("scale", fade_in=2), "instances.time_offset": _in(1, velocity=[60, 20, 0]),
        "cast_shadow": {"position": [0, -20, 0], "_extra": [floor], "_source": {"light": {"shadows": True, "shadow_area": 500}}},
        "receive_shadow": {**floor, "_extra": [{"geometry": "sphere", "radius": 30, "position": [0, -30, 0]}], "_source": {"light": {"shadows": True, "shadow_area": 500}}},
        "render_order": {"geometry": "plane", "size": [120, 90], "rotation": [0, 0, 0], "material": {"color": "#ff2020", "opacity": 0.5}, "_value": 5,
                         "_extra": [{"geometry": "plane", "size": [90, 120], "position": [20, 0, -30], "material": {"color": "#2040ff", "opacity": 0.5}}]},
    }
    # 複製の道(instances.path.*)は、オブジェクトの path.* と同じ前提を複製の along に移して確かめる
    for k in [k for k in ctx if k.startswith("path.")]:
        c = ctx[k]
        ctx["instances." + k] = {"geometry": "box", "size": [12, 8, 20], "rotation": [25, 35, 0], "instances": {"count": 30, "layout": "along", "path": c["path"]}, **({"_value": c["_value"]} if "_value" in c else {})}
    return ctx


def flat_fields(fields, prefix=""):
    """object 型の中まで開いた (道, 説明) の列。list 型はそのまま返す"""
    for k, d in fields.items():
        if d.get("type") == "object" and d.get("fields"):
            yield from flat_fields(d["fields"], prefix + k + ".")
        else:
            yield prefix + k, d


# レイヤー共通の項目: 効き目が見える前提。set = 先に書いておく道、value = 動かす先、frame = 描くコマ、matte = マット元のレイヤーを足す
MOVE = {"k": [{"f": 0, "v": [60, 90]}, {"f": 40, "v": [260, 90]}]}
def _tr(side, type_, **kw):
    return {"set": {f"{side}.type": type_, f"{side}.duration": 20}, "frame": 6 if side == "transition_in" else 52, **kw}
COMMON_CTX = {
    "transform.position": {"cur": True, "value": [200, 70, 0]}, "transform.rotation": {"cur": True, "value": [0, 0, 30]}, "transform.anchor": {"cur": True}, "transform.scale": {"cur": True, "value": [60, 140, 100]},
    "transform.opacity": {"cur": True, "value": 40},
    "posterize_time": {"set": {"transform.position": MOVE}, "value": 4, "frame": 7},
    "motion_blur": {"set": {"transform.position": MOVE}, "frame": 7},
    "matte.mode": {"matte": True, "value": "alpha_inv"}, "matte.keep_source": {"matte": True},
    "repeater.order": {"set": {"repeater.count": 3, "repeater.offset.position": [30, 10, 0]}},
    "repeater.radial.radius": {"set": {"repeater.count": 5, "repeater.mode": "radial", "transform.scale": [30, 30]}, "value": 50},
    "repeater.radial.start_angle": {"set": {"repeater.count": 5, "repeater.mode": "radial", "repeater.radial.radius": 50, "transform.scale": [30, 30]}},
    "repeater.radial.sweep": {"set": {"repeater.count": 5, "repeater.mode": "radial", "repeater.radial.radius": 50, "transform.scale": [30, 30]}, "value": 150},
    "repeater.radial.face_center": {"set": {"repeater.count": 5, "repeater.mode": "radial", "repeater.radial.radius": 50, "transform.scale": [30, 30]}},
    "repeater.random.area": {"set": {"repeater.count": 6, "repeater.mode": "random", "transform.scale": [30, 30]}, "value": [120, 60, 0]},
    "repeater.random.seed": {"set": {"repeater.count": 6, "repeater.mode": "random", "repeater.random.area": [200, 100, 0], "transform.scale": [30, 30]}},
    "repeater.random.rotation": {"set": {"repeater.count": 6, "repeater.mode": "random", "repeater.random.area": [200, 100, 0], "transform.scale": [30, 30]}, "value": 90},
    "repeater.random.scale_range": {"set": {"repeater.count": 6, "repeater.mode": "random", "repeater.random.area": [200, 100, 0], "transform.scale": [30, 30]}, "value": [40, 200]},
}
for _side in ("transition_in", "transition_out"):
    COMMON_CTX.update({
        f"{_side}.type": _tr(_side, "fade", value="zoom"), f"{_side}.duration": _tr(_side, "fade", value=45), f"{_side}.e": _tr(_side, "fade", value="linear"),
        f"{_side}.direction": _tr(_side, "slide", value="up"), f"{_side}.distance": _tr(_side, "slide", value=90),
        f"{_side}.angle": _tr(_side, "wipe"), f"{_side}.feather": _tr(_side, "wipe", value=30), f"{_side}.pitch": _tr(_side, "blinds", value=17),
        f"{_side}.shape": _tr(_side, "iris", value="rect"), f"{_side}.from": _tr(_side, "zoom", value=250), f"{_side}.radius": _tr(_side, "blur", value=4), f"{_side}.side": _tr(_side, "clip", value="left"),
    })


def get_path(obj, path):
    for k in path.split("."):
        if not isinstance(obj, dict) or k not in obj:
            return None
        obj = obj[k]
    return obj


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

        # ---- effects: 既定値で描けるか + 全項目が効くか ----
        mask_url, ov_url = test_images()
        FIX = fx_fixtures(mask_url, ov_url)
        plain = await draw(comp([base_layer()]), "base")
        dead, skipped, nparam = [], [], 0
        for et, ed in schema["effects"].items():
            fixt = FIX.get(et, {})
            defaults = {k: d["default"] for k, d in ed["params"].items() if d.get("default") is not None}
            r0 = await draw(comp([base_layer([{"type": et, "params": defaults}])]), f"effect {et}")
            if r0["sum"] == 0 and et not in ("opacity",):
                fails.append((f"effect {et}", ["既定値で何も映らない"]))

            def lay(params):
                L = base_layer([{"type": et, "params": {k: v for k, v in params.items() if v is not None}}])
                for path, val in (fixt.get("layer") or {}).items():
                    set_path(L, path, val)
                return L
            for k, d in ed["params"].items():
                if k in (fixt.get("skip") or {}):
                    skipped.append(f"{et}.{k}: {fixt['skip'][k]}")
                    continue
                nparam += 1
                per = (fixt.get("per") or {}).get(k, {})
                p0 = {**defaults, **(fixt.get("base") or {}), **(per.get("ctx") or {})}
                v = per["value"] if "value" in per else other_from(d, p0.get(k, d.get("default")))
                if v is None or v == p0.get(k):
                    fails.append((f"effect {et}.{k}", ["動かす先の値を作れない(FX_FIXTURE に value を書く)"]))
                    continue
                ra = await draw(comp([lay(p0)]), f"effect {et}.{k} 前")
                rb = await draw(comp([lay({**p0, k: v})]), f"effect {et}.{k} 後")
                if ra["sum"] == 0:
                    fails.append((f"effect {et}.{k}", ["下ごしらえの絵に何も映っていない"]))
                if ra["hash"] == rb["hash"]:
                    dead.append(f"{et}.{k}({json.dumps(p0.get(k), ensure_ascii=False)} → {json.dumps(v, ensure_ascii=False)})")
        for x in dead:
            fails.append((f"effect {x}", ["値を動かしても絵が変わらない(死んだ項目)"]))
        print(f"effects: {len(schema['effects'])} 種・{nparam} 項目を動かして確かめた。効かない項目 {len(dead)}、比べなかった項目 {len(skipped)}")
        for x in skipped:
            print("    (比べない)", x)
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
                ctx = SRC_CTX.get(lt, {}).get(k)
                if ctx is None and lt in SRC_BASE:
                    ctx = {}
                if ctx is not None:
                    # 前提つき: その項目が効く形(kind など)にしてから動かす。変わらなければ NG
                    if lt in SRC_BASE:
                        l2["source"] = copy.deepcopy(SRC_BASE[lt])
                    for ck, cv in ctx.items():
                        if ck == "_three_d":
                            l2["three_d"] = True
                        elif not ck.startswith("_"):
                            set_path(l2["source"], ck, cv)
                    cur = get_path(l2["source"], k)
                    if cur is None:
                        cur = d["default"]
                        set_path(l2["source"], k, cur)
                    v = ctx["_value"] if "_value" in ctx else other_from(d, cur)
                    r0 = await draw(comp([l2] + others), f"layer {lt}.source.{k} 前")
                    if r0["sum"] == 0:
                        fails.append((f"layer {lt}.source.{k}", ["下ごしらえの絵に何も映っていない"]))
                if v is not None and lt not in ("camera", "null", "group", "model", "image", "video", "sequence", "comp", "adjustment"):
                    l3 = copy.deepcopy(l2)
                    set_path(l3["source"], k, v)
                    r1 = await draw(comp([l3] + others), f"layer {lt}.source.{k}*")
                    if r1["hash"] == r0["hash"]:
                        if ctx is not None:
                            fails.append((f"layer {lt}.source.{k}", [f"値を動かしても絵が変わらない({json.dumps(v, ensure_ascii=False)})"]))
                        else:
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

        # ---- mesh の objects・点の光(一覧の中の項目)。source 直下と同じく、動かして絵が変わらなければ NG ----
        mesh_src = schema["layer_types"]["mesh"]["source"]
        MCTX = mesh_ctx(mask_url, ov_url)
        nmesh = 0

        def mesh_comp(obj, extra=(), source=None):
            src = {"objects": [obj, *extra]}
            for sk, sv in (source or {}).items():
                src[sk] = copy.deepcopy(sv)
            return comp([{"id": "m", "type": "mesh", "in": 0, "out": 60, "transform": {"position": [W / 2, H / 2]}, "source": src}], bg="#203040")
        for k, d in flat_fields(mesh_src["objects"]["item"]):
            if "asset" in d and k != "material.texture.comp_id":
                continue
            if k == "faces":
                # 面ごとのマテリアル: 箱の手前の面だけ色を替える
                o = copy.deepcopy(MESH_OBJ)
                r0 = await draw(mesh_comp(o), "mesh objects.faces 前")
                o["faces"] = [None, None, None, None, {"color": "#12c8f0"}, None]
                r1 = await draw(mesh_comp(o), "mesh objects.faces 後")
                nmesh += 1
                if r0["hash"] == r1["hash"]:
                    fails.append(("mesh objects.faces", ["面ごとのマテリアルを書いても絵が変わらない"]))
                continue
            c = MCTX.get(k)
            if c is None:
                fails.append((f"mesh objects.{k}", ["前提が無い(schema_test.py の mesh_ctx に足す)"]))
                continue
            o = copy.deepcopy(MESH_OBJ)
            for ck, cv in c.items():
                if not ck.startswith("_"):
                    set_path(o, ck, copy.deepcopy(cv)) if "." in ck else o.__setitem__(ck, copy.deepcopy(cv))
            cur = get_path(o, k)
            if cur is None and d.get("default") is not None:
                cur = d["default"]
                set_path(o, k, copy.deepcopy(cur))
            v = c["_value"] if "_value" in c else other_from(d, cur)
            if v is None or v == cur:
                fails.append((f"mesh objects.{k}", ["動かす先の値を作れない(mesh_ctx に _value を書く)"]))
                continue
            nmesh += 1
            r0 = await draw(mesh_comp(o, c.get("_extra", ()), c.get("_source")), f"mesh objects.{k} 前")
            if r0["sum"] == 0:
                fails.append((f"mesh objects.{k}", ["下ごしらえの絵に何も映っていない"]))
            o2 = copy.deepcopy(o)
            set_path(o2, k, v)
            r1 = await draw(mesh_comp(o2, c.get("_extra", ()), c.get("_source")), f"mesh objects.{k} 後")
            if r0["hash"] == r1["hash"]:
                fails.append((f"mesh objects.{k}", [f"値を動かしても絵が変わらない({json.dumps(cur, ensure_ascii=False)[:60]} → {json.dumps(v, ensure_ascii=False)[:60]})"]))
        # 知らない道を前提に書いていないか(項目の名前を変えたときの消し忘れ)
        known = {k for k, _ in flat_fields(mesh_src["objects"]["item"])}
        for k in MCTX:
            if k not in known:
                fails.append((f"mesh objects.{k}", ["schema に無い項目の前提が残っている"]))
        # 点の光・影の範囲
        ball = {"geometry": "sphere", "radius": 60, "material": {"color": "#cccccc"}}
        pl0 = {"position": [-100, -60, -80], "color": "#ff4040", "intensity": 2, "distance": 0}
        for k, d in mesh_src["light.points"]["item"].items():
            v = {"distance": 110, "position": [120, 40, -80]}.get(k, other_from(d, pl0[k]))
            r0 = await draw(mesh_comp(ball, source={"light": {"points": [pl0]}}), f"mesh light.points.{k} 前")
            r1 = await draw(mesh_comp(ball, source={"light": {"points": [{**pl0, k: v}]}}), f"mesh light.points.{k} 後")
            nmesh += 1
            if r0["hash"] == r1["hash"]:
                fails.append((f"mesh light.points.{k}", [f"値を動かしても絵が変わらない({v})"]))
        sb = copy.deepcopy(SRC_BASE["mesh"])
        r0 = await draw(comp([{"id": "m", "type": "mesh", "in": 0, "out": 60, "transform": {"position": [W / 2, H / 2]}, "source": sb}]), "mesh light.shadow_area 前")
        sb["light"]["shadow_area"] = 250
        r1 = await draw(comp([{"id": "m", "type": "mesh", "in": 0, "out": 60, "transform": {"position": [W / 2, H / 2]}, "source": sb}]), "mesh light.shadow_area 後")
        nmesh += 1
        if r0["hash"] == r1["hash"]:
            fails.append(("mesh light.shadow_area", ["値を動かしても絵が変わらない"]))
        for o in mesh_src["objects"]["item"]["geometry"]["options"]:
            ob = {"geometry": o["value"], "rotation": [25, 35, 0], "material": {"color": "#d08040"}}
            if o["value"] == "group":
                ob["children"] = [{"geometry": "box", "size": [60, 60, 60]}]
            elif o["value"] == "shards":
                ob["size"] = [200, 120]
            r = await draw(mesh_comp(ob), f"mesh geometry {o['value']}")
            if r["sum"] == 0:
                fails.append((f"mesh geometry {o['value']}", ["既定値で何も映らない"]))
        for o in mesh_src["objects"]["item"]["shape"]["options"]:
            r = await draw(mesh_comp({"geometry": "extrude", "shape": o["value"], "size": [100, 100], "rotation": [20, 30, 0]}), f"mesh shape {o['value']}")
            if r["sum"] == 0:
                fails.append((f"mesh shape {o['value']}", ["何も映らない"]))
        print(f"mesh: objects・点の光の {nmesh} 項目を動かして確かめた")

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
            cc = COMMON_CTX.get(k) if types == ["shape"] else None
            fr = (cc or {}).get("frame", 3)
            if cc:
                for ck, cv in (cc.get("set") or {}).items():
                    set_path(lay, ck, cv)
                if cc.get("matte"):
                    set_path(lay, "matte.layer", "mt")
            if not (cc and (cc.get("cur") or get_path(lay, k) is not None)):
                set_path(lay, k, dv)
            mt = [{"id": "mt", "type": "shape", "in": 0, "out": 60, "transform": {"position": [130, 80]}, "source": {"kind": "ellipse", "width": 120, "height": 90, "fill": "#ffffff"}}] if cc and cc.get("matte") else []
            layers = [lay] + mt + ([base_layer(id="u")] if lay["type"] in ("group", "camera", "adjustment") else [])
            r0 = await draw(comp(layers, bg="#203040"), f"common {k}", f=fr)
            v = cc["value"] if cc and "value" in cc else other_from(d, get_path(lay, k))
            if v is not None and types == ["shape"] and k not in ("visible", "locked", "solo", "guide", "in", "out", "double_sided", "billboard"):
                l2 = copy.deepcopy(lay)
                set_path(l2, k, v)
                r1 = await draw(comp([l2] + mt, bg="#203040"), f"common {k}*", f=fr)
                if r1["hash"] == r0["hash"]:
                    if cc:
                        fails.append((f"common {k}", [f"値を動かしても絵が変わらない({json.dumps(v, ensure_ascii=False)})"]))
                    else:
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
