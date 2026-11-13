"""C: 新しく 1 カット作ってみる(衣装紹介のカード 3 枚)。API だけで作り、数コマ見る。"""
import json, sys, urllib.request
BASE = "http://127.0.0.1:8002"; PID = 35; NAME = "試作: 衣装紹介カット"
def call(m, path, body=None):
    r = urllib.request.Request(BASE + path, method=m, data=json.dumps(body).encode() if body is not None else None, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r) as x:
        raw = x.read(); return json.loads(raw) if x.headers.get("content-type", "").startswith("application/json") else raw
D = 144
PINK, DEEP, CREAM, TEAL, INK = "#f08a97", "#b8324a", "#fbf3ea", "#5fb7bf", "#2b2230"
def K(*pts, e=None):  # (f, v) の列
    ks = [{"f": f, "v": v} for f, v in pts]
    if e: ks[0]["e"] = e
    return {"k": ks}
layers = []
# 花びら(最前面)
layers.append({"id": "petals", "type": "particles", "in": -60, "out": D, "transform": {"position": [960, 540]},
               "source": {"seed": 11, "emitter": {"preset": "petals", "position": [0, -640, 0], "area": [2200, 60, 0], "rate": 9, "life": 6, "size": [36, 36], "wind": [70, 0, 0], "sway": {"amp": 50, "freq": 0.4}, "colors": ["#ffd9e4", "#ffb7cd", "#fff0f4"]}}})
# 題・日付・説明
layers.append({"id": "date", "type": "text", "in": 6, "out": D, "transform": {"position": [1500, 110]},
               "source": {"font": "Noto Sans JP", "weight": 300, "size": 54, "fill": INK, "tracking": 8,
                          "counter": {"value": K((6, 201211110000), (70, 202611111111), e="outExpo"), "format": "####.##.##.##:##", "fixed_width": True, "scramble": K((6, 100), (72, 0))},
                          "plate": {"color": "#ffffff", "opacity": 85, "padding": [40, 10]}},
               "transition_in": {"type": "slide", "direction": "right", "distance": 500, "duration": 16, "e": "outCirc"}})
layers.append({"id": "name", "type": "text", "in": 14, "out": D, "transform": {"position": [170, 500]},
               "source": {"text": "佐倉杏子", "writing": "vertical", "font": "Noto Serif CJK JP", "weight": 700, "size": 96, "fill": INK,
                          "plate": {"color": "#ffffff", "padding": [22, 30], "stroke": DEEP, "stroke_width": 4}},
               "effects": [{"type": "clip_line", "params": {"angle": 0, "cy": K((14, -330), (40, 330), e="inOutExpo")}}]})
layers.append({"id": "title", "type": "text", "in": 20, "out": D, "transform": {"position": [1010, 985]},
               "source": {"text": "WARDROBE 2026", "font": "Noto Sans JP", "weight": 900, "size": 92, "fill": "#ffffff", "stroke": DEEP, "stroke_width": 5, "tracking": 10,
                          "per_char": {"stagger": 2, "duration": 16, "order": "forward", "e": "outBack", "from": {"position": [0, 120, 0], "scale": [40, 40], "rotation": -15, "opacity": 0}}}})
# 衣装カード 3 枚(白地の設定画を角丸で切り、白フチと影。時間差で下から入る)
cards = [(6664, "A", 560, -5), (6050, "B", 960, 3), (6397, "C", 1360, -3)]
for i, (aid, tag, x, rot) in enumerate(cards):
    t0 = 26 + i * 9
    layers.append({"id": f"tag{tag}", "type": "text", "in": t0 + 10, "out": D, "transform": {"position": [x + 205, 232 + (i % 2) * 30], "rotation": rot},
                   "source": {"text": f"衣装 {tag}", "font": "Noto Sans JP", "weight": 700, "size": 44, "fill": "#ffffff", "plate": {"color": DEEP, "padding": [22, 8], "radius": 8}},
                   "transition_in": {"type": "zoom", "from": 0, "duration": 10, "e": "outBack"}})
    layers.append({"id": f"card{tag}", "type": "image", "in": t0, "out": D, "source": {"asset_id": aid},
                   "transform": {"position": [x + 60, 520 + (i % 2) * 30], "scale": [42, 42], "rotation": {"v": rot, "wiggle": {"freq": 0.5, "amp": 0.8, "seed": i + 1}}},
                   "effects": [{"type": "mask_shape", "params": {"shape": "rounded_rect", "width": 900, "height": 1440, "radius": 60}},
                               {"type": "stroke_outline", "params": {"width": 18, "color": "#ffffff"}},
                               {"type": "drop_shadow", "params": {"distance": 26, "angle": 135, "blur": 0, "color": DEEP, "opacity": 70}},
                               {"type": "offset", "params": {"position": K((t0, [0, 900, 0]), (t0 + 20, [0, 0, 0]), e="outCirc")}}]})
# 斜めの帯(画面より大きい板を帯に切る。流れ込む)
for j, (col, cx0, w, t) in enumerate([(DEEP, -420, 150, 0), (TEAL, -150, 60, 4), ("#ffffff", 380, 90, 8)]):
    layers.append({"id": f"band{j}", "type": "solid", "in": t, "out": D, "transform": {"position": [960, 540]}, "source": {"color": col, "width": 2600, "height": 2600},
                   "effects": [{"type": "clip_line", "params": {"angle": 62, "width": w, "cx": cx0, "cy": 0}},
                               {"type": "offset", "params": {"position": K((t, [0, -2200, 0]), (t + 22, [0, 0, 0]), e="outExpo")}}],
                   "transform_note": "帯"})
# 背景: 麻の葉がゆっくり流れる
layers.append({"id": "pat", "type": "pattern", "in": 0, "out": D, "source": {"kind": "asanoha", "colors": [CREAM, "#f6c9cf"], "size": 120, "line_width": 3, "offset": K((0, [0, 0]), (D, [-120, 60]))}})
doc = {"version": 1, "bg": CREAM, "layers": layers}
ex = [c for c in call("GET", f"/api/comps/?project_id={PID}") if c["name"] == NAME]
if ex: comp = call("PATCH", f"/api/comps/{ex[0]['id']}", {"data": doc, "duration_frames": D})
else: comp = call("POST", "/api/comps/", {"project_id": PID, "name": NAME, "width": 1920, "height": 1080, "fps": 24, "duration_frames": D, "data": doc})
cid = comp["id"]; print("comp", cid, "rev", comp["rev"])
from PIL import Image; import io
fr = [int(a) for a in sys.argv[1:]] or [8, 30, 50, 75, 110, 140]
ims = [Image.open(io.BytesIO(call("GET", f"/api/comps/{cid}/thumb?frame={f}&width=640"))) for f in fr]
sh = Image.new("RGB", (640 * 3, 360 * ((len(ims) + 2) // 3)))
for k, im in enumerate(ims): sh.paste(im, (640 * (k % 3), 360 * (k // 3)))
sh.save("sheet.jpg"); print("sheet.jpg")
