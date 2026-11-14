# schema.json を作る(編集画面がフォームを組むための一覧)。直すときはここを直して作り直す
import json
def N(label, default, mn=None, mx=None, step=None, anim=True, **kw):
    d = {"type": "number", "label": label, "default": default}
    if mn is not None: d["min"] = mn
    if mx is not None: d["max"] = mx
    if step is not None: d["step"] = step
    d["animatable"] = anim; d.update(kw); return d
def P(label, default=100, mn=0, mx=100, **kw): return {"type": "percent", "label": label, "default": default, "min": mn, "max": mx, "step": 1, "animatable": True, **kw}
def A(label, default=0, **kw): return {"type": "angle", "label": label, "default": default, "min": -360, "max": 360, "step": 1, "animatable": True, **kw}
def C(label, default, **kw): return {"type": "color", "label": label, "default": default, "animatable": True, **kw}
def B(label, default=False, **kw): return {"type": "bool", "label": label, "default": default, "animatable": False, **kw}
def S(label, default, options, **kw): return {"type": "select", "label": label, "default": default, "options": [{"value": v, "label": l} for v, l in options], "animatable": False, **kw}
def V2(label, default, **kw): return {"type": "vec2", "label": label, "default": default, "animatable": True, **kw}
def V3(label, default, **kw): return {"type": "vec3", "label": label, "default": default, "animatable": True, **kw}
def T(label, default="", **kw): return {"type": "text", "label": label, "default": default, "animatable": False, **kw}
CX = lambda: N("中心 X", 0, -4000, 4000, 1)
CY = lambda: N("中心 Y", 0, -4000, 4000, 1)
FE = lambda: N("境目のぼかし", 0, 0, 500, 1)
BLEND5 = [("normal", "通常"), ("add", "加算"), ("multiply", "乗算"), ("screen", "スクリーン"), ("overlay", "オーバーレイ"), ("subtract", "減算"), ("lighten", "比較(明)"), ("darken", "比較(暗)"), ("difference", "差分")]
SHAPES_M = [("rect", "四角形"), ("ellipse", "円"), ("diamond", "ひし形"), ("triangle", "三角形"), ("pentagon", "五角形"), ("hexagon", "六角形"), ("star", "星")]

E = {}
def fx(type, label, group, params, cheap): E[type] = {"label": label, "group": group, "cheap": cheap, "params": params}
G1, G2, G3, G4, G5, G6, G7 = "切る・隠す", "位置・並べる", "色", "縁・影", "ぼかし・光", "ゆがみ", "合成"
# --- 切る・隠す(シェーダで済む) ---
fx("clip_line", "斜めクリッピング", G1, {"cx": CX(), "cy": CY(), "angle": A("角度"), "width": N("幅(0 = 片側 / 正 = 帯を残す / 負 = 帯を消す)", 0, -4000, 4000, 1), "feather": FE(), "invert": B("反転"), "feather_mode": S("ぼかしの付き方", "center", [("center", "境目をまん中に(直線)"), ("inside", "内側だけ(境目で 0・cos カーブ。AviUtl の帯)")])}, True)
fx("crop", "クリッピング(上下左右)", G1, {"top": N("上", 0, 0, 4000, 1), "bottom": N("下", 0, 0, 4000, 1), "left": N("左", 0, 0, 4000, 1), "right": N("右", 0, 0, 4000, 1), "feather": FE(), "recenter": B("中心の位置を変更")}, True)
fx("blinds", "斜めブラインド", G1, {"ratio": P("残す割合", 50), "pitch": N("縞の幅", 100, 1, 2000, 1), "angle": A("角度", 40), "stagger": P("時間差", 0, 0, 400), "feather": FE(), "phase": N("ずらし", 0, -2000, 2000, 1)}, True)
fx("clip_sector", "扇クリッピング", G1, {"start": A("基準角"), "sweep": A("拡張角(消す範囲)", 90), "cx": CX(), "cy": CY(), "feather": FE(), "keep": B("扇形のほうを残す")}, True)
fx("radial_wipe", "扇形ワイプ(残す)", G1, {"start": A("開始角"), "sweep": A("見せる範囲", 360), "cx": CX(), "cy": CY(), "feather": FE()}, True)
fx("iris", "アイリス", G1, {"progress": P("開きぐあい", 100), "shape": S("形", "circle", [("circle", "円"), ("rect", "四角"), ("diamond", "ひし形"), ("star", "星"), ("polygon", "多角形")]), "sides": N("頂点の数", 5, 3, 24, 1, False), "inner": N("星の内径", 0.5, 0.05, 1, 0.01, False), "cx": CX(), "cy": CY(), "feather": FE(), "invert": B("反転")}, True)
fx("wipe", "ワイプ", G1, {"progress": P("進みぐあい", 0), "angle": A("角度", 90), "feather": FE()}, True)
fx("mask_shape", "マスク(図形)", G1, {"shape": S("形", "ellipse", SHAPES_M), "x": CX(), "y": CY(), "size": N("サイズ", 200, 0, 8000, 1), "aspect": N("縦横比", 0, -100, 100, 1), "rotation": A("回転"), "feather": FE(), "radius": N("角丸", 0, 0, 2000, 1), "expansion": N("広げる", 0, -500, 500, 1), "invert": B("反転"), "opacity": P("強さ")}, True)
fx("mask_image", "マスク(画像)", G1, {"asset_id": N("画像の素材", None, anim=False, asset="image"), "x": CX(), "y": CY(), "size": N("サイズ(長辺。0 = 元の大きさ)", 0, 0, 8000, 1), "rotation": A("回転"), "aspect": N("縦横比", 0, -100, 100, 1), "feather": FE(), "invert": B("反転"), "channel": S("使う成分", "auto", [("auto", "自動"), ("alpha", "アルファ"), ("luma", "輝度")]), "opacity": P("強さ")}, True)
fx("opacity", "透明度", G1, {"amount": P("不透明度")}, True)
# --- 位置・並べる ---
fx("offset", "座標・拡大率・回転・透明度(足し算)", G2, {"position": V3("位置に足す", [0, 0, 0]), "scale": P("拡大率に掛ける", 100, 0, 1000), "rotation": A("回転に足す"), "opacity": P("不透明度に掛ける")}, True)
fx("flip", "反転", G2, {"h": B("左右", True), "v": B("上下"), "luma": B("輝度反転"), "hue": B("色相反転"), "alpha": B("透明度反転")}, True)
fx("repeat", "並べる(画像ループ・一方向・円形)", G2, {"mode": S("並べ方", "grid", [("grid", "格子"), ("line", "一列"), ("circle", "円形"), ("random", "ばらまく")]), "count_x": N("個数 X(一列・円形の個数)", 3, 1, 256, 1), "count_y": N("個数 Y", 3, 1, 256, 1),
    "gap_x": P("間隔 X(幅に対する %。一列では px)", 100, 0, 1000), "gap_y": P("間隔 Y(高さに対する %)", 100, 0, 1000), "spacing_x": N("すき間 X(px)", 0, -2000, 2000, 1), "spacing_y": N("すき間 Y(px)", 0, -2000, 2000, 1),
    "stagger_rows": B("1 行おきに半分ずらす"), "scroll_x": N("流す X", 0, -100000, 100000, 1), "scroll_y": N("流す Y", 0, -100000, 100000, 1), "mirror": B("1 個おきに裏返す"),
    "angle": A("角度(一列の向き・円形の開始角)", 90), "radius": N("半径(円形)", 200, 0, 8000, 1), "sweep": A("範囲(円形)", 360), "rotate": B("中心を向ける(円形)", True), "both": B("両方向(一列)"),
    "area_x": N("ばらまく範囲 幅(ばらまく)", 400, 0, 16000, 1), "area_y": N("ばらまく範囲 高さ(ばらまく)", 400, 0, 16000, 1), "seed": N("乱数の種(ばらまく)", 1, 0, 99999, 1, False),
    "random_rotation": A("回転のばらつき ±(ばらまく)", 0), "scale_min": P("拡大率 最小(ばらまく)", 100, 0, 1000), "scale_max": P("拡大率 最大(ばらまく)", 100, 0, 1000),
    "spin": N("回る速さ ± 度/秒(ばらまく)", 0, 0, 3600, 1), "drift_x": N("流れる速さ X ± px/秒(ばらまく)", 0, 0, 10000, 1), "drift_y": N("流れる速さ Y ± px/秒(ばらまく)", 0, 0, 10000, 1),
    "copy_scale": P("1 個ずつの拡大率(円形)", 100, 0, 1000), "copy_rotation": A("1 個ずつの回転(円形)", 0)}, True)
