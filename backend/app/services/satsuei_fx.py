"""
🎬 撮影レイヤー — タイムラインで手で直せる撮影処理(色・パラ・ライトリーク・レンズ・粒子)の計算(2026-10-16、段階 1)。

撮影クリップ = kind 'satsuei' のフィルタークリップ(素材なし)。そのクリップより下に重なった絵ぜんぶに効く。
設定は attrs_json {"satsuei": {...}}(SatsueiParams v1。normalize で既定値を補い、範囲にそろえる)と
{"strength_keys": [{"t", "v"}]}(効きの強さ。blur_keys と同じ規則)。数式は試作
outputs/pocky2026/v13/fix1016/satsuei/looks.py・segments.py・satsuei_render.py の auto_fit と同じ
(ユーザーが見て気に入った絵)。プレビュー(satsueiGL.ts の WebGL)も同じ式・同じ 65³ の表で描く。

1 コマの順番(光の通り道の順)。x = 下の絵(BT.709 のガンマのかかった RGB 0..1):
  ① 空気: パラ(グラデーション)→ ライトリーク(時間で咲いて戻る光。線形の光で足す = 暗くならない)
  ② レンズ: にじみ(diffusion)→ 光のにじみ(bloom、線形の光)→ ハレーション → 色ずれ → 周辺減光
  ③ 色: 露出・Lift/Gamma/Gain・影とハイライトの色・コントラスト・白の肩・彩度(空・肌の保護)を焼いた 3D LUT(三線形補間)
  ④ 粒子: 白黒の粒(コマごとに変わる。書き出しはクリップ id とコマから決まる乱数)
  ⑤ 効き: out = x_in + (x − x_in)·m(m = 不透明度 × strength_keys。0.001 以下は何もしない)
ぼかし・粒の大きさは 1080p の高さ基準の px(作用する範囲の高さ H で H/1080 倍)、色ずれは 1920 幅基準。
同じトラックの撮影クリップが重なり、後のクリップに transition_in があれば、重なりの頭 transition_frames コマで
2 つの結果を混ぜる(生成の 1 本の中で溶けて替わるカットに、色の切り替えを合わせるため)。

書き出しはサブプロセスで計算する: python -m app.services.satsuei_fx render <plan.json>
(元の絵を rgb24 で読み、撮影クリップのかかるコマだけ計算し、ロスレスで書く。進み具合は PROGRESS 行)。
"""
from __future__ import annotations

import copy
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from fractions import Fraction
from collections import OrderedDict, deque
from pathlib import Path
from typing import Any, Callable, Optional

import cv2
import numpy as np

LUT_N = 65
LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)    # BT.709(RGB の順)
_LUMA_M = LUMA.reshape(1, 3)                               # cv2.transform 用(3ch → 1ch)
SKY_HUES = (190.0, 230.0)                                  # 空の色相(度)
SKIN_HUES = (330.0, 30.0)                                  # 肌・赤い髪(0 度をまたぐ)
BLOOM_SIGMAS = (17.0, 56.0, 141.0)                         # 1080p 基準(試作の [12, 40, 100] @768 × 1080/768)
BLOOM_WEIGHTS = (0.5, 0.3, 0.2)
HALATION_COLOR = np.array([1.0, 0.35, 0.12], np.float32)   # 強い光の縁の赤橙
MIX_EPS = 0.001                                            # これ以下の効きは何もしない(そのまま通す)
BLENDS = ("screen", "multiply", "normal")
EASES = ("linear", "ease", "ease-in", "ease-out")

# ── 設定(SatsueiParams v1) ──────────────────────────────────────────────────
DEFAULT: dict = {
    "v": 1,
    "preset": "",                    # 最後に当てたプリセットの名前(表示用。計算には使わない)
    "color": {
        "exposure": 0.0,             # 段(stop)
        "lift": 0.0,                 # 黒の持ち上げ
        "gamma": 1.0,                # 指数(1 より小さいと中間が明るい。looks.py と同じ)
        "gain": 1.0,                 # 白の強さ
        "shadow_tint": [0.0, 0.0, 0.0],      # 影の色(RGB で足す)
        "highlight_tint": [0.0, 0.0, 0.0],   # ハイライトの色
        "contrast": 0.0,
        "pivot": 0.45,
        "shoulder": 1.0,             # 白の肩(1 = なし)
        "sat": 1.0,
        "vibrance": 0.0,             # 自然な彩度(色の薄い所ほど効く)
        "protect_sky": False,        # 空の色(色相 190〜230 度)の彩度を下げない
        "protect_skin": False,       # 肌・赤い髪(330〜30 度)の彩度を下げない
        "protect": 1.0,              # 守る強さ
    },
    "lens": {
        "diffusion": {"amt": 0.0, "sigma": 11.0},
        "bloom": {"amt": 0.0, "thr": 0.8, "knee": 0.1, "tint": [1.0, 1.0, 1.0]},
        "halation": {"amt": 0.0, "thr": 0.9, "sigma": 8.0},
        "ca": 0.0,                   # 色ずれ(1920 幅で px)
        "vignette": 0.0,
    },
    "para": [],                      # 最大 4 本
    "leaks": [],                     # 最大 8 個
    "grain": {"amt": 0.0, "size": 1.0},
    "fit": None,                     # 自動で合わせたときの記録(計算には使わない)
}
# リストの 1 項目の既定値(足すときの出発点。looks.py の既定と同じ)
PARA_DEFAULT: dict = {"from": [0.5, 0.0], "to": [0.5, 0.6], "color": "#bfe6ff", "blend": "screen", "amt": 0.1}
LEAK_DEFAULT: dict = {"t0": 0, "attack": 6, "hold": 4, "release": 14, "path": [[0.9, 0.1]], "size": [0.45, 0.35],
                      "color": "#ffd2a0", "amt": 0.2}

# 範囲 [下限, 上限]。リスト(tint など)は要素ごとに同じ範囲。para / leaks は 1 項目の範囲と項目数の上限。
# 位置(パラの向き・リークの通り道)は画面の外から差し込む光のため、少しはみ出してよい(試作 C15 のリークは 1.05, −0.05)。
RANGES: dict = {
    "color": {
        "exposure": [-2.0, 2.0], "lift": [-0.2, 0.3], "gamma": [0.5, 1.6], "gain": [0.5, 1.5],
        "shadow_tint": [-0.1, 0.1], "highlight_tint": [-0.1, 0.1], "contrast": [-0.5, 0.5], "pivot": [0.1, 0.9],
        "shoulder": [0.6, 1.0], "sat": [0.0, 2.0], "vibrance": [-1.0, 1.0], "protect": [0.0, 1.0],
    },
    "lens": {
        "diffusion": {"amt": [0.0, 1.0], "sigma": [1.0, 60.0]},
        "bloom": {"amt": [0.0, 1.0], "thr": [0.3, 1.0], "knee": [0.01, 0.5], "tint": [0.0, 2.0]},
        "halation": {"amt": [0.0, 0.5], "thr": [0.5, 1.0], "sigma": [1.0, 40.0]},
        "ca": [0.0, 8.0],
        "vignette": [0.0, 1.0],
    },
    "para": {"max": 4, "from": [-0.5, 1.5], "to": [-0.5, 1.5], "amt": [0.0, 1.0], "blend": list(BLENDS),
             "default": PARA_DEFAULT},
    "leaks": {"max": 8, "t0": [-100000, 100000], "attack": [1, 240], "hold": [0, 2400], "release": [1, 480],
              "path": [-0.5, 1.5], "path_max": 16, "size": [0.02, 2.0], "amt": [0.0, 1.0], "default": LEAK_DEFAULT},
    "grain": {"amt": [0.0, 0.1], "size": [0.5, 4.0]},
}

_HEX = re.compile(r"#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})")


def _num(v: Any, default: float, lo: float, hi: float) -> float:
    if isinstance(v, bool) or v is None:
        return float(default)
    try:
        f = float(v)
    except (TypeError, ValueError, OverflowError):   # 大きすぎる整数(JSON の 1e400 相当)も読めない数として扱う
        return float(default)
    if not math.isfinite(f):
        return float(default)
    return round(min(float(hi), max(float(lo), f)), 6)


def _finite(a) -> bool:
    """有限の数か(float にできない大きすぎる整数は有限でないとみなす)。"""
    try:
        return math.isfinite(float(a))
    except (TypeError, ValueError, OverflowError):
        return False


def _vec(v: Any, default: list, lo: float, hi: float) -> list[float]:
    n = len(default)
    if isinstance(v, (int, float)) and not isinstance(v, bool) and n == 2:   # 大きさの 1 つの数 = 縦横同じ
        v = [v, v]
    if not isinstance(v, (list, tuple)) or len(v) != n:
        return [float(d) for d in default]
    return [_num(a, d, lo, hi) for a, d in zip(v, default)]


def _point(v: Any, lo: float, hi: float) -> Optional[list[float]]:
    """[x, y] の 2 つの数(画面の割合)。読めなければ None。"""
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        return None
    out = []
    for a in v:
        if isinstance(a, bool) or not isinstance(a, (int, float)) or not _finite(a):
            return None
        out.append(round(min(hi, max(lo, float(a))), 6))
    return out


def _color(v: Any, default: str) -> str:
    if isinstance(v, str):
        m = _HEX.fullmatch(v.strip())
        if m:
            s = m.group(1)
            if len(s) == 3:
                s = "".join(ch * 2 for ch in s)
            return "#" + s.lower()
    return default