# --- 色(シェーダで済む) ---
fx("fill", "単色化", G3, {"color": C("色", "#ffffff"), "amount": P("強さ"), "keep_luma": B("輝度を保持")}, True)
fx("tint", "色味を付ける", G3, {"color": C("色", "#ffb347"), "amount": P("強さ")}, True)
fx("color", "色調補正", G3, {"brightness": N("明るさ", 0, -100, 100, 1), "contrast": N("コントラスト", 0, -100, 200, 1), "saturation": N("彩度", 0, -100, 200, 1), "hue": A("色相"), "luminance": P("輝度", 100, 0, 400), "gamma": P("ガンマ", 100, 10, 400)}, True)
fx("grayscale", "グレースケール", G3, {"amount": P("強さ")}, True)
fx("duotone", "2 色化", G3, {"dark": C("暗部の色", "#000000"), "light": C("明部の色", "#ffffff"), "gamma": P("ガンマ", 100, 10, 400), "amount": P("強さ")}, True)
fx("threshold", "2 値化", G3, {"level": N("しきい値", 128, 0, 255, 1), "light": C("明部の色", "#ffffff"), "dark": C("暗部の色", "#000000"), "softness": N("なめらかさ", 0, 0, 128, 1), "amount": P("強さ")}, True)
fx("bleach_bypass", "ブリーチバイパス(銀残し)", G3, {"amount": P("強度"), "saturation": P("彩度", 70, 0, 200), "gamma": P("ガンマ", 120, 10, 400)}, True)
fx("invert", "色の反転", G3, {"amount": P("強さ"), "luma_only": B("輝度だけ")}, True)
fx("levels", "レベル補正", G3, {"in_black": N("入力 黒", 0, 0, 255, 1), "in_white": N("入力 白", 255, 0, 255, 1), "gamma": N("ガンマ", 1, 0.1, 5, 0.01), "out_black": N("出力 黒", 0, 0, 255, 1), "out_white": N("出力 白", 255, 0, 255, 1)}, True)
fx("gradient_map", "グラデーションマップ", G3, {"colors": {"type": "colors", "label": "色(暗 → 明、2〜4 色)", "default": ["#000000", "#ffffff"], "animatable": False}, "amount": P("強さ")}, True)
fx("posterize", "ポスタリゼーション", G3, {"levels": N("階調の数", 4, 2, 32, 1)}, True)
fx("chroma_key", "クロマキー", G3, {"color": C("抜く色", "#00ff00"), "hue_range": N("色相範囲", 24, 0, 256, 1), "sat_range": N("彩度範囲", 96, 0, 256, 1), "edge": N("境界補正", 1, 0, 5, 1), "spill": P("色かぶりを抑える", 0)}, True)
fx("luma_key", "ルミナンスキー", G3, {"threshold": N("しきい値", 128, 0, 255, 1), "softness": N("なめらかさ", 10, 0, 128, 1), "invert": B("明るい所を抜く")}, True)
fx("vignette", "周辺減光", G3, {"amount": P("強さ", 50), "radius": P("半径", 50), "softness": P("ぼかし", 50), "color": C("色", "#000000")}, True)
fx("flash", "フラッシュ", G3, {"amount": P("強さ", 50), "color": C("色", "#ffffff")}, True)
fx("lightleak", "光もれ", G3, {"color": C("色", "#ffb060"), "x": CX(), "y": CY(), "radius": N("大きさ", 500, 1, 8000, 1), "amount": P("強さ", 60), "angle": A("向き"), "stretch": N("のび", 1, 0.05, 10, 0.05)}, True)
fx("gradient_overlay", "グラデーション", G3, {"color": C("開始色", "#ffffff"), "color2": C("終了色", "#000000"), "shape": S("形", "linear", [("linear", "線"), ("radial", "円")]), "angle": A("角度"), "cx": CX(), "cy": CY(), "width": N("幅(0 = レイヤーの大きさ)", 0, 0, 8000, 1), "amount": P("強さ"), "blend": S("合成", "normal", BLEND5)}, True)
fx("border", "枠", G3, {"width": N("太さ", 4, 0, 500, 1), "color": C("色", "#ffffff"), "position": S("位置", "inside", [("inside", "内側"), ("center", "中央"), ("outside", "外側")]), "opacity": P("不透明度")}, True)
fx("noise", "ノイズ", G3, {"amount": N("量", 10, 0, 100, 1), "seed": N("種", 0, 0, 9999, 1, False), "color": B("色つき"), "animated": B("コマごとに変える", True)}, True)
fx("overlay_source", "画像・動画・コンポジションの合成", G7, {"asset_id": N("素材", None, anim=False, asset="any"), "mode": S("重ね方", "over", [("over", "上に重ねる"), ("under", "下に敷く"), ("replace_color", "色だけ置き換える"), ("luma_to_alpha", "輝度をアルファに")]), "x": CX(), "y": CY(), "scale": P("拡大率", 100, 0, 1000), "opacity": P("不透明度"), "start": N("再生位置(コマ)", 0, 0, 1000000, 1, False), "speed": N("再生速度", 1, 0, 16, 0.01, False), "tile": B("敷きつめる"), "fit": B("レイヤーの大きさに合わせる"),
    "anchor": S("位置の基準", "center", [("center", "中心どうし"), ("top_left", "箱の左上に素材の左上")])}, True)
# --- 縁・影(RT を使う) ---
fx("stroke_outline", "縁取り", G4, {"width": N("サイズ", 4, 0, 200, 1), "color": C("色", "#000000"), "blur": N("ぼかし", 0, 0, 200, 1), "position": S("位置", "outer", [("outer", "外側"), ("inner", "内側"), ("center", "中央")]), "opacity": P("不透明度"), "only": B("縁だけ")}, False)
fx("drop_shadow", "シャドー", G4, {"distance": N("距離", 12, 0, 1000, 1), "angle": A("角度", 135), "blur": N("拡散", 12, 0, 300, 1), "color": C("色", "#000000"), "opacity": P("濃さ", 60)}, False)
fx("inner_shadow", "内側シャドー", G4, {"distance": N("距離", 6, 0, 500, 1), "angle": A("角度", 135), "blur": N("拡散", 12, 0, 300, 1), "color": C("色", "#000000"), "opacity": P("濃さ", 60)}, False)
fx("long_shadow", "ロングシャドー", G4, {"length": N("長さ", 100, 0, 2000, 1), "angle": A("角度", 135), "color": C("色", "#000000"), "opacity": P("濃さ", 50), "fade": P("先を薄く", 0)}, False)
fx("trace_outline", "輪郭追跡", G4, {"progress": P("描画度"), "width": N("線幅", 8, 1, 100, 1), "start": P("開始点", 0), "threshold": N("閾値", 128, 1, 254, 1), "color": C("色", "#ffffff"), "only_line": B("輪郭のみ"),
    "dash_period": P("破線の周期(1 周に対する %。0 = 実線)", 0), "dash_gap": P("破線のすき間(%。周期より小さく)", 0)}, False)
fx("feather", "縁をぼかす", G4, {"radius": N("幅", 10, 0, 300, 1)}, False)
# --- ぼかし・光 ---
fx("blur", "ぼかし", G5, {"radius": N("範囲", 10, 0, 500, 1)}, False)
fx("directional_blur", "方向ブラー", G5, {"length": N("範囲", 40, 0, 1000, 1), "angle": A("角度", 90)}, False)
fx("radial_blur", "放射ブラー", G5, {"amount": N("範囲", 20, 0, 200, 1), "mode": S("種類", "zoom", [("zoom", "ズーム"), ("spin", "回転")]), "cx": CX(), "cy": CY()}, False)
fx("glow", "グロー", G5, {"radius": N("拡散", 20, 0, 300, 1), "strength": N("強さ", 1, 0, 5, 0.05), "threshold": P("しきい値", 50)}, False)
fx("sharpen", "シャープ", G5, {"amount": P("強さ", 50, 0, 400)}, False)
fx("vignette_blur", "周辺ボケ光量", G5, {"amount": P("周辺の暗さ", 60), "blur": N("周辺のぼかし", 8, 0, 200, 0.5), "radius": P("効き始める位置", 50, 0, 200), "softness": P("効ききるまでの幅", 50, 0, 200),
    "color_shift": N("周辺の色ずれ", 0, 0, 100, 0.5), "color": C("暗くする色", "#000000"), "cx": CX(), "cy": CY(),
    "shape": S("形", "box", [("box", "箱の縦横比のだ円"), ("circle", "正円")]), "ramp": S("変わり方", "smooth", [("smooth", "なめらか"), ("linear", "まっすぐ")]),
    "brightness": P("周辺の明るさ(100 = そのまま)", 100, 0, 200)}, False)
# --- ゆがみ ---
fx("wave", "波(ラスター)", G6, {"amp": N("振幅", 10, 0, 500, 1), "freq": N("山の数", 4, 0, 100, 0.1), "speed": N("速さ", 1, -20, 20, 0.1), "phase": N("位相", 0, -10, 10, 0.01)}, False)
fx("raster", "ラスター(波長で指定)", G6, {"amp": N("振幅", 10, 0, 500, 1), "wavelength": N("波長", 200, 2, 4000, 1), "speed": N("速さ", 1, -20, 20, 0.1), "vertical": B("縦")}, False)
fx("turbulent_displace", "乱流ゆがみ", G6, {"amount": N("量", 20, 0, 500, 1), "size": N("大きさ", 100, 2, 2000, 1), "seed": N("種", 1, 0, 9999, 1, False), "evolution": N("変化", 0, 0, 1000, 0.01), "octaves": N("細かさ", 2, 1, 4, 1, False)}, False)
fx("mosaic", "モザイク", G6, {"size": N("サイズ", 16, 1, 500, 1)}, False)
fx("halftone", "ハーフトーン", G6, {"size": N("サイズ", 8, 2, 200, 1), "min": P("トーン小", 0, 0, 200), "max": P("トーン大", 100, 0, 200), "angle": A("回転", 45), "fg": C("点の色", "#000000"), "bg": C("地の色", "#ffffff00"), "stagger": B("段違い"), "self_mask": B("自分自身で型抜き", True), "use_color": B("元の色で点を打つ"), "invert": B("明暗を逆に")}, False)
fx("rgb_shift", "色ずれ", G6, {"amount": N("ずれ幅", 4, 0, 200, 1), "angle": A("角度", 90)}, False)
fx("glitch", "グリッチ", G6, {"amount": N("ずれ幅", 40, 0, 500, 1), "block": N("帯の高さ", 24, 1, 500, 1), "rate": P("乱れる割合", 35), "rgb_shift": N("色ずれ", 6, 0, 100, 1), "seed": N("種", 1, 0, 9999, 1, False), "speed": N("1 秒あたりの変化", 30, 0, 120, 1, False)}, False)
fx("mirror", "ミラー", G6, {"angle": A("角度", 90), "cx": CX(), "cy": CY()}, False)
fx("polar", "極座標変換", G6, {"invert": B("逆変換")}, False)
ALIASES = {"clip": "crop", "tile": "repeat", "binarize": "threshold", "outline": "stroke_outline", "mask": "mask_shape", "gradient": "gradient_overlay"}

# ---------- レイヤーの種類 ----------
PAT_KINDS = [("stripes", "しま"), ("checker", "市松"), ("dots", "水玉"), ("grid", "格子"), ("hex", "亀甲"), ("triangles", "三角"), ("uroko", "鱗"), ("yagasuri", "矢絣"), ("asanoha", "麻の葉"), ("seigaiha", "青海波"), ("shippo", "七宝"), ("kagome", "籠目"), ("halftone", "網点"), ("rays", "集中線"), ("concentric", "同心円"), ("waves", "波"), ("noise", "ノイズ"), ("grain", "紙の粒"), ("zigzag", "山形"), ("gradient", "グラデーション")]
def pattern_params(group="模様"):
    g = {"group": group}
    return {"kind": S("模様", "stripes", PAT_KINDS, **g), "colors": {"type": "colors", "label": "色(1〜4 色)", "default": ["#f4a7b9", "#ffffff"], "animatable": False, **g},
            "size": N("大きさ", 40, 1, 2000, 1, **g), "angle": A("角度", **g), "offset": V2("ずらし(動かすと流れる)", [0, 0], **g), "line_width": N("線の太さ", 0, 0, 500, 0.5, **g), "softness": N("境目のぼかし", 0, 0, 200, 0.5, **g),
            "ratio": N("比率(模様ごとの意味)", 0.5, 0, 4, 0.01, optional=True, **g), "stagger": B("段違い(水玉・網点)", optional=True, **g), "slope": N("傾き(矢絣)", 1, 0, 4, 0.01, optional=True, **g),
            "rings": N("輪の数(青海波)", 3, 1, 12, 1, optional=True, **g), "count": N("本数(集中線)", 24, 2, 400, 1, optional=True, **g), "jitter": N("ばらつき(集中線)", 0, 0, 1, 0.01, optional=True, **g), "inner": N("内側の半径(集中線)", 0, 0, 4000, 1, optional=True, **g),
            "amplitude": N("振幅(波・山形)", 20, 0, 1000, 1, optional=True, **g), "wavelength": N("波長(波)", 160, 1, 4000, 1, optional=True, **g), "contrast": N("コントラスト(ノイズ)", 1.5, 0, 10, 0.1, optional=True, **g), "seed": N("種", 1, 0, 9999, 1, False, optional=True, **g),
            "grad_angle": A("網点の勾配の向き", 180, optional=True, **g), "grad_length": N("網点の勾配の長さ", 1080, 1, 8000, 1, optional=True, **g), "dot_min": P("網点 最小", 0, 0, 200, optional=True, **g), "dot_max": P("網点 最大", 100, 0, 200, optional=True, **g)}
FILL = lambda label, default, g: {"type": "fill", "label": label, "default": default, "animatable": True, "group": g, "accepts": ["color", "gradient", "pattern", "none"]}
SHAPE_KINDS = [("rect", "四角形"), ("ellipse", "円"), ("polygon", "多角形"), ("star", "星"), ("line", "線"), ("path", "パス"), ("arc", "円弧"), ("pie", "扇形"), ("ring", "輪"), ("arrow", "矢印"), ("chevron", "矢じり"), ("cross", "十字"), ("heart", "ハート"), ("flower", "花"), ("petal", "花びら"), ("burst", "爆発"), ("bubble", "吹き出し")]
g = lambda name: {"group": name}
LT = {}
# 画像・動画・連番の「N px に合わせる」(素材の画素数を知らなくてよい。transform.scale はその上に掛かる)
FIT = lambda: {"fit": {"type": "object", "label": "大きさを合わせる(px。片方だけ = 縦横比どおり)", "default": None, "animatable": False, "optional": True, "group": "大きさ", "fields": {
    "width": N("幅 px", None, 1, 16000, 1, optional=True), "height": N("高さ px", None, 1, 16000, 1, optional=True),
    "mode": S("合わせ方(幅も高さも無し = 画面に)", "contain", [("contain", "収める(全体が見える)"), ("cover", "覆う(はみ出しは切る)"), ("stretch", "引きのばす(縦横比を無視)")])}}}