def _norm_dict(raw: Any, default: dict, ranges: dict) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    out: dict = {}
    for k, d in default.items():
        v = raw.get(k, d)
        r = ranges.get(k)
        if isinstance(d, dict):
            out[k] = _norm_dict(v, d, r or {})
        elif isinstance(d, bool):
            out[k] = v if isinstance(v, bool) else (bool(v) if isinstance(v, (int, float)) and _finite(v) else d)
        elif isinstance(d, list):
            out[k] = _vec(v, d, r[0], r[1])
        else:
            out[k] = _num(v, d, r[0], r[1])
    return out


def _norm_para(p: Any) -> Optional[dict]:
    if not isinstance(p, dict):
        return None
    R, D = RANGES["para"], PARA_DEFAULT
    fr = _point(p.get("from", D["from"]), *R["from"])
    to = _point(p.get("to", D["to"]), *R["to"])
    if fr is None or to is None:
        return None
    blend = p.get("blend", D["blend"])
    return {"from": fr, "to": to, "color": _color(p.get("color"), D["color"]),
            "blend": blend if blend in BLENDS else "screen", "amt": _num(p.get("amt", D["amt"]), D["amt"], *R["amt"])}


def _norm_leak(e: Any) -> Optional[dict]:
    if not isinstance(e, dict):
        return None
    R, D = RANGES["leaks"], LEAK_DEFAULT
    raw = e.get("path", D["path"])
    if _point(raw, *R["path"]) is not None:          # [x, y] 1 点だけ
        raw = [raw]
    pts = [q for q in (_point(a, *R["path"]) for a in raw) if q is not None] if isinstance(raw, (list, tuple)) else []
    return {"t0": _num(e.get("t0", D["t0"]), D["t0"], *R["t0"]),
            "attack": _num(e.get("attack", D["attack"]), D["attack"], *R["attack"]),
            "hold": _num(e.get("hold", D["hold"]), D["hold"], *R["hold"]),
            "release": _num(e.get("release", D["release"]), D["release"], *R["release"]),
            "path": (pts or copy.deepcopy(D["path"]))[:R["path_max"]],
            "size": _vec(e.get("size", D["size"]), D["size"], *R["size"]),
            "color": _color(e.get("color"), D["color"]),
            "amt": _num(e.get("amt", D["amt"]), D["amt"], *R["amt"])}


def normalize(params: dict | None) -> dict:
    """設定を正規化する(DEFAULT に重ね、型・範囲をそろえる)。読めない項目は既定値、読めないリストの項目は捨てる。
    パラは 4 本、リークは 8 個まで。一番上の知らないキーは残す(段階 2 の設定のため)。何度かけても同じ結果。"""
    raw = params if isinstance(params, dict) else {}
    out: dict = {"v": 1}
    p = raw.get("preset", "")
    out["preset"] = p[:64] if isinstance(p, str) else ""
    out["color"] = _norm_dict(raw.get("color"), DEFAULT["color"], RANGES["color"])
    out["lens"] = _norm_dict(raw.get("lens"), DEFAULT["lens"], RANGES["lens"])
    para = raw.get("para") if isinstance(raw.get("para"), list) else []
    out["para"] = [q for q in map(_norm_para, para) if q is not None][:RANGES["para"]["max"]]
    leaks = raw.get("leaks") if isinstance(raw.get("leaks"), list) else []
    out["leaks"] = [q for q in map(_norm_leak, leaks) if q is not None][:RANGES["leaks"]["max"]]
    out["grain"] = _norm_dict(raw.get("grain"), DEFAULT["grain"], RANGES["grain"])
    fit = raw.get("fit")
    out["fit"] = copy.deepcopy(fit) if isinstance(fit, dict) else None
    for k, v in raw.items():
        if k not in DEFAULT:
            out[k] = copy.deepcopy(v)
    return out


# ── プリセット(試作 presets.py から。試作のぼかしは 768 の高さ基準なので ×1080/768) ──────────────
_PRESET_SRC: dict[str, tuple[str, dict, Optional[list[float]]]] = {
    # ba_sunny の lift は試作の 0.06 → 0.02(10/17)。自動で合わせると 32 本すべてが下の端(0.06−0.02)まで下がっていた
    # (プリセットが自分の目標より明るい)。0.02 なら下の端が 0 = 暗い服・髪が浮かない。空気感はガンマ・パラ・にじみで出る
    "ba_sunny": ("ブルアカ風(晴れ)", {
        "color": {"lift": 0.02, "shadow_tint": [-0.010, 0.005, 0.035], "gamma": 0.88, "contrast": -0.08, "shoulder": 0.82,
                  "sat": 0.92, "protect_sky": True, "protect_skin": True},
        "lens": {"bloom": {"amt": 0.22, "thr": 0.78, "knee": 0.12, "tint": [0.96, 1.0, 1.05]},
                 "diffusion": {"amt": 0.12, "sigma": 11}},
        "para": [{"from": [0.5, 0.0], "to": [0.5, 0.6], "color": "#bfe6ff", "blend": "screen", "amt": 0.10}],
    }, [0.26, 0.62]),   # ブルアカ PV の実測は 0.296 / 0.685
    "rain_morning": ("雨の朝", {
        "color": {"lift": 0.03, "shadow_tint": [-0.005, 0.0, 0.02], "gamma": 0.94, "shoulder": 0.85, "sat": 0.95,
                  "protect_sky": True, "protect_skin": True},
        "lens": {"bloom": {"amt": 0.10, "thr": 0.8, "knee": 0.12}, "diffusion": {"amt": 0.08, "sigma": 11}},
        "para": [{"from": [0.5, 0.0], "to": [0.5, 0.55], "color": "#cfe8ff", "blend": "screen", "amt": 0.08}],
    }, [0.17, 0.42]),
    "rain_day": ("雨の昼", {
        "color": {"lift": 0.03, "shadow_tint": [-0.004, 0.0, 0.015], "gamma": 0.93, "shoulder": 0.85, "sat": 0.95,
                  "protect_sky": True, "protect_skin": True},
        "lens": {"bloom": {"amt": 0.10, "thr": 0.8, "knee": 0.12}, "diffusion": {"amt": 0.08, "sigma": 11}},
    }, [0.20, 0.45]),
    "rain_night": ("雨の夜", {
        "color": {"lift": 0.0, "shadow_tint": [-0.005, 0.004, 0.012], "gamma": 1.0, "shoulder": 0.88, "sat": 0.92,
                  "protect_skin": True},
        "lens": {"bloom": {"amt": 0.18, "thr": 0.88, "knee": 0.08, "tint": [1.0, 0.98, 0.95]},
                 "halation": {"amt": 0.04, "thr": 0.93, "sigma": 7}, "diffusion": {"amt": 0.06, "sigma": 8}},
        "para": [{"from": [0.5, 1.0], "to": [0.5, 0.45], "color": "#1a2a55", "blend": "multiply", "amt": 0.10}],
    }, [0.10, 0.28]),
    # 10/17 E2E で足したもの(ba_sunny では夕日が薄く、教会の中の暗部が浮いた)
    "sunset": ("夕焼け", {
        "color": {"lift": 0.02, "gamma": 0.95, "contrast": 0.0, "shoulder": 0.85, "sat": 1.02,
                  "highlight_tint": [0.020, 0.006, -0.018], "shadow_tint": [-0.004, -0.002, 0.012], "protect_skin": True},
        "lens": {"bloom": {"amt": 0.18, "thr": 0.75, "knee": 0.12, "tint": [1.06, 0.98, 0.88]},
                 "diffusion": {"amt": 0.06, "sigma": 11}},
        "para": [{"from": [0.5, 0.0], "to": [0.5, 0.55], "color": "#ffd2a0", "blend": "screen", "amt": 0.06}],
    }, [0.12, 0.40]),
    "interior": ("室内(暗め)", {
        "color": {"lift": 0.0, "gamma": 0.96, "shoulder": 0.86, "sat": 1.0, "highlight_tint": [0.010, 0.004, -0.010],
                  "protect_skin": True},
        "lens": {"bloom": {"amt": 0.16, "thr": 0.80, "knee": 0.10, "tint": [1.04, 1.0, 0.94]},
                 "halation": {"amt": 0.03, "thr": 0.92, "sigma": 7}, "diffusion": {"amt": 0.05, "sigma": 9}},
    }, [0.05, 0.30]),
    "neutral": ("なし(素のまま)", {}, None),
}
PRESETS: dict[str, dict] = {
    name: {"label": label, "params": normalize({**src, "preset": name}), "target": target}
    for name, (label, src, target) in _PRESET_SRC.items()
}


def preset_params(name: str) -> dict:
    """プリセットの設定(写し)。知らない名前は KeyError。"""
    return copy.deepcopy(PRESETS[name]["params"])


# ── 色(③): 65³ の 3D LUT ─────────────────────────────────────────────────────