LT["image"] = {"label": "画像", "icon": "🖼️", "source": {"asset_id": N("素材", None, anim=False, asset="image", **g("素材")), **FIT()}, "default_source": {"asset_id": None}, "default_layer": {}}
LT["video"] = {"label": "動画", "icon": "🎞️", "source": {"asset_id": N("素材", None, anim=False, asset="video", **g("素材")), "loop": B("繰り返す", **g("素材")), **FIT()}, "default_source": {"asset_id": None}, "default_layer": {"start": 0, "speed": 1}}
LT["sequence"] = {"label": "連番画像", "icon": "🎬", "source": {"sequence": {"type": "object", "label": "連番({asset_ids:[...]} か {url_pattern, start, count, fps})", "default": {"asset_ids": []}, "animatable": False, "group": "素材"}, "loop": B("繰り返す", **g("素材")), **FIT()}, "default_source": {"sequence": {"asset_ids": []}}, "default_layer": {}}
LT["solid"] = {"label": "平面", "icon": "⬛", "source": {"color": C("色", "#ffffff", **g("塗り")), "width": N("幅(省略 = 画面)", None, 1, 8000, 1, optional=True, **g("大きさ")), "height": N("高さ", None, 1, 8000, 1, optional=True, **g("大きさ")), "fill": FILL("塗り(グラデーション・模様)", None, "塗り") | {"optional": True}}, "default_source": {"color": "#ffffff"}, "default_layer": {}}
LT["pattern"] = {"label": "模様", "icon": "🎴", "source": {**pattern_params(), "width": N("幅(省略 = 画面)", None, 1, 16000, 1, optional=True, **g("大きさ")), "height": N("高さ", None, 1, 16000, 1, optional=True, **g("大きさ")),
    "cols": N("横の升目の数(幅 = 大きさ × 個数。市松など)", None, 1, 1000, 1, False, optional=True, **g("大きさ")), "rows": N("縦の升目の数", None, 1, 1000, 1, False, optional=True, **g("大きさ")),
    "origin": S("模様の原点", "center", [("center", "箱の中心"), ("top_left", "箱の左上")], optional=True, **g("大きさ"))}, "default_source": {"kind": "yagasuri", "colors": ["#e65163", "#f6a5b0"], "size": 80}, "default_layer": {}}
LT["shape"] = {"label": "シェイプ", "icon": "🔷", "source": {"kind": S("形", "rect", SHAPE_KINDS, **g("形")), "width": N("幅", 300, 0, 8000, 1, **g("形")), "height": N("高さ", 300, 0, 8000, 1, **g("形")), "radius": N("角丸", 0, 0, 2000, 1, **g("形")),
    "sides": N("頂点の数", 5, 3, 64, 1, optional=True, **g("形")), "inner": N("内径の比(星・輪)", 0.5, 0, 1, 0.01, optional=True, **g("形")), "start": A("開始角(円弧・扇・輪)", 0, optional=True, **g("形")), "end": A("終了角", 360, optional=True, **g("形")),
    "thickness": N("太さの比(矢じり・十字)", 0.4, 0.02, 1, 0.01, optional=True, **g("形")), "head": N("矢の頭の比", 0.4, 0.02, 1, 0.01, optional=True, **g("形")), "shaft": N("矢の軸の比", 0.4, 0.01, 1, 0.01, optional=True, **g("形")), "petals": N("花びらの数", 5, 3, 24, 1, optional=True, **g("形")),
    "jitter": N("ばらつき(爆発)", 0.2, 0, 1, 0.01, optional=True, **g("形")), "seed": N("種", 1, 0, 9999, 1, False, optional=True, **g("形")), "points": {"type": "points", "label": "頂点(線・パス)", "default": [[-100, 0], [100, 0]], "animatable": True, "optional": True, "group": "形"},
    "closed": B("閉じる(パス)", optional=True, **g("形")), "morph_to": {"type": "points", "label": "変形先の頂点", "default": None, "animatable": False, "optional": True, "group": "形"}, "morph": P("変形の割合", 0, optional=True, **g("形")),
    "fill": FILL("塗り", "#ffffff", "塗り"), "stroke": {"type": "fill", "label": "線の色", "default": None, "animatable": True, "group": "線", "accepts": ["color", "gradient", "none"]}, "stroke_width": N("線の太さ", 0, 0, 500, 0.5, **g("線")),
    "stroke_in_box": B("線の外側までを箱にする(crop・マスクの基準。AviUtl の図形と同じ)", optional=True, **g("線")),
    "cap": S("線の端", "butt", [("butt", "切り落とし"), ("round", "丸"), ("square", "四角")], **g("線")), "join": S("角", "round", [("round", "丸"), ("miter", "とがり"), ("bevel", "面取り")], **g("線")),
    "trim": V2("描く範囲 %(始・終)", [0, 100], **g("線")), "trim_offset": P("描く範囲のずらし", 0, -100, 100, **g("線")), "dash": {"type": "vec2", "label": "破線(線・すき間)", "default": None, "animatable": False, "optional": True, "group": "線"}, "dash_offset": N("破線のずらし", 0, -10000, 10000, 1, **g("線"))},
    "default_source": {"kind": "rect", "width": 300, "height": 300, "fill": "#e65163"}, "default_layer": {}}
LT["text"] = {"label": "テキスト", "icon": "🔤", "source": {"text": T("文字", "テキスト", multiline=True, **g("文字")), "font": T("書体", "Noto Sans JP", font=True, **g("文字")), "weight": N("太さ", 700, 100, 900, 100, False, **g("文字")), "italic": B("斜体", **g("文字")), "size": N("サイズ", 96, 1, 2000, 1, **g("文字")),
    "tracking": N("字間", 0, -200, 500, 0.5, **g("文字")), "leading": N("行送り(0 = 自動)", 0, 0, 2000, 1, **g("文字")), "align": S("そろえ", "center", [("left", "左"), ("center", "中央"), ("right", "右")], **g("組み")),
    "valign": S("基準点(縦)", None, [(None, "(箱の中心)"), ("top", "上"), ("middle", "中"), ("bottom", "下")], optional=True, **g("組み")), "writing": S("書字方向", "horizontal", [("horizontal", "横書き"), ("vertical", "縦書き")], **g("組み")),
    "vertical_latin": S("縦書きの英数字", "rotate", [("rotate", "横に寝かせる"), ("upright", "立てる")], optional=True, **g("組み")), "wrap_width": N("折り返す幅(0 = なし)", 0, 0, 8000, 1, False, **g("組み")),
    "fill": FILL("塗り", "#ffffff", "塗り"), "stroke": C("縁の色", None, optional=True, **g("縁")), "stroke_width": N("縁の太さ", 0, 0, 200, 0.5, **g("縁")), "stroke_over": B("縁を塗りの上に", **g("縁")),
    "strokes": {"type": "list", "label": "外側の縁(二重縁取り)", "default": [], "animatable": False, "optional": True, "group": "縁", "item": {"color": C("色", "#000000"), "width": N("太さ", 4, 0, 200, 0.5)}},
    "shadow": {"type": "object", "label": "影", "default": None, "animatable": False, "optional": True, "group": "影", "fields": {"color": C("色", "#000000"), "x": N("X", 4, -500, 500, 1), "y": N("Y", 4, -500, 500, 1), "blur": N("ぼかし", 0, 0, 200, 1), "opacity": P("濃さ")}},
    "plate": {"type": "object", "label": "座布団", "default": None, "animatable": False, "optional": True, "group": "座布団", "fields": {"color": C("色", "#000000"), "opacity": P("不透明度"), "padding": V2("余白", [24, 10]), "radius": N("角丸", 0, 0, 500, 1), "stroke": C("枠の色", None), "stroke_width": N("枠の太さ", 0, 0, 100, 0.5)}},
    "counter": {"type": "object", "label": "カウンター", "default": None, "animatable": False, "optional": True, "group": "カウンター", "fields": {"value": N("値", 0, -1e15, 1e15, 1), "start": N("初期値(value が無いとき)", 0, -1e15, 1e15, 1, False), "rate": N("1 秒あたりの増分", 1, -1e9, 1e9, 0.01, False), "decimals": N("小数の桁", 0, 0, 10, 1, False), "pad": N("ゼロ埋めの桁", 0, 0, 20, 1, False),
        "prefix": T("前に付ける文字"), "suffix": T("後ろに付ける文字"), "separator": B("3 桁区切り"), "format": T("形式(number / timecode / hh:mm:ss / mm:ss / mm:ss.cc / ####.##.## のようなひな形)", "number"), "fixed_width": B("数字を等幅に", True), "scramble": P("数字を回す割合", 0)}},
    "visible_chars": N("見せる文字数(タイプライター)", None, 0, 100000, 0.1, optional=True, **g("アニメ")),
    "arc": {"type": "object", "label": "円周に沿わせる", "default": None, "animatable": False, "optional": True, "group": "円周", "fields": {"radius": N("半径(負 = 下側)", 300, -8000, 8000, 1), "start": A("位置"), "sweep": A("等間隔に配る範囲(省略 = 字幅どおり)", None),
        "deg_per_px": N("px あたりの角度(度。書くと「字幅 ÷ 半径」の代わりに「文字の横位置 × これ」)", None, -10, 10, 0.001, optional=True)}},
    "per_char": {"type": "object", "label": "文字ごとアニメ", "default": None, "animatable": False, "optional": True, "group": "アニメ", "fields": {"unit": S("単位", "char", [("char", "文字"), ("word", "単語"), ("line", "行")]), "stagger": N("間隔(コマ)", 2, 0, 600, 0.1, False), "duration": N("時間(コマ)", 12, 0.1, 600, 0.1, False),
        "order": S("登場順", "forward", [("forward", "前から"), ("backward", "後ろから"), ("center", "内側から"), ("edges", "外側から"), ("random", "ランダム")]), "e": T("イージング", "easeOut"), "at": N("開始(レイヤーの頭からのコマ)", 0, 0, 100000, 1, False),
        "ranks": {"type": "numbers", "label": "順番の表(i 文字目が何番目に出るか。書くと登場順より優先)", "default": None, "animatable": False, "optional": True},
        "sequence": {"type": "numbers", "label": "出る順に並べた文字の番号(0 始まり。ranks の逆の書き方)", "default": None, "animatable": False, "optional": True},
        "from": {"type": "object", "label": "始まりの姿", "fields": {"position": V3("位置", [0, 40, 0]), "scale": V2("拡大率", [100, 100]), "rotation": A("回転"), "opacity": P("不透明度", 0)}},
        "out": {"type": "object", "label": "退場(文字ごと)", "default": None, "animatable": False, "optional": True, "fields": {
            "stagger": N("間隔(コマ)", 2, 0, 600, 0.1, False), "duration": N("時間(コマ)", 12, 0.1, 600, 0.1, False),
            "order": S("退場順", "forward", [("forward", "前から"), ("backward", "後ろから"), ("center", "内側から"), ("edges", "外側から"), ("random", "ランダム")]), "e": T("イージング", "easeIn", easing=True),
            "at": N("開始(レイヤーの頭からのコマ。省略 = 最後の文字がレイヤーの終わりで消え終わる)", None, 0, 100000, 1, False, optional=True),
            "to": {"type": "object", "label": "終わりの姿", "fields": {"position": V3("位置", [0, -40, 0]), "scale": V2("拡大率", [100, 100]), "rotation": A("回転"), "opacity": P("不透明度", 0)}}}},
        "random": {"type": "object", "label": "文字ごとの乱れ", "fields": {"position": V3("位置", [0, 0, 0]), "rotation": A("回転"), "scale": P("拡大率", 0, 0, 500), "opacity": P("不透明度", 0), "seed": N("種", 1, 0, 9999, 1, False), "amount": P("量")}}}},
    "runs": {"type": "list", "label": "文の途中の書体・サイズ替え", "default": None, "animatable": False, "optional": True, "group": "文字", "item": {"text": T("文字"), "font": T("書体", None, font=True), "size": N("サイズ", None, 1, 2000, 1, False), "weight": N("太さ", None, 100, 900, 100, False), "fill": C("色", None), "baseline_shift": N("上下のずれ", 0, -1000, 1000, 1, False)}}},
    "default_source": {"text": "テキスト", "font": "Noto Sans JP", "weight": 700, "size": 96, "fill": "#ffffff"}, "default_layer": {}}
LT["comp"] = {"label": "コンポジション", "icon": "🧩", "source": {"comp_id": N("コンポジション", None, anim=False, asset="comp", **g("素材")), "loop": B("繰り返す", **g("素材")),
    "transparent": B("子の背景色を塗らない(下のレイヤーが透ける)", optional=True, **g("素材"))}, "default_source": {"comp_id": None}, "default_layer": {"start": 0, "speed": 1}}
LT["null"] = {"label": "ヌル(親)", "icon": "✛", "source": {}, "default_source": {}, "default_layer": {}}
LT["group"] = {"label": "グループ制御", "icon": "🗂️", "source": {}, "default_source": {}, "default_layer": {"scope": 1}}
LT["camera"] = {"label": "カメラ", "icon": "🎥", "source": {"zoom": N("距離(zoom。AviUtl は 1024)", None, 1, 100000, 1, optional=True, **g("レンズ")), "fov": N("水平画角(zoom が無いとき)", 39.6, 1, 170, 0.1, **g("レンズ")), "ortho": B("平行投影", **g("レンズ")), "target": V3("注視点", None, optional=True, **g("向き")),
    "target_layer": T("注視するレイヤーの id", None, optional=True, layer=True, **g("向き")),
    "targets": {"type": "layers", "label": "注視するレイヤーの列(target_index で順に移る)", "default": None, "animatable": False, "optional": True, "group": "向き"},
    "target_index": N("注視する相手の番号(0 始まり。小数で途中)", 0, 0, 1000, 0.01, optional=True, when={"targets": ["*"]}, **g("向き")), "zbuffer": B("奥行きで並べ替える", True, **g("向き")),
    "dof": {"type": "object", "label": "被写界深度", "default": None, "animatable": False, "optional": True, "group": "被写界深度", "fields": {"focus_distance": N("ピントの距離(0 = zoom)", 0, 0, 100000, 1), "aperture": N("ぼけの強さ", 20, 0, 500, 1), "max_blur": N("ぼけの上限", 60, 0, 300, 1, False)}}},
    "default_source": {"zoom": 1024}, "default_layer": {}}