def _hue(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = np.max(rgb, -1); mn = np.min(rgb, -1); d = mx - mn + 1e-6
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    return h, (mx - mn) / (mx + 1e-6)


def _protect_hues(C: dict) -> list[tuple[float, float]]:
    return ([SKY_HUES] if C["protect_sky"] else []) + ([SKIN_HUES] if C["protect_skin"] else [])


TOE = 0.10        # 黒の近く: 黒の持ち上げ・影の色・コントラストを、この明るさより下でなめらかに 0 へ弱める(上は前と同じ式)
WHITE_EPS = 1e-4  # 白の肩: 白(1,1,1)が肩の始まり + これより上なら tanh で丸めて 1 へ、届かなければ直線で 1 へ


def _toe(x: np.ndarray) -> np.ndarray:
    """smoothstep(0, TOE, x): 0 以下で 0、TOE 以上で 1。"""
    t = np.clip(x * np.float32(1 / TOE), 0, 1)
    return t * t * (3 - 2 * t)


def _tone(x: np.ndarray, C: dict) -> np.ndarray:
    """露出 → Lift/Gamma/Gain → 影とハイライトの色 → コントラスト(白の肩の手前まで)。x = 0..1 に切った float32。
    黒の持ち上げ・影の色・コントラストは黒の近く(TOE より下)で弱める: 真っ黒は真っ黒のまま(10/17 E2E: ba_sunny で黒が
    RGB 27/30/36 の灰色になり、教会の天井(734 コマ)の暗部が明るさ 7 → 36 に浮いた)。TOE より上は試作の式と同じ。"""
    if C["exposure"]:
        x = x * (2.0 ** C["exposure"])
    # Lift / Gamma / Gain(gamma は指数)。Lift = x + lift·(1−x)·toe(x)(0.10 より上は x·(1−lift)+lift と同じ。0 は 0 のまま)
    lift, gam, gain = [np.broadcast_to(np.asarray(C[k], np.float32), (3,)) for k in ("lift", "gamma", "gain")]
    x = x + lift * (1 - x) * _toe(x)
    x = gain * np.power(np.clip(x, 0, None), gam)
    # 影とハイライトの色(明るさで重みを付けて足す。影の色は真っ黒には付けない)
    Y = (x * LUMA).sum(-1, keepdims=True)
    st, ht = np.asarray(C["shadow_tint"], np.float32), np.asarray(C["highlight_tint"], np.float32)
    ws = np.clip(1 - Y, 0, 1) ** 2 * _toe(Y)
    x = x + st * ws + ht * np.clip(Y, 0, 1) ** 2
    # コントラスト(pivot のまわり。黒の近くでは弱める = 下げたコントラストで黒が浮かない)
    if C["contrast"]:
        x = x + C["contrast"] * (x - C["pivot"]) * _toe(x)
    return x


def _white(C: dict) -> np.ndarray:
    """白(1,1,1)が白の肩の手前で取る値(チャンネルごと、float32 [3])。"""
    return _tone(np.ones((1, 3), np.float32), C)[0]


def _shoulder(x: np.ndarray, k: float, w: np.ndarray) -> np.ndarray:
    """白の肩(k より上をやわらかく丸める)。チャンネルごとに、白が来る値 w_c をちょうど 1 にする
    (前は肩が 1 に届かず、白い光・フラッシュ・白への溶けが薄い灰色になった: ba_sunny で白 = 238/255)。
    w_c > k: k + (1−k)·tanh((x−k)/(1−k)) / tanh((w_c−k)/(1−k))。
    w_c ≤ k(露出・白の強さを下げて白が肩まで届かない): 肩の始まりを k·w_c に下げ、その上を直線で伸ばして w_c → 1。"""
    out = x.copy()
    k32, omk = np.float32(k), np.float32(1 - k)
    for c in range(3):
        wc, xc = np.float32(w[c]), x[..., c]
        if float(wc) > float(k32) + WHITE_EPS:
            den = np.tanh((wc - k32) / omk)
            out[..., c] = np.where(xc > k32, k32 + omk * np.tanh((xc - k32) / omk) / den, xc)
        elif float(wc) > 1e-3:
            a = k32 * wc
            sc = (1 - a) / (wc - a)
            out[..., c] = np.where(xc > a, a + (xc - a) * sc, xc)
        else:                                   # 白がほぼ黒(ふつうは無い設定): 1 にはそろえず前の肩だけ
            out[..., c] = np.where(xc > k32, k32 + omk * np.tanh((xc - k32) / omk), xc)
    return out


def color_ops(rgb: np.ndarray, color: dict) -> np.ndarray:
    """rgb [..., 3] 0..1 に色の処理を順にかける(LUT に焼く中身)。color = 正規化済みの params["color"]。
    試作 looks.py color_ops からの変更(10/17): 黒の近くで Lift・影の色・コントラストを弱める(_tone)、白の肩で白をちょうど
    1 にする(_shoulder)。ほかは同じ式。試作の「保護の地図を 1px ぼかす」は 2 次元の絵のときだけの処理で、
    LUT(3 次元の格子)では使われないので持たない。"""
    C = color
    x = _tone(np.clip(rgb, 0, 1).astype(np.float32), C)
    # 白の肩(shoulder より上をやわらかく丸める = 白を切り落とさない。白はちょうど 1 へ)
    k = C["shoulder"]
    if k < 1.0:
        x = _shoulder(x, k, _white(C))
    # 彩度(色相の保護つき)と自然な彩度
    Y = (x * LUMA).sum(-1, keepdims=True)
    h, s = _hue(np.clip(x, 0, 1))
    prot = np.zeros(h.shape, np.float32)
    for a, b in _protect_hues(C):
        inside = ((h >= a) & (h <= b)) if a <= b else ((h >= a) | (h <= b))
        prot = np.maximum(prot, inside.astype(np.float32))
    sat = 1 + (C["sat"] - 1) * (1 - C["protect"] * prot)[..., None]
    if C["vibrance"]:
        sat = sat * (1 + C["vibrance"] * (1 - np.clip(s, 0, 1))[..., None])
    x = Y + (x - Y) * sat
    return np.clip(x, 0, 1)


def build_lut(params: dict, n: int = LUT_N) -> np.ndarray:
    """色の処理を焼いた 3D LUT [n(b), n(g), n(r), 3] float32(赤が最も速く変わる = .cube と同じ並び)。"""
    C = normalize(params)["color"]
    g = np.linspace(0, 1, n, dtype=np.float32)
    b, gg, r = np.meshgrid(g, g, g, indexing="ij")
    grid = np.stack([r, gg, b], -1)
    return color_ops(grid, C).astype(np.float32)


def _color_is_identity(C: dict) -> bool:
    """色の設定が既定のまま(LUT が素通し)なら表を引かない(速さのため。差は 1e-7 程度)。"""
    D = DEFAULT["color"]
    return all(C[k] == D[k] for k in D if k not in ("protect_sky", "protect_skin", "protect", "pivot")) \
        and (C["contrast"] == 0)


def lut_key(params: dict) -> str:
    return json.dumps(params.get("color") or {}, sort_keys=True)


def _cached_lut(P: dict, cache: Optional[dict]) -> np.ndarray:
    if cache is None:
        return build_lut(P)
    key = "lut:" + lut_key(P)
    lut = cache.get(key)
    if lut is None:
        if len(cache) > 64:                    # 使い捨ての表がたまり続けないように
            for k in [k for k in cache if isinstance(k, str) and k.startswith("lut:")][:32]:
                cache.pop(k, None)
        lut = cache[key] = build_lut(P)
    return lut


_LUT_STRIP = 1 << 16   # 6.5 万画素ずつ引く(作業用の配列がキャッシュに乗る大きさ)


def apply_lut(rgb: np.ndarray, lut: np.ndarray) -> np.ndarray:
    """三線形補間で LUT を引く(looks.py apply_lut と同じ値。平らにした表から 8 隅を集める)。rgb [h, w, 3] 0..1。"""
    n = lut.shape[0]
    shp = rgb.shape
    src = np.ascontiguousarray(rgb, dtype=np.float32).reshape(-1, 3)
    out = np.empty_like(src)
    flat = [np.ascontiguousarray(lut[..., c]).ravel() for c in range(3)]
    nn = n * n
    offs = (0, 1, n, n + 1, nn, nn + 1, nn + n, nn + n + 1)
    sc = np.float32(n - 1)
    for a in range(0, src.shape[0], _LUT_STRIP):
        p = np.clip(src[a:a + _LUT_STRIP], 0, 1) * sc
        i0 = np.minimum(p.astype(np.intp), n - 2)
        f = p - i0.astype(np.float32)
        fr, fg, fb = f[:, 0], f[:, 1], f[:, 2]
        base = (i0[:, 2] * n + i0[:, 1]) * n + i0[:, 0]
        idx = [base + o for o in offs]
        for c in range(3):
            L = flat[c]
            c00 = np.take(L, idx[0]); c00 += (np.take(L, idx[1]) - c00) * fr
            c01 = np.take(L, idx[2]); c01 += (np.take(L, idx[3]) - c01) * fr
            c10 = np.take(L, idx[4]); c10 += (np.take(L, idx[5]) - c10) * fr
            c11 = np.take(L, idx[6]); c11 += (np.take(L, idx[7]) - c11) * fr
            c00 += (c01 - c00) * fg
            c10 += (c11 - c10) * fg
            c00 += (c10 - c00) * fb
            out[a:a + _LUT_STRIP, c] = c00
    return out.reshape(shp)


# ── 共通の部品 ───────────────────────────────────────────────────────────────

class _SizeCache:
    """大きさごとの座標・周辺減光の地図(毎コマ作り直さない)。API のスレッドからも呼ばれるので鍵をかける。"""

    def __init__(self, cap: int = 8):
        self.cap = cap
        self.d: OrderedDict = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key, make):
        with self.lock:
            v = self.d.get(key)
            if v is not None:
                self.d.move_to_end(key)
                return v
        v = make()
        with self.lock:
            self.d[key] = v
            while len(self.d) > self.cap:
                self.d.popitem(last=False)
        return v


_GRIDS = _SizeCache()


def _uv(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    """u = x/w([w])、v = y/h([h, 1])。looks.py と同じ(画素の左上の位置)。"""
    return _GRIDS.get(("uv", h, w), lambda: ((np.arange(w, dtype=np.float32) / np.float32(w)),
                                             (np.arange(h, dtype=np.float32) / np.float32(h)).reshape(h, 1)))


def _vignette_map(h: int, w: int) -> np.ndarray:
    def make():
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        r = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2) / math.sqrt(2)
        return (np.clip(r, 0, 1) ** 2.2).astype(np.float32)
    return _GRIDS.get(("vig", h, w), make)