LT["model"] = {"label": "3D モデル", "icon": "🧊", "source": {"asset_id": N("素材(GLB)", None, anim=False, asset="model", **g("素材")), "height": N("高さ", 540, 1, 8000, 1, **g("素材"))}, "default_source": {"asset_id": None}, "default_layer": {}}
PRE = [("", "(なし)"), ("petals", "花びら"), ("confetti", "紙吹雪"), ("snow", "雪"), ("sparks", "火花"), ("dust", "ちり")]
LT["particles"] = {"label": "粒子", "icon": "✨", "source": {"seed": N("種", 1, 0, 99999, 1, False, **g("粒子")), **{"emitter." + k: v for k, v in {
    "preset": S("出来合い", "", PRE, optional=True, **g("粒子")), "sprite": S("粒の絵", "soft", [(x, x) for x in ["soft", "circle", "square", "rect", "star", "spark", "petal", "heart", "flower"]], **g("粒子")), "blend": S("重ね方", "add", [("add", "加算"), ("normal", "通常")], **g("粒子")),
    "position": V3("出る場所", [0, 0, 0], **g("出かた")), "emit": S("出る形", "box", [("box", "箱"), ("circle", "円"), ("line", "線"), ("point", "点")], **g("出かた")), "area": V3("出る範囲", [0, 0, 0], **g("出かた")), "rate": N("1 秒あたりの数", 30, 0, 2000, 1, **g("出かた")), "burst": N("最初に一斉に出す数", 0, 0, 6000, 1, False, **g("出かた")),
    "life": N("寿命(秒)", 1.5, 0.05, 60, 0.05, **g("出かた")), "life_random": N("寿命のばらつき", 0, 0, 1, 0.01, **g("出かた")), "speed": N("速さ", 200, 0, 5000, 1, **g("動き")), "speed_random": N("速さのばらつき", 0.3, 0, 1, 0.01, **g("動き")), "direction": A("向き", **g("動き")), "spread": A("広がり", 360, **g("動き")),
    "gravity": V3("重力", [0, 0, 0], **g("動き")), "wind": V3("風", [0, 0, 0], **g("動き")), "drag": N("抵抗", 0, 0, 20, 0.05, **g("動き")), "z_speed": N("奥行きの速さ", 0, 0, 5000, 1, **g("動き")), "spin": N("回転(度/秒)", 0, -3600, 3600, 1, **g("動き")), "flutter": N("ひらひら(度/秒)", 0, 0, 3600, 1, **g("動き")),
    "size": V2("大きさ(始・終)", [16, 0], **g("見た目")), "size_random": N("大きさのばらつき", 0.3, 0, 1, 0.01, **g("見た目")), "opacity": V2("不透明度(始・終)", [100, 0], **g("見た目")), "color": C("色", "#ffffff", **g("見た目"))}.items()}},
    "default_source": {"seed": 1, "emitter": {"preset": "petals", "position": [0, -600, 0], "area": [1920, 40, 0]}}, "default_layer": {}}
LT["adjustment"] = {"label": "調整レイヤー", "icon": "🎚️", "source": {}, "default_source": {}, "default_layer": {"effects": [{"type": "color", "params": {"contrast": 10}}]}}

TR_TYPES = [("fade", "フェード"), ("slide", "スライド"), ("wipe", "ワイプ"), ("blinds", "ブラインド"), ("iris", "アイリス"), ("radial", "扇形"), ("zoom", "ズーム"), ("flip", "フリップ"), ("blur", "ぼかし"), ("clip", "クリッピング")]
def tr(prefix, lab):
    gg = g(lab)
    return {prefix + ".type": S("種類", "fade", TR_TYPES, **gg), prefix + ".duration": N("長さ(コマ)", 15, 1, 600, 1, False, **gg), prefix + ".e": T("イージング", "easeOut" if prefix.endswith("in") else "easeIn", easing=True, **gg),
            prefix + ".direction": S("向き(スライド)", "left", [("left", "左から"), ("right", "右から"), ("up", "上から"), ("down", "下から")], optional=True, **gg), prefix + ".distance": N("距離(スライド)", 300, 0, 8000, 1, False, optional=True, **gg),
            prefix + ".angle": A("角度(ワイプ・ブラインド)", 90, optional=True, **gg), prefix + ".pitch": N("縞の幅(ブラインド)", 100, 1, 2000, 1, False, optional=True, **gg), prefix + ".shape": S("形(アイリス)", "circle", [("circle", "円"), ("rect", "四角"), ("diamond", "ひし形"), ("star", "星")], optional=True, **gg),
            prefix + ".from": P("始まりの拡大率(ズーム)", 0, 0, 1000, optional=True, **gg), prefix + ".radius": N("ぼかしの大きさ", 40, 0, 500, 1, False, optional=True, **gg), prefix + ".side": S("隠れている側(クリッピング)", "bottom", [("top", "上"), ("bottom", "下"), ("left", "左"), ("right", "右")], optional=True, **gg), prefix + ".feather": N("境目のぼかし", 0, 0, 500, 1, False, optional=True, **gg)}
RG = g("複製")
COMMON = {
    "transform.position": V3("位置", [960, 540, 0], group="変形"), "transform.anchor": V3("アンカー", [0, 0, 0], group="変形"), "transform.scale": V2("拡大率", [100, 100], group="変形"), "transform.rotation": V3("回転(X・Y・Z)", [0, 0, 0], group="変形"), "transform.opacity": P("不透明度", group="変形"),
    "in": N("開始コマ", 0, 0, 10000000, 1, False, group="時間"), "out": N("終了コマ(含まない)", 150, 0, 10000000, 1, False, group="時間"), "start": N("素材の開始コマ", 0, -10000000, 10000000, 1, False, group="時間", types=["video", "comp", "sequence"]), "speed": N("再生速度", 1, -16, 16, 0.01, False, group="時間", types=["video", "comp", "sequence"]),
    "time_remap": N("タイムリマップ(素材のコマ)", None, 0, 10000000, 1, optional=True, group="時間", types=["video", "comp", "sequence"]), "freeze": N("止めるコマ", None, 0, 10000000, 1, optional=True, group="時間", types=["video", "comp", "sequence"]), "reverse": B("逆再生", group="時間", types=["video", "comp", "sequence"]), "loop": B("繰り返す", group="時間", types=["video", "comp", "sequence"]),
    "posterize_time": N("コマ打ち(1 秒あたりのコマ数。0 = なし)", 0, 0, 120, 1, group="時間"),
    "visible": B("表示", True, group="表示"), "locked": B("ロック", group="表示"), "solo": B("ソロ", group="表示"), "guide": B("下絵(書き出しに出さない)", group="表示"),
    "blend": {"type": "select", "label": "合成モード", "default": "normal", "options": "blend_modes", "animatable": False, "group": "合成"}, "three_d": B("3D レイヤー", group="3D"), "billboard": B("いつもカメラを向く", group="3D"), "double_sided": B("裏面も描く", True, group="3D"),
    "motion_blur": B("モーションブラー", group="合成"), "parent": T("親レイヤー", None, layer=True, optional=True, group="変形"), "clip_to": T("このレイヤーの形で切り抜く(相手も映る)", None, layer=True, optional=True, group="合成"),
    "matte.layer": T("トラックマット", None, layer=True, optional=True, group="合成"), "matte.absent": S("マット元が表示区間の外のとき", "hide", [("hide", "何も見えない"), ("show", "切らずに全部見える")], optional=True, group="合成"), "matte.mode": S("マットの種類", "alpha", [("alpha", "アルファ"), ("alpha_inv", "アルファ反転"), ("luma", "ルミナンス"), ("luma_inv", "ルミナンス反転")], optional=True, group="合成"), "matte.keep_source": B("マット元も映す", optional=True, group="合成"),
    "scope": {"type": "scope", "label": "効かせる範囲(数 = 下の N 層・0 = 下すべて / レイヤー id の配列)", "default": 0, "min": 0, "max": 1000, "step": 1, "animatable": False, "accepts": ["number", "layers"], "group": "グループ・カメラ", "types": ["group", "camera"], "optional": True}, "snapshot": B("画面を 1 枚の絵として動かす(フレームバッファ)", group="調整レイヤー", types=["adjustment"]),
    "repeater.count": N("個数(書かなければ 1 = 複製なし)", 3, 0, 4096, 1, **RG), "repeater.mode": S("並べ方", "linear", [("linear", "一方向"), ("grid", "格子"), ("radial", "円形"), ("random", "ランダム")], **RG), "repeater.offset.position": V3("1 個ごとのずれ", [100, 0, 0], **RG), "repeater.offset.rotation": A("1 個ごとの回転", **RG),
    "repeater.offset.scale": P("1 個ごとの拡大率", 100, 0, 400, **RG), "repeater.offset.opacity": P("1 個ごとの不透明度", **RG), "repeater.time_offset": N("1 個ごとの時間差(コマ)", 0, -600, 600, 0.5, False, **RG), "repeater.order": S("重なり順", "back", [("back", "あとの複製が手前"), ("front", "最初が手前")], **RG),
    "repeater.grid.cols": N("列の数(格子)", 4, 1, 256, 1, **RG, optional=True), "repeater.grid.gap": V2("すき間(格子)", [0, 0], **RG, optional=True), "repeater.grid.stagger": B("1 行おきに半分ずらす", **RG, optional=True),
    "repeater.radial.radius": N("半径(円形)", 300, 0, 8000, 1, **RG, optional=True), "repeater.radial.start_angle": A("開始角(円形)", **RG, optional=True), "repeater.radial.sweep": A("範囲(円形)", 360, **RG, optional=True), "repeater.radial.face_center": B("中心を向ける", **RG, optional=True),
    "repeater.random.area": V3("範囲(ランダム)", [1920, 1080, 0], **RG, optional=True), "repeater.random.seed": N("種", 1, 0, 99999, 1, False, **RG, optional=True), "repeater.random.rotation": A("回転のばらつき", **RG, optional=True), "repeater.random.scale_range": V2("拡大率の範囲 %", [100, 100], **RG, optional=True, animatable=False),
    **tr("transition_in", "登場"), **tr("transition_out", "退場"),
}
MASK = {"shape": S("形", "rect", [("rect", "四角形"), ("rounded_rect", "角丸"), ("ellipse", "円"), ("polygon", "多角形(points)"), ("path", "パス(points・ベジェ)"), ("star", "星"), ("heart", "ハート"), ("flower", "花")]), "x": N("X(箱の左上から)", 0, -8000, 8000, 1), "y": N("Y", 0, -8000, 8000, 1), "w": N("幅", None, 0, 8000, 1), "h": N("高さ", None, 0, 8000, 1),
        "radius": N("角丸", 0, 0, 2000, 1), "feather": FE(), "expansion": N("広げる", 0, -500, 500, 1), "invert": B("反転"), "opacity": P("強さ")}