def _gauss_kernel(sigma: float) -> np.ndarray:
    def make():
        ks = 2 * int(math.ceil(3 * sigma)) + 1
        return cv2.getGaussianKernel(ks, sigma, cv2.CV_32F)
    return _GRIDS.get(("gk", round(sigma, 4)), make)


def to_lin(x: np.ndarray) -> np.ndarray:
    """ガンマ → 線形の光(BT.1886 の逆 ≈ 2.4 乗)。0..1 に切る。"""
    return cv2.pow(np.clip(x, 0, 1).astype(np.float32, copy=False), 2.4)


def to_gam(x: np.ndarray) -> np.ndarray:
    return cv2.pow(np.clip(x, 0, 1).astype(np.float32, copy=False), 1 / 2.4)


def _luma(x: np.ndarray) -> np.ndarray:
    """[h, w, 3] → [h, w] の BT.709 の明るさ。"""
    return cv2.transform(np.ascontiguousarray(x, dtype=np.float32), _LUMA_M)


def _hex_rgb(c: str) -> np.ndarray:
    return np.array([int(c[k:k + 2], 16) / 255 for k in (1, 3, 5)], np.float32)


def _blur_pyr(img: np.ndarray, sigma: float) -> np.ndarray:
    """大きなぼかしは縮めてから(looks.py _blur_pyr と同じ: 縮める倍率 s = σ // 6、面積で縮め、σ/s でぼかし、線形で戻す)。"""
    if sigma < 0.05:
        return img
    s = max(1, int(sigma // 6)); h, w = img.shape[:2]
    small = cv2.resize(img, (max(1, w // s), max(1, h // s)), interpolation=cv2.INTER_AREA) if s > 1 else img
    b = cv2.GaussianBlur(small, (0, 0), sigma / s)
    return cv2.resize(b, (w, h), interpolation=cv2.INTER_LINEAR) if s > 1 else b


def env(i: float, ev: dict) -> float:
    """ライトリークの包絡線(立ち上がり・保持・戻り)。足し算だけ = 暗くならない。"""
    t = i - ev["t0"]; a, hd, r = ev["attack"], ev["hold"], ev["release"]
    if t < 0 or t > a + hd + r:
        return 0.0
    if t < a:
        return (t / a) ** 1.5
    if t < a + hd:
        return 1.0
    return (1 - (t - a - hd) / r) ** 2


def leak_pos(i: float, ev: dict) -> tuple[float, float]:
    """リークの中心(通り道 path の上を、立ち上がりから戻りまでで端から端へ動く)。"""
    path = ev["path"]
    t = min(1.0, max(0.0, (i - ev["t0"]) / max(1, ev["attack"] + ev["hold"] + ev["release"])))
    if len(path) < 2:
        return float(path[0][0]), float(path[0][1])
    k = t * (len(path) - 1); j = min(len(path) - 2, int(k)); fr = k - j
    return (path[j][0] * (1 - fr) + path[j + 1][0] * fr, path[j][1] * (1 - fr) + path[j + 1][1] * fr)


# ── ① 空気・② レンズ・④ 粒子 ──────────────────────────────────────────────

def _air(x: np.ndarray, P: dict, i: float) -> np.ndarray:
    paras = P["para"]
    leaks = [(ev, e) for ev in P["leaks"] for e in [env(i, ev)] if e > 0]
    if not paras and not leaks:
        return x
    h, w = x.shape[:2]
    u, v = _uv(h, w)
    for p in paras:
        (x0, y0), (x1, y1) = p["from"], p["to"]
        dx, dy = x1 - x0, y1 - y0; ln = dx * dx + dy * dy + 1e-6
        t = np.clip((v - np.float32(y0)) * np.float32(dy / ln) + (u - np.float32(x0)) * np.float32(dx / ln), 0, 1)
        m = ((1 - t) * np.float32(p["amt"]))[..., None]
        col = _hex_rgb(p["color"])
        if p["blend"] == "screen":
            x = 1 - (1 - x) * (1 - m * col)
        elif p["blend"] == "multiply":
            x = x * (1 + m * (col - 1))                # = x·(1 − m + col·m)
        else:
            x = x * (1 - m) + m * col
    if leaks:
        # リークは全部を線形の光で足してから 1 回だけガンマへ戻す(1 個ずつ戻すのと同じ値: 光は足すだけなので)
        lin = to_lin(x)
        for ev, e in leaks:
            cx, cy = leak_pos(i, ev)
            rx, ry = ev["size"]
            gx = np.exp(-((u - np.float32(cx)) / np.float32(rx)) ** 2)
            gy = np.exp(-((v - np.float32(cy)) / np.float32(ry)) ** 2)
            col = to_lin(_hex_rgb(ev["color"]).reshape(1, 1, 3)).reshape(3) * np.float32(ev["amt"] * e)
            lin += (gy * gx)[..., None] * col
        x = to_gam(lin)
    return np.clip(x, 0, 1)


def _lens(x: np.ndarray, P: dict, h_ref: Optional[float]) -> np.ndarray:
    L = P["lens"]; h, w = x.shape[:2]
    href = float(h if not h_ref else h_ref)
    sc = href / 1080.0
    d = L["diffusion"]
    if d["amt"] > 0:                                    # 全体をやわらかく: 大きくぼかして screen で少し
        bl = _blur_pyr(x, d["sigma"] * sc)
        x = 1 - (1 - x) * (1 - bl * np.float32(d["amt"]))
    b, hl = L["bloom"], L["halation"]
    lin = None
    if b["amt"] > 0:                                    # 明るい所だけ光ってにじむ(線形の光で足す)
        lin = to_lin(x)
        Y = _luma(lin)
        thr = b["thr"]; thr_l = thr ** 2.4
        top = min(1.0, thr + b["knee"]) ** 2.4
        wgt = np.clip((Y - np.float32(thr_l)) * np.float32(1 / max(1e-4, top - thr_l)), 0, 1)
        if float(wgt.max()) > 0:                         # 明るい所が無いコマはぼかさない
            wgt *= wgt
            src = lin * wgt[..., None]
            acc = None
            for sg, wt in zip(BLOOM_SIGMAS, BLOOM_WEIGHTS):
                bb = _blur_pyr(src, sg * sc)
                acc = bb * np.float32(wt) if acc is None else cv2.scaleAdd(bb, wt, acc)
            lin = np.clip(lin + acc * (np.float32(b["amt"]) * np.asarray(b["tint"], np.float32)), 0, 1)
    if hl["amt"] > 0:                                   # 強い光の縁の赤橙のにじみ(夜の光源だけ)
        if lin is None:
            lin = to_lin(x)
        src = np.maximum(_luma(lin) - np.float32(hl["thr"] ** 2.4), 0)
        if float(src.max()) > 0:
            acc = _blur_pyr(src, hl["sigma"] * sc)
            lin = np.clip(lin + acc[..., None] * (np.float32(hl["amt"]) * HALATION_COLOR), 0, 1)
    if lin is not None:
        x = to_gam(lin)
    ca = L["ca"] * (w * href / h) / 1920.0             # 1920 幅基準 → この範囲の px
    if ca > 0:                                          # 色収差: 端ほど赤と青がずれる
        x = np.array(x, np.float32, copy=True)
        c = (w / 2, h / 2)
        for ch, s in ((0, 1 + ca / w), (2, 1 - ca / w)):
            M = cv2.getRotationMatrix2D(c, 0, s)
            x[..., ch] = cv2.warpAffine(np.ascontiguousarray(x[..., ch]), M, (w, h), flags=cv2.INTER_LINEAR,
                                        borderMode=cv2.BORDER_REFLECT)
    if L["vignette"] > 0:
        x = x * (1 - np.float32(L["vignette"]) * _vignette_map(h, w))[..., None]
    return np.clip(x, 0, 1)


def _grain(x: np.ndarray, P: dict, seed: int, h_ref: Optional[float]) -> np.ndarray:
    g = P["grain"]
    if g["amt"] <= 0:
        return x
    h, w = x.shape[:2]
    href = float(h if not h_ref else h_ref)
    n = np.random.default_rng(int(seed) & 0xFFFFFFFF).standard_normal((h, w), dtype=np.float32)
    sg = 0.5 * g["size"] * href / 1080.0
    if sg >= 0.3:
        k = _gauss_kernel(sg)
        n = cv2.sepFilter2D(n, -1, k, k, borderType=cv2.BORDER_REFLECT_101)
        n *= np.float32(1.0 / float((k.astype(np.float64) ** 2).sum()))   # 白い雑音をぼかすと標準偏差は Σk² 倍 → 1 に戻す
    Y = _luma(x)
    a = np.float32(g["amt"]) * (0.35 + 0.65 * 4 * Y * (1 - Y))           # 中間ほど粒が見える(黒と白は控えめ)
    return np.clip(x + (a * n)[..., None], 0, 1)


def air(rgb: np.ndarray, params: dict, i: float) -> np.ndarray:
    """① 空気: パラとライトリーク(i = クリップの頭からのコマ)。"""
    return _air(np.asarray(rgb, np.float32), normalize(params), i)


def lens(rgb: np.ndarray, params: dict, h_ref: Optional[float] = None) -> np.ndarray:
    """② レンズ。h_ref = 大きさの基準にする高さ(既定 = この絵の高さ。ぼかしは h_ref/1080 倍)。"""
    return _lens(np.asarray(rgb, np.float32), normalize(params), h_ref)


def grain(rgb: np.ndarray, params: dict, seed: int, h_ref: Optional[float] = None) -> np.ndarray:
    """④ 粒子。seed が同じなら同じ粒(書き出しは (clip_id·1000003 + f) & 0xffffffff)。"""
    return _grain(np.asarray(rgb, np.float32), normalize(params), seed, h_ref)


def _grade(x: np.ndarray, P: dict, i: float, f: int, seed: Optional[int], lut: Optional[np.ndarray],
           h_ref: Optional[float]) -> np.ndarray:
    x = _air(x, P, i)
    x = _lens(x, P, h_ref)
    if not _color_is_identity(P["color"]):
        x = apply_lut(x, build_lut(P) if lut is None else lut)
    return _grain(x, P, int(f) if seed is None else seed, h_ref)


def grade(rgb: np.ndarray, params: dict, i: float, f: int = 0, seed: Optional[int] = None,
          lut: Optional[np.ndarray] = None, h_ref: Optional[float] = None) -> np.ndarray:
    """1 コマに ①〜④ をかける(⑤ の効きの混ぜは無し)。rgb float32 [h, w, 3] 0..1(BT.709 ガンマ)。
    i = クリップの頭からのコマ(リーク)、f = タイムラインのコマ、seed = 粒の乱数(None なら f)。
    lut = build_lut(params) を渡せば作り直さない。何もしない設定なら入力をそのまま返すことがある。"""
    return _grade(np.asarray(rgb, np.float32), normalize(params), i, f, seed, lut, h_ref)


# ── クリップとレイヤー(⑤ と重なりの遷移) ───────────────────────────────────

def parse_keys(raw) -> list[tuple[float, float]]:
    """strength_keys([{t, v}] または [[t, v]])→ [(コマ, 値)](昇順・同じコマは後勝ち・値は 0..1)。
    無い・空なら [(0, 1.0)]。ffmpeg_render.parse_filter_keys と同じ規則。"""
    pts: dict[float, float] = {}
    if isinstance(raw, list):
        for k in raw:
            try:
                if isinstance(k, dict):
                    t, v = float(k.get("t", 0)), float(k.get("v", 1.0))
                elif isinstance(k, (list, tuple)) and len(k) >= 2:
                    t, v = float(k[0]), float(k[1])
                else:
                    continue
            except (TypeError, ValueError, OverflowError):
                continue
            if not (math.isfinite(t) and math.isfinite(v)):
                continue
            pts[max(0.0, t)] = max(0.0, min(1.0, v))
    if not pts:
        return [(0.0, 1.0)]
    return sorted(pts.items())


def key_value(keys: list[tuple[float, float]], f: float) -> float:
    """キー列の線形補間(端は保持)。ffmpeg_render.filter_key_value と同じ。"""
    if f <= keys[0][0]:
        return keys[0][1]
    for (f0, v0), (f1, v1) in zip(keys, keys[1:]):
        if f < f1:
            return v0 + (v1 - v0) * (f - f0) / max(1e-6, f1 - f0)
    return keys[-1][1]


def _prepared(spec: dict) -> dict:
    """クリップの指定を計算用にそろえる(設定の正規化・キーの読み取りを毎コマやらない)。"""
    if spec.get("_ready"):
        return spec
    op = spec.get("opacity")
    try:
        op = 1.0 if op is None else float(op)
    except (TypeError, ValueError):
        op = 1.0
    if not math.isfinite(op):
        op = 1.0
    return {**spec, "_ready": True, "id": int(spec.get("id") or 0), "start": int(spec.get("start") or 0),
            "dur": int(spec.get("dur") or 0), "opacity": max(0.0, min(1.0, op)),
            "keys": parse_keys(spec.get("keys")), "params": normalize(spec.get("params")),
            "transition_in": str(spec.get("transition_in") or ""),
            "transition_frames": max(0, int(spec.get("transition_frames") or 0)),
            "transition_ease": str(spec.get("transition_ease") or "linear")}


def prepare_layer(layer_clips: list[dict]) -> list[dict]:
    """1 トラックぶんのクリップの指定をまとめてそろえる(書き出しで毎コマ同じ指定を使うとき)。"""
    return [_prepared(c) for c in layer_clips or []]


def covers(spec: dict, f: int) -> bool:
    s = int(spec.get("start") or 0)
    return s <= f < s + int(spec.get("dur") or 0)


def mix_at(spec: dict, f: int) -> float:
    """タイムラインのコマ f での効き m = 不透明度 × strength_keys(f − start)。範囲の外は 0。"""
    c = _prepared(spec)
    if not covers(c, f):
        return 0.0
    return c["opacity"] * key_value(c["keys"], f - c["start"])


def ease(t: float, kind: Optional[str]) -> float:
    """遷移のカーブ(Clip.transition_ease: linear / ease / ease-in / ease-out。知らない名前は linear)。"""
    t = min(1.0, max(0.0, float(t)))
    if kind == "ease":
        return 2 * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 2 / 2
    if kind == "ease-in":
        return t * t
    if kind == "ease-out":
        return 1 - (1 - t) ** 2
    return t


def spec_from_clip(clip) -> dict:
    """Clip(ORM の行、または同じ名前のキーを持つ dict)→ apply_clip / 書き出しの計画で使う指定。"""
    def g(k, d=None):
        return clip.get(k, d) if isinstance(clip, dict) else getattr(clip, k, d)
    try:
        attrs = json.loads(g("attrs_json") or "{}")
        attrs = attrs if isinstance(attrs, dict) else {}
    except (TypeError, ValueError):
        attrs = {}
    op = g("opacity")
    return {"id": int(g("id") or 0), "start": int(g("start_frame") or 0), "dur": int(g("duration_frames") or 0),
            "opacity": 1.0 if op is None else float(op),
            "keys": [[t, v] for t, v in parse_keys(attrs.get("strength_keys"))],
            "params": normalize(attrs.get("satsuei")),
            "transition_in": g("transition_in") or "", "transition_frames": int(g("transition_frames") or 0),
            "transition_ease": g("transition_ease") or "linear"}


def shift_attrs(attrs: dict | None, d_head: int) -> dict:
    """クリップの頭を d_head コマ後ろへずらした(頭を切った・分けた後ろ側)ときの attrs_json。
    strength_keys は t − d_head(0 より前のキーは捨て、0 の値は補間で残す)、leaks[].t0 も − d_head、
    新しい頭より前に終わるリークは捨てる。d_head < 0(頭を伸ばした)も同じ式でずらす。"""
    out = copy.deepcopy(attrs) if isinstance(attrs, dict) else {}
    d = int(d_head or 0)
    if not d:
        return out
    if isinstance(out.get("strength_keys"), list) and out["strength_keys"]:
        keys = parse_keys(out["strength_keys"])
        moved = [(t - d, v) for t, v in keys if t - d > 0]
        out["strength_keys"] = [{"t": 0, "v": round(key_value(keys, d), 6)}] + [{"t": round(t, 6), "v": v} for t, v in moved]
    s = out.get("satsuei")
    if isinstance(s, dict) and isinstance(s.get("leaks"), list):
        leaks = []
        for ev in s["leaks"]:
            if not isinstance(ev, dict):
                continue
            q = _norm_leak(ev)
            if q is None or q["t0"] + q["attack"] + q["hold"] + q["release"] < d:
                continue
            leaks.append({**ev, "t0": round(q["t0"] - d, 6)})
        s["leaks"] = leaks
    return out


def apply_clip(rgb: np.ndarray, clip_spec: dict, f: int, lut_cache: Optional[dict] = None) -> np.ndarray:
    """1 本の撮影クリップを 1 コマにかける(①〜⑤)。clip_spec = {id, start, dur, opacity, keys, params, ...}
    (コマはタイムライン)。効き m ≤ 0.001・範囲の外は入力をそのまま返す。lut_cache = 表の置き場(dict)。"""
    c = _prepared(clip_spec)
    m = mix_at(c, f)
    if m <= MIX_EPS:
        return rgb
    x_in = np.asarray(rgb, np.float32)
    P = c["params"]
    lut = None if _color_is_identity(P["color"]) else _cached_lut(P, lut_cache)
    seed = (c["id"] * 1000003 + int(f)) & 0xFFFFFFFF
    x = _grade(x_in, P, int(f) - c["start"], f, seed, lut, None)
    if m >= 1.0:
        return x
    return x_in + (x - x_in) * np.float32(m)


def resolve_layer(layer_clips: list[dict], f: int) -> Optional[tuple[Optional[dict], dict, float]]:
    """コマ f で効くクリップを決める → (A, B, k) / None。B だけ効くときは A = None, k = 1。
    重なりでは後に始まるクリップ B が勝つ(同じ頭なら id の大きい方)。B に transition_in があれば
    B の頭から transition_frames コマ(かつ A の終わりまで)は (1−k)·A の結果 + k·B の結果、k = ease(t)。"""
    act = [c for c in layer_clips or [] if covers(c, f)]
    if not act:
        return None
    act.sort(key=lambda c: (int(c.get("start") or 0), int(c.get("id") or 0)))
    b = act[-1]
    tf = max(0, int(b.get("transition_frames") or 0))
    bs = int(b.get("start") or 0)
    if len(act) >= 2 and (b.get("transition_in") or "") and tf > 0 and f < bs + tf:
        return act[-2], b, ease((f - bs) / tf, b.get("transition_ease"))
    return None, b, 1.0


def rect_px(rect, W: int, H: int) -> Optional[tuple[int, int, int, int]]:
    """トラックの配置(割合の x, y, w, h)→ 画素の矩形。ffmpeg_render のフィルターと同じ丸め(偶数)。全画面なら None。"""
    if rect is None:
        return None
    try:
        if isinstance(rect, dict):
            x, y, w, h = (float(rect[k]) for k in ("x", "y", "w", "h"))
        else:
            x, y, w, h = (float(v) for v in rect)
    except (TypeError, ValueError, KeyError):
        return None
    rx = min(W - 2, max(0, int(round(x * W / 2)) * 2))
    ry = min(H - 2, max(0, int(round(y * H / 2)) * 2))
    rw = max(2, min(W - rx, int(round(w * W / 2)) * 2))
    rh = max(2, min(H - ry, int(round(h * H / 2)) * 2))
    if (rx, ry, rw, rh) == (0, 0, W, H):
        return None
    return rx, ry, rw, rh


def _apply_layer_full(x: np.ndarray, layer_clips: list[dict], f: int, lut_cache: Optional[dict]) -> np.ndarray:
    r = resolve_layer(layer_clips, f)
    if r is None:
        return x
    a, b, k = r
    if a is None:
        return apply_clip(x, b, f, lut_cache)
    ga = apply_clip(x, a, f, lut_cache)
    if k <= 0:
        return ga
    gb = apply_clip(x, b, f, lut_cache)
    if ga is gb:
        return ga
    return np.asarray(ga, np.float32) + (np.asarray(gb, np.float32) - ga) * np.float32(k)


def apply_layer(rgb: np.ndarray, layer_clips: list[dict], f: int, lut_cache: Optional[dict] = None,
                rect=None) -> np.ndarray:
    """1 トラックの撮影クリップを 1 コマにかける(どれが効くか・重なりの遷移は resolve_layer)。
    rect = トラックの配置(割合の x, y, w, h。⇔比較表示)があれば、その中だけに効かせる(大きさの基準もその矩形)。
    何もしないコマは入力をそのまま返す。"""
    if not layer_clips:
        return rgb
    H, W = rgb.shape[:2]
    rc = rect_px(rect, W, H)
    if rc is None:
        return _apply_layer_full(rgb, layer_clips, f, lut_cache)
    rx, ry, rw, rh = rc
    sub = np.ascontiguousarray(rgb[ry:ry + rh, rx:rx + rw], dtype=np.float32)
    res = _apply_layer_full(sub, layer_clips, f, lut_cache)
    if res is sub:
        return rgb
    out = np.array(rgb, np.float32, copy=True)
    out[ry:ry + rh, rx:rx + rw] = res
    return out


# ── 数値の欄と自動で合わせる ────────────────────────────────────────────────

def stats(img: np.ndarray, bgr: Optional[bool] = None) -> dict:
    """数値の欄(looks.py stats と同じ): 暗部(5%)・中間・明部(95%)・彩度・白の面積(%)・影の色 B−R。
    uint8 は既定で BGR(cv2 の並び)、float(0..1)は既定で RGB。bgr で指定もできる。"""
    a = np.asarray(img)
    if a.dtype == np.uint8:
        is_bgr = True if bgr is None else bgr
        x = (cv2.cvtColor(a, cv2.COLOR_BGR2RGB) if is_bgr else a).astype(np.float32) / 255
    else:
        is_bgr = False if bgr is None else bgr
        x = a.astype(np.float32)
        if is_bgr:
            x = x[..., ::-1]
    Y = (x * LUMA).sum(-1)
    y05, y50, y95 = np.percentile(Y, [5, 50, 95]); mx, mn = x.max(-1), x.min(-1)
    sat = float(((mx - mn) / (mx + 1e-6)).mean())
    sh = Y < np.percentile(Y, 20); bm = float((x[..., 2] - x[..., 0])[sh].mean()) if sh.any() else 0.0
    return dict(y05=round(float(y05), 3), y50=round(float(y50), 3), y95=round(float(y95), 3), sat=round(sat, 3),
                white=round(float((Y > 0.9).mean() * 100), 1), shadowBR=round(bm, 3))


def _stats_of(rgb: np.ndarray) -> dict:
    # 試作と同じく 8bit に落として(切り捨て)測る
    return stats((np.clip(rgb, 0, 1) * 255).astype(np.uint8), bgr=False)


SAT_CAP = 1.30   # 自動で合わせるときに上げてよい彩度(sat)の上限(プリセットがもっと高ければその値まで)。
                 # 1.15 では 57 本中 49 本が上限で止まり、前の 96% に届かなかった(10/17 E2E)。
                 # 空・肌の色を守る(protect_sky/skin)所は sat が効かないので、それらが多い絵は上げても届かない
PARA_DARK = (0.08, 0.30)   # 暗い絵ではスクリーンのパラを弱める: 効き × clamp((中間 − 0.08) / 0.30, 0, 1)


def auto_fit(params: dict, frame_bgr: np.ndarray, target, k: float = 0.3, iters: int = 4) -> tuple[dict, dict, dict]:
    """場面のまん中のコマで、暗部(y05)と中間(y50)を目標へ k だけ寄せる(satsuei_render.py auto_fit と同じ考え)。
    動かすのは color.lift(L0−0.02〜L0+0.04)と color.gamma(G0−0.05〜G0 = 中間は暗くしない)だけ。
    白い面が 8% を超える絵は、にじみ(diffusion)と光のにじみ(bloom)を 8/白 倍に弱める。
    暗い絵(合わせる前の中間 y50 が 0.38 より下)は、スクリーンのパラ(明るい色を重ねる)を clamp((y50−0.08)/0.30, 0, 1) 倍に
    弱める(夜の室内・夕焼けに空色のもやがかかった 10/17 E2E。乗算・ふつうのパラはそのまま)。
    彩度が前の 96% より下がるなら sat を上げる(SAT_CAP まで。測り直して足りない分をかけ直す、iters 回まで)。
    target = [y05, y50] / None(明るさは動かさない)。
    → (新しい設定(fit に記録つき), 前の数値, 後の数値)。後の数値は縮めた絵(高さ 192)で測る。
    fit には合わせる前の値(lift0・gamma0・sat0・bloom0・diffusion0・para0 = パラの効きの一覧)と合わせた後の値
    (sat1・bloom1・diffusion1・para1)も残す
    (もう一度合わせるときに refit_base で元へ戻すため。何度押しても同じ案になるように)。"""
    P = normalize(params)
    C = P["color"]
    hh, ww = frame_bgr.shape[:2]
    sw = max(1, int(round(192 * ww / hh)))
    rgb = cv2.cvtColor(cv2.resize(frame_bgr, (sw, 192)), cv2.COLOR_BGR2RGB).astype(np.float32) / 255
    L0, G0, S0 = C["lift"], C["gamma"], C["sat"]
    B0, D0 = P["lens"]["bloom"]["amt"], P["lens"]["diffusion"]["amt"]
    A0 = [q["amt"] for q in P["para"]]
    lo_l, hi_l = RANGES["color"]["lift"]; lo_g, hi_g = RANGES["color"]["gamma"]
    s0 = stats(frame_bgr)
    goal = None
    if target is not None:
        goal = [s0["y05"] + k * (float(target[0]) - s0["y05"]), s0["y50"] + k * (float(target[1]) - s0["y50"])]
        bare = copy.deepcopy(P)                         # 色だけ見る(パラ・リーク・にじみ・光のにじみ・粒なし)
        bare["para"], bare["leaks"] = [], []
        bare["lens"]["bloom"]["amt"] = 0.0; bare["lens"]["diffusion"]["amt"] = 0.0; bare["grain"]["amt"] = 0.0
        for _ in range(iters):
            bare["color"] = C
            st = _stats_of(_grade(rgb, bare, 0, 0, 0, None, None))
            # 動かす幅はプリセットのまわりだけ(寄りの明るい絵で黒を浮かせすぎて眠くなった 10/16 C26 の反省)。中間は暗くしない
            C["lift"] = round(float(np.clip(C["lift"] + 0.8 * (goal[0] - st["y05"]), max(lo_l, L0 - 0.02),
                                            min(hi_l, L0 + 0.04))), 6)
            g = C["gamma"] * float(np.exp(-1.2 * (goal[1] - st["y50"])))
            C["gamma"] = round(float(np.clip(g, max(lo_g, G0 - 0.05), min(hi_g, G0))), 6)
    # 白い面がもともと多い絵(寄りの看板など)は、にじみと光のにじみを弱める(白が広がって眠くなるのを防ぐ)
    if s0["white"] > 8:
        fw = 8.0 / s0["white"]
        for key in ("bloom", "diffusion"):
            P["lens"][key]["amt"] = round(P["lens"][key]["amt"] * fw, 6)
    # 暗い絵はスクリーンのパラ(明るい色を重ねる = もや)を弱める。合わせる前の絵の中間で決める
    fp = float(np.clip((s0["y50"] - PARA_DARK[0]) / PARA_DARK[1], 0, 1))
    if fp < 1:
        for q in P["para"]:
            if q["blend"] == "screen":
                q["amt"] = round(q["amt"] * fp, 6)
    # 彩度は、前より 4% 以上は下げない(全部かけて測り、下がりすぎなら sat を上げる)。
    # 黒の持ち上げ・にじみ・パラでも色が薄くなり、sat に比例しないので、1 回では届かない → 測り直して残りをかける
    full = copy.deepcopy(P); full["leaks"] = []; full["grain"]["amt"] = 0.0
    st = _stats_of(_grade(rgb, full, 0, 0, 0, None, None))
    cap = max(SAT_CAP, S0)                              # もともと高い sat を下げることはしない
    for _ in range(max(1, iters)):
        if st["sat"] >= 0.96 * s0["sat"] or C["sat"] >= cap - 1e-6:
            break
        C["sat"] = round(float(min(cap, C["sat"] * max(1.0, 0.96 * s0["sat"] / max(st["sat"], 1e-3)))), 6)
        full["color"] = C
        st = _stats_of(_grade(rgb, full, 0, 0, 0, None, None))
    P["fit"] = {"target": None if target is None else [float(target[0]), float(target[1])], "k": k,
                "goal": None if goal is None else [round(goal[0], 4), round(goal[1], 4)],
                "before": s0, "after": st, "lift0": L0, "gamma0": G0,
                "sat0": S0, "bloom0": B0, "diffusion0": D0, "para0": A0,
                "sat1": C["sat"], "bloom1": P["lens"]["bloom"]["amt"], "diffusion1": P["lens"]["diffusion"]["amt"],
                "para1": [q["amt"] for q in P["para"]],
                # 彩度が前の何倍になったか(0.96 より下 = 上限まで上げても届かなかった)
                "sat_ratio": round(st["sat"] / s0["sat"], 3) if s0["sat"] > 0 else None}
    return normalize(P), s0, st


def refit_base(params: dict) -> dict:
    """もう一度自動で合わせる前に、前に合わせた分を元へ戻した設定(何度押しても同じ案にする)。
    lift・gamma は合わせる前の値へ戻す(自動で合わせるのはこの 2 つ)。sat・bloom・diffusion・パラの効きは、合わせた後に
    手で変えていなければ合わせる前の値へ戻す(手で変えていれば、その値を新しい出発点にする)。パラは本数が合わせたときと
    同じときだけ 1 本ずつ見る(足した・消したなら手で直したとみなしてそのまま)。記録が無ければそのまま。"""
    P = normalize(params)
    fit = P.get("fit") if isinstance(P.get("fit"), dict) else {}
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and _finite(v)  # noqa: E731
    if num(fit.get("lift0")) and num(fit.get("gamma0")):
        P["color"]["lift"], P["color"]["gamma"] = float(fit["lift0"]), float(fit["gamma0"])
    for cur, key in ((P["color"], "sat"), (P["lens"]["bloom"], "bloom"), (P["lens"]["diffusion"], "diffusion")):
        name = "amt" if key != "sat" else "sat"
        v0, v1 = fit.get(key + "0"), fit.get(key + "1")
        if num(v0) and num(v1) and abs(float(cur[name]) - float(v1)) < 1e-6:
            cur[name] = float(v0)
    a0, a1 = fit.get("para0"), fit.get("para1")
    if isinstance(a0, list) and isinstance(a1, list) and len(a0) == len(a1) == len(P["para"]):
        for q, v0, v1 in zip(P["para"], a0, a1):
            if num(v0) and num(v1) and abs(float(q["amt"]) - float(v1)) < 1e-6:
                q["amt"] = float(v0)
    return normalize(P)


# ── 生成の 1 本の中の切り替わり(segments.py detect と同じ) ───────────────────

SEG_W, SEG_H = 48, 27


def _seg_feats(F: np.ndarray) -> np.ndarray:
    """絵の特徴: 48×27 に面積で縮めた Lab。試作は 1344 幅で σ3 のぼかしを先にかけていたので、幅に合わせて σ を縮める。"""
    h, w = F.shape[1:3]
    sig = 3.0 * w / 1344.0
    out = []
    for f in F:
        g = cv2.GaussianBlur(f, (0, 0), sig) if sig >= 0.3 else f
        out.append(cv2.cvtColor(cv2.resize(g, (SEG_W, SEG_H), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2LAB))
    return np.stack(out).astype(np.float32)


def detect_transitions(frames_bgr_small: np.ndarray, K: int = 10) -> list[dict]:
    """1 本のクリップのコマ [n, h, w, 3](BGR uint8。192×108 程度に縮めてよい)から場面の切り替わりを出す。
    → [{"kind": "hard", "at": i} | {"kind": "dissolve" | "wipe", "t0": i, "t1": j, "fit": r}](i, j はクリップの頭からのコマ)。
      - ハードカット: 前のコマとの差が、まわり(±6f)の中央値の 5 倍超かつ 8 超。
      - 溶けの候補: d_K(i) = 特徴(i−K) と 特徴(i+K) の差の山(まわり ±40f の中央値の 1.6 倍超かつ 12 超、近くにハードカットなし)。
        山のまわりで各コマを (1−α)A + αB で表す α(最小二乗)を出し、α が 0.05〜0.95 の区間を遷移とする。
        混ぜ方で表した残りが A・B どちらか一方より十分小さく(fit < 0.6)、α が単調に増えるときだけ「溶け」、
        そうでなければ「一部から替わる」(wipe: 通り抜け・羽根のワイプ)。"""
    F = np.asarray(frames_bgr_small)
    n = len(F)
    if n < 3:
        return []
    X = _seg_feats(F)
    Xf = X.reshape(n, -1)
    d1 = np.r_[0.0, np.abs(np.diff(Xf, axis=0)).mean(1)].astype(np.float64)
    dK = np.array([float(np.abs(Xf[min(n - 1, i + K)] - Xf[max(0, i - K)]).mean()) for i in range(n)])
    # ハードカット: 前のコマとの差が、まわり(±6f)の中央値の 5 倍超かつ 8 超
    hard = []
    for i in range(1, n):
        nb = np.r_[d1[max(1, i - 6):i], d1[i + 1:i + 7]]
        if d1[i] > 8 and d1[i] > 5 * (np.median(nb) + 0.3):
            hard.append(i)
    # 溶けの候補: d_K の山が、まわり(±40f)の中央値の 1.6 倍超かつ 12 超、近くにハードカットがない
    cand = []
    for i in range(1, n - 1):
        loc = np.median(dK[max(0, i - 40):i + 41]) + 1e-6
        if dK[i] >= dK[i - 1] and dK[i] >= dK[i + 1] and dK[i] > 1.6 * loc and dK[i] > 12 and all(abs(i - h) > K for h in hard):
            cand.append(i)
    cand2: list[int] = []
    for c in cand:
        if cand2 and c - cand2[-1] < 2 * K:
            if dK[c] > dK[cand2[-1]]:
                cand2[-1] = c
        else:
            cand2.append(c)
    trans: list[dict] = [{"kind": "hard", "at": int(h)} for h in hard]
    for c in cand2:
        a, b = max(0, c - 2 * K), min(n - 1, c + 2 * K)
        A, B = Xf[a], Xf[b]; dAB = B - A; den = float((dAB * dAB).sum()) + 1e-6
        al = {i: float(np.clip(((Xf[i] - A) * dAB).sum() / den, -0.3, 1.3)) for i in range(a, b + 1)}
        xs = [i for i in range(a, b + 1) if 0.05 <= al[i] <= 0.95]
        mid = [i for i in xs if 0.3 <= al[i] <= 0.7]
        if not xs:
            continue
        t0, t1 = xs[0], xs[-1]
        # 混ぜ方の残り / どちらか一方の残り(溶けなら小さい)
        r_mix = np.mean([np.abs(Xf[i] - ((1 - al[i]) * A + al[i] * B)).mean() for i in mid]) if mid else 1e9
        r_one = np.mean([min(np.abs(Xf[i] - A).mean(), np.abs(Xf[i] - B).mean()) for i in mid]) if mid else 1
        mono = float(np.corrcoef(np.arange(t0, t1 + 1), [al[i] for i in range(t0, t1 + 1)])[0, 1]) if t1 > t0 + 2 else 0.0
        fit = round(float(r_mix / max(r_one, 1e-6)), 2)
        kind = "dissolve" if (r_mix < 0.6 * r_one and mono > 0.8) else "wipe"
        trans.append({"kind": kind, "t0": int(t0), "t1": int(t1), "fit": fit})
    return sorted(trans, key=lambda t: t.get("at", t.get("t0", 0)))


# ── 書き出し(サブプロセス): python -m app.services.satsuei_fx render <plan.json> ─────────────

def ffmpeg_exe() -> str:
    """ffmpeg_render と同じ ffmpeg(imageio の同梱版)。無ければ PATH の ffmpeg。"""
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg") or "ffmpeg"


def _decode_cmd(ff: str, path: str, w: int, h: int, n: int, start: int = 0, pix: str = "rgb24") -> list[str]:
    vf = f"scale={w}:{h}:in_color_matrix=bt709:in_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format={pix}"
    if start:
        vf = f"select=gte(n\\,{int(start)}),setpts=PTS-STARTPTS," + vf
    return [ff, "-nostdin", "-v", "error", "-i", str(path), "-vf", vf, "-frames:v", str(int(n)),
            "-f", "rawvideo", "-pix_fmt", pix, "-"]


def read_frames(path: str, start: int, n: int, w: int, h: int, pix: str = "bgr24", ff: Optional[str] = None) -> np.ndarray:
    """動画の start コマ目から n コマを [k, h, w, 3] uint8 で読む(BT.709・tv で読む。素材が短ければ k < n)。"""
    cmd = _decode_cmd(ff or ffmpeg_exe(), path, w, h, n, start, pix)
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"動画を読めませんでした: {path}: {r.stderr.decode(errors='replace').strip()[-300:]}")
    size = w * h * 3
    k = len(r.stdout) // size
    return np.frombuffer(r.stdout[:k * size], np.uint8).reshape(k, h, w, 3).copy()


def _fps_arg(fps: float) -> str:
    """ffmpeg の -r(29.97 などは 30000/1001 の分数で渡す。小数の丸めで長い尺がずれないように)。"""
    if abs(fps - round(fps)) < 1e-6:
        return str(int(round(fps)))
    fr = Fraction(fps).limit_denominator(1001)
    return f"{fr.numerator}/{fr.denominator}"


def _encode_cmd(ff: str, out: str, w: int, h: int, fps: float) -> list[str]:
    # ロスレス(qp 0)・yuv444p・BT.709。あとの合成でもう一度だけ圧縮される中間ファイル
    return [ff, "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
            "-r", _fps_arg(fps), "-i", "-",
            "-vf", "scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=yuv444p",
            "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "yuv444p",
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
            str(out)]


_WS: dict = {}   # ワーカーの持ち物(計画・表の置き場)


def _worker_init(state: dict) -> None:
    try:
        cv2.setNumThreads(1)          # 1 プロセス 1 コア(プロセスの数で並べる)
    except Exception:
        pass
    _WS.clear()
    _WS.update(state)
    _WS["cache"] = {}


def _layer_on(st: dict, li: int, f: int) -> bool:
    """レイヤー li をコマ f で計算するか(計画に spans があれば、その区間の中だけ)。"""
    masks = st.get("masks")
    m = masks[li] if masks and li < len(masks) else None
    if m is None:
        return True
    j = f - int(st.get("f0") or 0)
    return 0 <= j < len(m) and bool(m[j])


def _spans_mask(spans, f0: int, n: int) -> Optional[np.ndarray]:
    """[[頭, 終わり(含まない)], ...](タイムラインのコマ)→ 長さ n の真偽の列(j = f − f0)。None はどこでも。"""
    if spans is None:
        return None
    m = np.zeros(n, bool)
    for sp in spans:
        try:
            a, b = int(sp[0]) - f0, int(sp[1]) - f0
        except (TypeError, ValueError, IndexError, OverflowError):
            continue
        m[max(0, a):max(0, min(n, b))] = True
    return m


def _process_frame(buf: bytes, f: int, st: dict) -> bytes:
    """1 コマ(rgb24 のバイト列)に全レイヤーをかける。何もかからなければ同じバイト列を返す。"""
    w, h = st["w"], st["h"]
    x = None
    changed = False
    for li, (layer, rect) in enumerate(zip(st["layers"], st["rects"])):
        if not _layer_on(st, li, f) or not any(mix_at(c, f) > MIX_EPS for c in layer):
            continue
        if x is None:
            x = np.frombuffer(buf, np.uint8).reshape(h, w, 3).astype(np.float32) * np.float32(1 / 255)
        y = apply_layer(x, layer, f, st["cache"], rect)
        if y is not x:
            x, changed = y, True
    if not changed:
        return buf
    return np.clip(x * 255 + 0.5, 0, 255).astype(np.uint8).tobytes()


def _worker_frame(args: tuple[int, bytes]) -> bytes:
    f, buf = args
    return _process_frame(buf, f, _WS)


def render(plan: dict, progress: Optional[Callable[[float], None]] = None) -> dict:
    """計画に従って撮影レイヤーをかけた動画を書く。
    plan = {src, out, w, h, fps, frames, layers: [[clip_spec, ...], ...](下のトラックから順), rects: [rect | null, ...],
            spans?: [[[頭, 終わり], ...] | null, ...](レイヤーごとに、計算するコマの区間。無ければどこでも),
            threads?, f0?(src の 0 コマ目のタイムラインのコマ。既定 0), ffmpeg?}
    spans は、同じトラックに撮影以外のクリップが混ざって書き出しの段が分かれるとき、各段で受け持つコマだけに
    レイヤーをかけるため(どのコマもレイヤーはそのトラックの撮影クリップ全部で解く = 重なりの遷移・効き 0 の勝ちも同じ)。
    撮影クリップのかからないコマは読んだバイト列のまま書く。出力は映像だけ(音は付けない)。"""
    t_start = time.time()
    src, out = str(plan["src"]), str(plan["out"])
    w, h, n = int(plan["w"]), int(plan["h"]), int(plan["frames"])
    fps = float(plan.get("fps") or 24.0)
    f0 = int(plan.get("f0") or 0)
    if w <= 0 or h <= 0 or n <= 0:
        raise ValueError(f"大きさかコマ数がおかしい: {w}x{h} {n} コマ")
    layers = [prepare_layer(L) for L in (plan.get("layers") or [])]
    rects = list(plan.get("rects") or [])
    rects = (rects + [None] * len(layers))[:len(layers)]
    spans = list(plan.get("spans") or [])
    masks = [_spans_mask(sp, f0, n) for sp in (spans + [None] * len(layers))[:len(layers)]]
    ff = plan.get("ffmpeg") or ffmpeg_exe()
    state = {"w": w, "h": h, "layers": layers, "rects": rects, "masks": masks, "f0": f0}
    active = [any(_layer_on(state, li, f0 + j) and any(mix_at(c, f0 + j) > MIX_EPS for c in L)
                  for li, L in enumerate(layers)) for j in range(n)]
    n_active = sum(active)
    procs = int(plan.get("threads") or 0) or min(12, max(1, (os.cpu_count() or 4) - 2))
    procs = max(1, min(procs, n_active or 1))

    op = Path(out)
    tmp = str(op.with_name(op.stem + ".part" + (op.suffix or ".mp4")))
    size = w * h * 3
    # ワーカーは ffmpeg を起こす前に作る(fork で ffmpeg の管を持たせると、閉じても ffmpeg に終わりが届かない)
    pool = None
    if procs > 1:
        import multiprocessing as mp
        try:
            ctx = mp.get_context("fork")
        except ValueError:
            ctx = mp.get_context()
        pool = ctx.Pool(procs, initializer=_worker_init, initargs=(state,))
    else:
        _worker_init(state)
    err_dec = tempfile.TemporaryFile()
    err_enc = tempfile.TemporaryFile()
    dec = enc = None
    written = 0
    short = 0
    last_p = 0.0

    def _err(fh) -> str:
        try:
            fh.seek(0)
            return fh.read().decode(errors="replace").strip()[-600:]
        except Exception:
            return ""

    def put(data: bytes) -> None:
        nonlocal written, last_p
        try:
            enc.stdin.write(data)
        except (BrokenPipeError, OSError):
            try:
                enc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            raise RuntimeError(f"書き出しの ffmpeg が止まりました: {_err(err_enc)}")
        written += 1
        if progress:
            p = written / n
            if p - last_p >= 0.01 or written == n:
                last_p = p
                progress(p)

    try:
        dec = subprocess.Popen(_decode_cmd(ff, src, w, h, n), stdout=subprocess.PIPE, stderr=err_dec)
        enc = subprocess.Popen(_encode_cmd(ff, tmp, w, h, fps), stdin=subprocess.PIPE, stderr=err_enc)
        pending: deque = deque()
        window = procs * 2                    # 同時に計算するコマの上限(メモリを食い過ぎない)
        last = None
        for j in range(n):
            buf = dec.stdout.read(size)
            if not buf or len(buf) < size:    # 元が短い: 最後のコマで埋める(黒で埋めて目立たせるより自然)
                if last is None:
                    try:
                        dec.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                    raise RuntimeError(f"元の動画を読めませんでした: {src}: {_err(err_dec)}")
                buf = last
                short += 1
            last = buf
            f = f0 + j
            if not active[j]:
                pending.append(buf)
            elif pool is None:
                pending.append(_process_frame(buf, f, _WS))
            else:
                pending.append(pool.apply_async(_worker_frame, ((f, buf),)))
            # 順番どおりに書く: 先頭が出来ていれば書く。計算中が多すぎるときは先頭を待つ
            while pending:
                head = pending[0]
                if isinstance(head, (bytes, bytearray)):
                    put(head)
                elif len(pending) > window or head.ready():
                    put(head.get())
                else:
                    break
                pending.popleft()
        while pending:
            head = pending.popleft()
            put(head if isinstance(head, (bytes, bytearray)) else head.get())
        enc.stdin.close()
        if enc.wait() != 0:
            raise RuntimeError(f"書き出しの ffmpeg が失敗しました: {_err(err_enc)}")
        if short:
            sys.stderr.write(f"warning: 元の動画が {short} コマ足りないので最後のコマで埋めました\n")
    except BaseException:
        for p_ in (enc, dec):
            try:
                if p_ is not None:
                    p_.kill()
            except Exception:
                pass
        Path(tmp).unlink(missing_ok=True)
        raise
    finally:
        if pool is not None:
            pool.terminate()
            pool.join()
        for p_ in (dec, enc):
            if p_ is None:
                continue
            for fh in (p_.stdout, p_.stdin):
                try:
                    if fh:
                        fh.close()
                except Exception:
                    pass
            if p_.poll() is None:
                p_.kill()
            p_.wait()
        err_dec.close(); err_enc.close()
    os.replace(tmp, out)
    sec = time.time() - t_start
    return {"out": out, "frames": written, "processed": n_active, "padded": short, "procs": procs,
            "sec": round(sec, 2), "fps": round(written / max(sec, 1e-6), 2)}


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[1] != "render":
        sys.stderr.write("usage: python -m app.services.satsuei_fx render <plan.json>\n")
        return 2
    try:
        plan = json.loads(Path(argv[2]).read_text())
    except Exception as e:
        sys.stderr.write(f"撮影の計画を読めませんでした: {e}\n")
        return 2
    try:
        os.nice(5)   # 画面(プレビュー)の邪魔をしない程度に
    except (AttributeError, OSError):
        pass

    def prog(p: float) -> None:
        sys.stdout.write(f"PROGRESS {p:.4f}\n"); sys.stdout.flush()

    try:
        stats_ = render(plan, prog)
    except Exception as e:
        sys.stderr.write(f"撮影の書き出しに失敗しました: {type(e).__name__}: {e}\n")
        return 1
    sys.stdout.write("DONE " + json.dumps(stats_, ensure_ascii=False) + "\n"); sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