BLENDS = [("normal", "通常"), ("add", "加算"), ("screen", "スクリーン"), ("multiply", "乗算"), ("overlay", "オーバーレイ"), ("lighten", "比較(明)"), ("darken", "比較(暗)"), ("difference", "差分"), ("subtract", "減算"), ("exclusion", "除外"), ("hard_light", "ハードライト"), ("soft_light", "ソフトライト"), ("color_dodge", "覆い焼き"), ("color_burn", "焼き込み"), ("linear_burn", "焼き込みリニア"), ("luminosity", "輝度"), ("color", "カラー(色差)"), ("hue", "色相"), ("saturation", "彩度")]
EAS = [("linear", "直線"), ("hold", "瞬間移動")]
jn = {"Quad": "2 次", "Cubic": "3 次", "Quart": "4 次", "Quint": "5 次", "Sine": "サイン", "Expo": "指数", "Circ": "円", "Elastic": "ばね", "Back": "行きすぎ", "Bounce": "はずみ"}
for k, j in jn.items():
    for d, dj in (("in", "加速"), ("out", "減速"), ("inOut", "加速+減速"), ("outIn", "減速+加速")): EAS.append((d + k, f"{j} {dj}"))
EAS += [("easeIn", "(旧)加速"), ("easeOut", "(旧)減速"), ("easeInOut", "(旧)加速+減速"), ("easeInCubic", "(旧)3 次 加速"), ("easeOutCubic", "(旧)3 次 減速"), ("easeInOutCubic", "(旧)3 次 加速+減速"), ("easeInBack", "(旧)行きすぎ 加速"), ("easeOutBack", "(旧)行きすぎ 減速"), ("easeOutElastic", "(旧)ばね"), ("easeOutBounce", "(旧)はずみ"), ("easeInBounce", "(旧)はずみ 加速"), ("easeInExpo", "(旧)指数 加速"), ("easeOutExpo", "(旧)指数 減速")]
def kf(*keys): return {"k": [{"f": f, "v": v, **({"e": e} if e else {})} for f, v, e in keys], "relative": True}
PRESETS = {"layer": [
    {"id": "in_fade", "label": "フェードイン", "group": "登場", "apply": {"transition_in": {"type": "fade", "duration": 15}}},
    {"id": "in_slide_up", "label": "下から飛び込む", "group": "登場", "apply": {"effects+": [{"type": "offset", "params": {"position": kf((0, [0, 1000, 0], "outCirc"), (30, [0, 0, 0], None)), "opacity": kf((0, 0, None), (8, 100, None))}}]}},
    {"id": "in_blinds", "label": "斜めブラインドで開く", "group": "登場", "apply": {"transition_in": {"type": "blinds", "pitch": 120, "angle": 40, "stagger": 100, "duration": 24, "e": "inOutQuad"}}},
    {"id": "in_clip_down", "label": "上から開く(クリッピング)", "group": "登場", "apply": {"transition_in": {"type": "clip", "side": "bottom", "duration": 24, "e": "inOutExpo"}}},
    {"id": "in_iris", "label": "円で開く", "group": "登場", "apply": {"transition_in": {"type": "iris", "shape": "circle", "duration": 20, "e": "outCirc"}}},
    {"id": "in_zoom_back", "label": "はずんで出る", "group": "登場", "apply": {"transition_in": {"type": "zoom", "from": 0, "duration": 16, "e": "outBack"}}},
    {"id": "out_fade", "label": "フェードアウト", "group": "退場", "apply": {"transition_out": {"type": "fade", "duration": 15}}},
    {"id": "out_slide", "label": "上へ飛び去る", "group": "退場", "apply": {"transition_out": {"type": "slide", "direction": "up", "distance": 1200, "duration": 16, "e": "inCirc"}}},
    {"id": "drift", "label": "ゆっくり流れる(位置の足し算)", "group": "動き", "apply": {"effects+": [{"type": "offset", "params": {"position": {"k": [{"f": 0, "v": [0, 112, 0]}, {"f": "out", "v": [0, 0, 0]}], "relative": True}}}]}},
    {"id": "band", "label": "斜めの帯にする", "group": "形", "apply": {"effects+": [{"type": "clip_line", "params": {"angle": 90, "width": 200}}, {"type": "clip_line", "params": {"angle": 38, "width": 760}}]}},
    {"id": "arrowhead", "label": "矢じりの列(縦の帯 + 斜めブラインド)", "group": "形", "apply": {"effects+": [{"type": "clip_line", "params": {"angle": 90, "width": 63}}, {"type": "blinds", "params": {"ratio": 50, "pitch": 344, "angle": 40}}]}},
    {"id": "wiggle", "label": "手ぶれ", "group": "動き", "apply": {"effects+": [{"type": "offset", "params": {"position": {"v": [0, 0, 0], "wiggle": {"freq": 2, "amp": [12, 12, 0], "seed": 1}}}}]}},
    {"id": "cascade", "label": "時間差で並べる", "group": "複製", "apply": {"repeater": {"count": 8, "mode": "linear", "offset": {"position": [80, 0, 0]}, "time_offset": 3}}},
    {"id": "halftone_bw", "label": "白黒の網点", "group": "色", "apply": {"effects+": [{"type": "grayscale", "params": {}}, {"type": "halftone", "params": {"size": 8, "fg": "#333333", "bg": "#e9e4e2", "self_mask": False}}]}},
    {"id": "sticker", "label": "白フチ + 影(シール風)", "group": "縁", "apply": {"effects+": [{"type": "stroke_outline", "params": {"width": 10, "color": "#ffffff"}}, {"type": "drop_shadow", "params": {"distance": 12, "angle": 135, "blur": 0, "color": "#2b2230", "opacity": 85}}]}},
], "text": [
    {"id": "ta_up", "label": "1 文字ずつ下から(TA 標準登場)", "group": "登場", "apply": {"source.per_char": {"stagger": 3, "duration": 22, "from": {"position": [0, 250, 0], "opacity": 0}, "e": {"pow": 2}}}},
    {"id": "ta_side", "label": "1 文字ずつ横から", "group": "登場", "apply": {"source.per_char": {"stagger": 2, "duration": 18, "from": {"position": [50, 0, 0], "opacity": 0}, "e": {"pow": 5}}}},
    {"id": "pop_word", "label": "単語ごとにはずむ", "group": "登場", "apply": {"source.per_char": {"unit": "word", "stagger": 6, "duration": 18, "from": {"scale": [0, 0], "opacity": 0}, "e": "outBack"}}},
    {"id": "typewriter", "label": "タイプライター", "group": "登場", "apply": {"source.visible_chars": {"k": [{"f": 0, "v": 0}, {"f": 60, "v": 30}], "relative": True}}},
    {"id": "nameplate", "label": "縦書きの名札", "group": "見た目", "apply": {"source.writing": "vertical", "source.font": "Noto Serif JP", "source.fill": "#221914", "source.plate": {"color": "#ffffff", "padding": [18, 26], "stroke": "#221914", "stroke_width": 1.5}, "transition_in": {"type": "clip", "side": "bottom", "duration": 24, "e": "inOutExpo"}}},
    {"id": "caption", "label": "説明の帯(座布団)", "group": "見た目", "apply": {"source.fill": "#ffffff", "source.plate": {"color": "#2b2230", "padding": [26, 10], "stroke": "#7fd0d8", "stroke_width": 4}}},
    {"id": "double_stroke", "label": "二重縁取り", "group": "見た目", "apply": {"source.stroke": "#ffffff", "source.stroke_width": 6, "source.strokes": [{"color": "#3b2d59", "width": 6}]}},
    {"id": "counter_date", "label": "走る日付", "group": "カウンター", "apply": {"source.counter": {"value": {"k": [{"f": 0, "v": 201111110000}, {"f": 90, "v": 202111111111, "e": "outExpo"}], "relative": True}, "format": "####.##.##.##:##", "fixed_width": True, "scramble": {"k": [{"f": 0, "v": 100}, {"f": 100, "v": 0}], "relative": True}}}},
    {"id": "pattern_fill", "label": "模様で塗る", "group": "見た目", "apply": {"source.fill": {"pattern": {"kind": "stripes", "colors": ["#e65163", "#f6a5b0"], "size": 14, "angle": 45}}}},
]}
schema = {"version": 2, "notes": {"keyframe": "数・色・ベクトルの値は {\"k\":[{\"f\",\"v\",\"e\"}], \"loop\", \"wiggle\", \"ignore_mid\"} のキーフレームにできる(animatable: true のもの)",
    "optional": "optional: true の項目は、書かなければ default ではなく「無し」として扱われる(フォームでは空欄を許す)", "cheap": "effects.*.cheap = true のものはレンダーターゲットを使わない(シェーダと行列だけ)",
    "presets": "apply のキーはレイヤーの点つきの道。\"effects+\" は effects の末尾に足す。{\"relative\": true} のキーフレームは f をレイヤーの in からの相対コマとして足して使う(\"out\" はレイヤーの長さ)",
    "aliases": "effect_aliases の左の名前でも同じエフェクトとして読む"},
    "effects": E, "effect_aliases": ALIASES, "mask": MASK, "layer_types": LT, "layer_common": COMMON,
    "blend_modes": [{"value": v, "label": l} for v, l in BLENDS], "easings": [{"value": v, "label": l} for v, l in EAS], "presets": PRESETS}
def when(table, key, cond_key, values):
    if key in table: table[key]["when"] = {cond_key: values}
SH = LT["shape"]["source"]
for k, kinds in {"sides": ["polygon", "star", "burst"], "inner": ["star", "ring", "flower", "burst"], "start": ["arc", "pie", "ring"], "end": ["arc", "pie", "ring"], "thickness": ["chevron", "cross"],
                 "head": ["arrow"], "shaft": ["arrow"], "petals": ["flower"], "jitter": ["burst"], "seed": ["burst"], "points": ["line", "path"], "closed": ["path"], "morph_to": ["path"], "morph": ["path"],
                 "radius": ["rect", "polygon", "star", "path", "bubble"]}.items(): when(SH, k, "kind", kinds)
PAT_WHEN = {"stagger": ["dots", "halftone"], "slope": ["yagasuri"], "rings": ["seigaiha"], "count": ["rays"], "jitter": ["rays"], "inner": ["rays"], "amplitude": ["waves", "zigzag"], "wavelength": ["waves"],
            "contrast": ["noise"], "seed": ["noise", "grain", "rays"], "grad_angle": ["halftone"], "grad_length": ["halftone"], "dot_min": ["halftone"], "dot_max": ["halftone"],
            "line_width": ["stripes", "dots", "grid", "hex", "asanoha", "seigaiha", "shippo", "kagome"], "ratio": ["stripes", "triangles", "uroko", "yagasuri", "seigaiha", "rays", "zigzag"]}
for k, kinds in PAT_WHEN.items(): when(LT["pattern"]["source"], k, "kind", kinds)
for side in ("transition_in", "transition_out"):
    for k, types in {"direction": ["slide"], "distance": ["slide"], "angle": ["wipe", "blinds"], "pitch": ["blinds"], "shape": ["iris"], "from": ["zoom"], "radius": ["blur"], "side": ["clip"],
                     "feather": ["wipe", "clip", "iris", "radial", "blinds"]}.items(): when(COMMON, f"{side}.{k}", f"{side}.type", types)
for k in list(COMMON):
    for m in ("grid", "radial", "random"):
        if k.startswith(f"repeater.{m}."): when(COMMON, k, "repeater.mode", [m])
RP = E["repeat"]["params"]
for k, modes in {"count_y": ["grid"], "gap_y": ["grid"], "spacing_x": ["grid"], "spacing_y": ["grid"], "stagger_rows": ["grid"], "scroll_x": ["grid"], "scroll_y": ["grid"], "mirror": ["grid"],
                 "angle": ["line", "circle"], "radius": ["circle"], "sweep": ["circle"], "rotate": ["circle"], "both": ["line"],
                 "area_x": ["random"], "area_y": ["random"], "seed": ["random"], "random_rotation": ["random"], "scale_min": ["random"], "scale_max": ["random"]}.items(): when(RP, k, "mode", modes)
when(E["iris"]["params"], "sides", "shape", ["star", "polygon"]); when(E["iris"]["params"], "inner", "shape", ["star"]); when(E["mask_shape"]["params"], "radius", "shape", ["rect"])
schema["notes"]["when"] = "when: {\"<項目名>\": [値...]} = 同じ一覧の中のその項目が、どれかの値のときだけ効く(layer_common では点つきの道そのまま。例 transition_in.type / repeater.mode)。値が * = その項目が書かれているとき。編集画面が関係ない項目を隠すための目安で、エンジンは見ない"
schema["notes"]["scope"] = "type: scope = 数(下の N 層。0 = 下すべて)か、レイヤー id の配列。type: layers = レイヤー id の配列。type: numbers = 数の配列"
import os
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'schema.json')
json.dump(schema, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(out, len(E), 'effects', len(LT), 'layer types', len(COMMON), 'common', len(EAS), 'easings')
