"""🔤 Live credit clips (kind 'credit', 2026-11-01): refraction credits computed live instead of baked .mov cards.

Contract: outputs/pocky2026/v13/fix1101/credits_live/contract/credit_contract_v1.json (prose: DESIGN_credit_clip.md §2-§8).
This module holds everything Python needs for the credit clip:

  normalize(credit)            attrs_json.credit -> the full normalized CreditV1 object (defaults, clamps, idempotent)
  build_master(credit)         static fields at the 2560x1440 design scale (port of fix1031/credits/credits_lib_v3.Card._build,
                               sc = 1, supersample S = 2), cached (memory LRU 6 + disk data/credit_cache/master/<sha1>.npz)
  map_fields(master, ...)      exact box-filter area resampling of the master to an output box (preview canvas, 1344, 2560 ...)
  pack_kcm1 / parse_kcm1       the "KCM1" binary the WebGL preview reads (7 RGBA float32 textures + JSON header)
  frame_scalars(...)           per clip / per frame scalars (§6, double precision; the TS creditLook.frameScalars twin)
  compose_rgb(...)             per-pixel formula (§6; the GLSL twin) on a float RGB picture
  render(plan)                 the export pass in the YUV 4:2:0 domain (python -m app.services.credit_fx render <plan.json>)

Coordinates: corner coordinates (pixel i spans [i, i+1)); header point quantities (cx, cy, name_ink, glints) are index
coordinates of the map canvas (pixel centre = integer), exactly as credits_lib_v3 evaluated them.
"""
from __future__ import annotations

import copy
import gzip
import hashlib
import io
import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from collections import OrderedDict, deque
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Optional

import cv2
import numpy as np

# ── contract v1 (copy of credit_contract_v1.json; tests/test_credit_fx.py checks they are equal) ─────────────────────
CONTRACT_VERSION = 1
MAPS_VERSION = 1
CLIP_KIND = "credit"
DESIGN = (2560, 1440)
MAX_TEXT = 64
MAX_LABELS = 64
MAX_GLINTS = 6
NEW_CLIP_DURATION_S = 3.0
DEFAULT_POS = [160, 1064]
BUILD_REV = 3            # internal: part of the master DISK cache key (bump when the build code changes during dev)
MAX_MASTER_PX = 16_000_000   # S-res canvas pixels; above this a card is refused (CreditError 422 "字幕が大きすぎます")
# Write-back threshold of the export (and /still): pixels whose final card alpha is at most this keep the picture's
# own bytes. The card changes such a pixel by at most 255·A ≤ 0.25 code values, but rewriting it would send an
# out-of-gamut source pixel (a saturated edge with R < 0 after YUV -> RGB) through the RGB clamp and move it by ~2
# codes (review 2026-11-01). The preview writes every canvas pixel; the difference there is ≤ 0.25 before rounding.
A_WRITE_EPS = 1.0 / 1024

DEFAULT_CREDIT: dict = {
    "v": 1, "role": "", "name": "", "align": "left", "pos": [160, 1064], "seed": 1, "group": "", "label": "",
    "timing": {"appear_frames": 24, "disappear_frames": 20, "sheen_start": None, "sheen_end": None},
    "style": {
        "name_size": 88, "name_track": 0.16, "name_ja_scale": 0.8, "name_ja_track": 0.1,
        "role_size": 50, "role_track": 0.2, "role_latin_scale": 1.12,
        "line_gap": 0.42, "rim": 0.42, "edge_rgb": [10, 70, 175],
        "shadow": 0.9, "glow": 0.1, "role_shadow": 1.4, "shadow_sigma": 0.075, "shadow_off": [0.03, 0.02],
        "glow_sigma": 0.11, "plate": 0.0, "plate_rgb": [20, 64, 150], "plate_sigma": 0.45,
        "sheen": 0.3, "sheen_width": 0.55, "glints": 3, "letter_var": 0.05,
        "fonts": {"name_latin": "urw_gothic_demi", "name_ja": "mplus_rounded_black",
                  "role_latin": "urw_gothic_book", "role_ja": "mplus_rounded_bold"},
    },
    "refract": {
        "n_max": 1.5, "tube": 1.2, "slope_sat": 2.0, "letter": 0.09, "letter_sigma": 0.1,
        "zoom": 0.008, "disp": 0.07, "fres": 0.55, "fres_pow": 2.0, "fres_rgb": [236, 246, 255],
        "hl": 0.9, "absorb": 0.1, "g0": 0.55, "fill_q": 0.6,
    },
}

# [lo, hi] = float clamp; {"int": [lo, hi]}; {"vec": [[lo, hi], ...]}; {"enum": [...]}; {"null_or_int": [lo, hi]}
RANGES: dict = {
    "align": {"enum": ["left", "center", "right"]},
    "pos": {"vec": [[-1280, 3840], [-720, 2160]]},
    "seed": {"int": [0, 2147483647]},
    "timing.appear_frames": {"int": [0, 240]},
    "timing.disappear_frames": {"int": [0, 240]},
    "timing.sheen_start": {"null_or_int": [-240, 2400]},
    "timing.sheen_end": {"null_or_int": [-240, 2400]},
    "style.name_size": [8, 400], "style.name_track": [-0.2, 1.0], "style.name_ja_scale": [0.3, 2.0],
    "style.name_ja_track": [-0.2, 1.0],
    "style.role_size": [8, 300], "style.role_track": [-0.2, 1.0], "style.role_latin_scale": [0.3, 2.0],
    "style.line_gap": [0.0, 3.0], "style.rim": [0.05, 2.0], "style.edge_rgb": {"vec": [[0, 255], [0, 255], [0, 255]]},
    "style.shadow": [0.0, 3.0], "style.glow": [0.0, 2.0], "style.role_shadow": [0.0, 4.0], "style.shadow_sigma": [0.0, 1.0],
    "style.shadow_off": {"vec": [[-1.0, 1.0], [-1.0, 1.0]]}, "style.glow_sigma": [0.0, 1.0],
    "style.plate": [0.0, 1.0], "style.plate_rgb": {"vec": [[0, 255], [0, 255], [0, 255]]}, "style.plate_sigma": [0.05, 2.0],
    "style.sheen": [0.0, 2.0], "style.sheen_width": [0.05, 3.0], "style.glints": {"int": [0, 6]},
    "style.letter_var": [0.0, 0.5],
    "style.fonts.*": {"enum_from": "fonts[].id"},
    "refract.n_max": [1.0, 3.0], "refract.tube": [0.0, 6.0], "refract.slope_sat": [0.2, 10.0], "refract.letter": [0.0, 1.0],
    "refract.letter_sigma": [0.01, 1.0], "refract.zoom": [0.0, 0.1], "refract.disp": [0.0, 0.5], "refract.fres": [0.0, 3.0],
    "refract.fres_pow": [0.25, 8.0], "refract.fres_rgb": {"vec": [[0, 255], [0, 255], [0, 255]]}, "refract.hl": [0.0, 3.0],
    "refract.absorb": [0.0, 1.0], "refract.g0": [0.0, 0.95], "refract.fill_q": [0.0, 3.0],
}

FONTS: list[dict] = [
    {"id": "urw_gothic_demi", "file": "URWGothic-Demi.otf", "dirs": ["/usr/share/fonts/opentype/urw-base35"]},
    {"id": "urw_gothic_book", "file": "URWGothic-Book.otf", "dirs": ["/usr/share/fonts/opentype/urw-base35"]},
    {"id": "mplus_rounded_black", "file": "MPLUSRounded1c-Black.ttf", "dirs": ["<repo>/tools/mad-kit/fonts"]},
    {"id": "mplus_rounded_bold", "file": "MPLUSRounded1c-Bold.ttf", "dirs": ["<repo>/tools/mad-kit/fonts"]},
    {"id": "mochiy_pop_one", "file": "MochiyPopOne-Regular.ttf", "dirs": ["<repo>/tools/mad-kit/fonts"]},
    {"id": "yusei_magic", "file": "YuseiMagic-Regular.ttf", "dirs": ["<repo>/tools/mad-kit/fonts"]},
]
FONT_IDS = [f["id"] for f in FONTS]
FONT_ROLES = ("name_latin", "name_ja", "role_latin", "role_ja")

MAP_KEYS_DOC = {
    "credit": ["role", "name", "align", "pos", "seed"],
    "style": "ALL keys except sheen, sheen_width",
    "refract": ["slope_sat", "letter_sigma", "fres_pow"],
    "also": ["box_w", "box_h", "content_w", "content_h", "maps_version"],
}
UNIFORM_KEYS = {
    "timing": ["appear_frames", "disappear_frames", "sheen_start", "sheen_end"],
    "style": ["sheen", "sheen_width"],
    "refract": ["n_max", "tube", "letter", "zoom", "disp", "fres", "fres_rgb", "hl", "absorb", "g0", "fill_q"],
    "clip": ["start_frame", "duration_frames", "opacity"],
}
TEXTURES = [
    {"name": "T0", "channels": ["M", "HN", "ABSn", "RIM"]},
    {"name": "T1", "channels": ["TX", "TY", "LX", "LY"]},
    {"name": "T2", "channels": ["NC_r", "NC_g", "NC_b", "NA"]},
    {"name": "T3", "channels": ["RP_r", "RP_g", "RP_b", "RA"]},
    {"name": "T4", "channels": ["OO_r", "OO_g", "OO_b", "OA"]},
    {"name": "T5", "channels": ["HL", "core", "spec", "zero"]},
    {"name": "T6", "channels": ["l1", "w1", "l2", "w2"]},
]
HEADER_FIELDS = ["v", "key", "box", "content", "k", "x0", "y0", "W", "H", "cx", "cy", "name_ink", "glints", "nlab",
                 "letter_base", "letter_ph", "letter_hz", "star_r", "max_t", "max_l", "max_r", "ink_box_design",
                 "ink_box_box", "empty", "build_ms"]

S = 2   # supersample of the master build (as credits_lib v2/v3 and the logo)


class CreditError(ValueError):
    """A credit that cannot be built (status: 422 too large / bad input, 500 missing font)."""
    def __init__(self, msg: str, status: int = 422):
        super().__init__(msg)
        self.status = status


# ── normalize ─────────────────────────────────────────────────────────────────────────────────────────────────────

def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))


def _round_int(v: float) -> int:
    """ints are rounded half up (= JS Math.round), not Python's banker's rounding."""
    return int(math.floor(float(v) + 0.5))


def _clean_text(v: Any) -> str:
    """str, control characters (Cc: U+0000-001F, U+007F-009F) removed, at most 64 code points."""
    if not isinstance(v, str):
        return ""
    s = "".join(ch for ch in v if not (ord(ch) < 0x20 or 0x7F <= ord(ch) <= 0x9F))
    return s[:MAX_TEXT]


def _norm_value(v: Any, default: Any, rng: Any) -> Any:
    if isinstance(rng, list):                             # float clamp
        if not _is_num(v):
            return copy.deepcopy(default)
        return max(rng[0], min(rng[1], v))
    if "int" in rng:
        lo, hi = rng["int"]
        if not _is_num(v):
            return default
        return max(lo, min(hi, _round_int(v)))
    if "null_or_int" in rng:
        lo, hi = rng["null_or_int"]
        if v is None or not _is_num(v):
            return None
        return max(lo, min(hi, _round_int(v)))
    if "enum" in rng:
        return v if v in rng["enum"] else default
    if "vec" in rng:
        lims = rng["vec"]
        src = v if isinstance(v, (list, tuple)) else []
        out = []
        for k, (lo, hi) in enumerate(lims):
            c = src[k] if k < len(src) else None
            out.append(max(lo, min(hi, c)) if _is_num(c) else default[k])
        return out
    return v


def normalize(credit: Any) -> dict:
    """attrs_json.credit (anything) -> the full CreditV1 object: defaults filled, numbers clamped (ints rounded half up),
    unknown font ids -> the default font of that role, text without control characters and at most 64 characters,
    unknown keys kept untouched. Idempotent: normalize(normalize(x)) == normalize(x)."""
    src = credit if isinstance(credit, dict) else {}
    out = copy.deepcopy(src)
    D = DEFAULT_CREDIT
    out["v"] = 1
    for k in ("role", "name", "group", "label"):
        out[k] = _clean_text(src.get(k, D[k]))
    out["align"] = _norm_value(src.get("align"), D["align"], RANGES["align"])
    out["pos"] = _norm_value(src.get("pos"), D["pos"], RANGES["pos"])
    out["seed"] = _norm_value(src.get("seed"), D["seed"], RANGES["seed"])
    for sect in ("timing", "style", "refract"):
        s_in = src.get(sect) if isinstance(src.get(sect), dict) else {}
        s_out = copy.deepcopy(s_in)
        for k, dv in D[sect].items():
            if k == "fonts":
                continue
            rng = RANGES.get(f"{sect}.{k}")
            s_out[k] = _norm_value(s_in.get(k, dv), dv, rng) if rng is not None else copy.deepcopy(s_in.get(k, dv))
            if sect == "timing" and k in ("sheen_start", "sheen_end") and k not in s_in:
                s_out[k] = None
        if sect == "style":
            f_in = s_in.get("fonts") if isinstance(s_in.get("fonts"), dict) else {}
            f_out = copy.deepcopy(f_in)
            for role in FONT_ROLES:
                fid = f_in.get(role)
                f_out[role] = fid if isinstance(fid, str) and fid in FONT_IDS else D["style"]["fonts"][role]
            s_out["fonts"] = f_out
        out[sect] = s_out
    return out


def _canon(x: Any) -> Any:
    """canonical JSON values for cache keys (160.0 -> 160, so 160 and 160.0 share a key)."""
    if isinstance(x, dict):
        return {k: _canon(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_canon(v) for v in x]
    if isinstance(x, float) and x.is_integer() and abs(x) < 2 ** 53:
        return int(x)
    return x


def map_subset(credit_n: dict, with_pos: bool = True) -> dict:
    """the map keys of a NORMALIZED credit (contract map_keys): role, name, align, pos, seed, style minus sheen/sheen_width,
    refract.slope_sat / letter_sigma / fres_pow."""
    st = {k: v for k, v in credit_n["style"].items() if k not in ("sheen", "sheen_width") and k in DEFAULT_CREDIT["style"]}
    rf = {k: credit_n["refract"][k] for k in ("slope_sat", "letter_sigma", "fres_pow")}
    sub = {"role": credit_n["role"], "name": credit_n["name"], "align": credit_n["align"], "seed": credit_n["seed"],
           "style": st, "refract": rf}
    if with_pos:
        sub["pos"] = credit_n["pos"]
    return sub


def _sha1(obj: Any) -> str:
    return hashlib.sha1(json.dumps(_canon(obj), sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def maps_key(credit_n: dict, box, content) -> str:
    return _sha1({"maps_version": MAPS_VERSION, "subset": map_subset(credit_n), "box": [int(box[0]), int(box[1])],
                  "content": [int(content[0]), int(content[1])]})


# ── fonts ─────────────────────────────────────────────────────────────────────────────────────────────────────────

def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _font_dirs() -> list[Path]:
    dirs = [Path(d) for d in os.environ.get("KYCHA_FONT_DIRS", "").split(":") if d.strip()]
    return dirs + [repo_root() / "tools" / "mad-kit" / "fonts", Path("/usr/share/fonts/opentype/urw-base35")]


def font_path(font_id: str) -> Optional[Path]:
    reg = next((f for f in FONTS if f["id"] == font_id), None)
    if reg is None:
        return None
    for d in _font_dirs():
        p = d / reg["file"]
        if p.is_file():
            return p
    return None


def fonts_meta() -> list[dict]:
    return [{"id": f["id"], "file": f["file"], "ok": font_path(f["id"]) is not None} for f in FONTS]


def _font_file(font_id: str) -> str:
    p = font_path(font_id)
    if p is None:
        reg = next((f for f in FONTS if f["id"] == font_id), {"file": font_id})
        raise CreditError(f"フォントが見つかりません: {reg['file']}", status=500)
    return str(p)


@lru_cache(maxsize=256)
def _truetype(path: str, size: int):
    from PIL import ImageFont
    return ImageFont.truetype(path, size)


# ── glyph layout (port of credits_lib v2: line_glyphs / draw_line / line_extent) ───────────────────────────────────

def _is_latin(ch: str) -> bool:
    return ord(ch) < 0x2000


def _line_glyphs(text: str, kind: str, st: dict, fonts: dict) -> list:
    """-> [(ch, font, size_px_at_S, advance_at_S)]; kind = 'name' | 'role' (sc = 1)"""
    out = []
    for ch in text:
        if kind == "name":
            if _is_latin(ch):
                fp, sz, tr = fonts["name_latin"], st["name_size"], st["name_track"]
            else:
                fp, sz, tr = fonts["name_ja"], st["name_size"] * st["name_ja_scale"], st["name_ja_track"]
        else:
            if _is_latin(ch):
                fp, sz, tr = fonts["role_latin"], st["role_size"] * st["role_latin_scale"], st["role_track"]
            else:
                fp, sz, tr = fonts["role_ja"], st["role_size"], st["role_track"]
        px = sz * 1.0 * S
        f = _truetype(fp, max(4, int(round(px))))
        out.append((ch, f, px, tr * px))
    return out


def _draw_line(glyphs, W, H, x0, base_y, label_start=0):
    """draw glyphs at baseline base_y from x0 (S-res). -> mask float32, label map int16 (-1 none), next label.
    The per-glyph label raster is drawn on a small image at the same sub-pixel phase (integer translation of the
    full-canvas draw of credits_lib v2), which gives the identical raster."""
    from PIL import Image, ImageDraw
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    lab = np.full((H, W), -1, np.int16)
    x = x0
    k = label_start
    for ch, f, px, tr in glyphs:
        w = d.textlength(ch, font=f)
        if ch.strip():
            bb = d.textbbox((x, base_y), ch, font=f, anchor="ls")
            gx0, gy0 = int(math.floor(bb[0])) - 4, int(math.floor(bb[1])) - 4
            gw, gh = int(math.ceil(bb[2])) + 4 - gx0, int(math.ceil(bb[3])) + 4 - gy0
            if gw > 0 and gh > 0:
                g = Image.new("L", (gw, gh), 0)
                ImageDraw.Draw(g).text((x - gx0, base_y - gy0), ch, font=f, fill=255, anchor="ls")
                ga = np.asarray(g)
                ya, yb = max(0, gy0), min(H, gy0 + gh)
                xa, xb = max(0, gx0), min(W, gx0 + gw)
                if yb > ya and xb > xa:
                    sub = ga[ya - gy0:yb - gy0, xa - gx0:xb - gx0] > 40
                    lab[ya:yb, xa:xb][sub] = k
            k += 1
            d.text((x, base_y), ch, font=f, fill=255, anchor="ls")
        x += w + tr
    return np.asarray(m, np.float32) / 255, lab, k


def _line_extent(glyphs):
    from PIL import Image, ImageDraw
    d = ImageDraw.Draw(Image.new("L", (8, 8)))
    x = 0.0
    xs0, ys0, xs1, ys1 = [], [], [], []
    for i, (ch, f, px, tr) in enumerate(glyphs):
        w = d.textlength(ch, font=f)
        if ch.strip():
            bb = d.textbbox((x, 0), ch, font=f, anchor="ls")
            xs0.append(bb[0]); ys0.append(bb[1]); xs1.append(bb[2]); ys1.append(bb[3])
        x += w + (tr if i < len(glyphs) - 1 else 0)
    if not xs0:
        return None, x
    return (min(xs0), min(ys0), max(xs1), max(ys1)), x


def _glass_rgba(mask, u, st):
    """logo glass recipe (credits_lib.glass_rgba) at S-res -> straight colour, alpha, spec*mask, core*mask"""
    m8 = (mask > 0.5).astype(np.uint8)
    dist = cv2.distanceTransform(m8, cv2.DIST_L2, 5)
    rad = max(1.0, np.percentile(dist[m8 > 0], 98))
    h = np.sqrt(np.clip(1 - (1 - np.clip(dist / rad, 0, 1)) ** 2, 0, 1))
    h = cv2.GaussianBlur(h, (0, 0), max(0.6, 1.2 * u))
    gy, gx = np.gradient(h)
    n = np.dstack([-gx * rad, -gy * rad, np.ones_like(h)]); n /= np.linalg.norm(n, axis=2, keepdims=True)
    L = np.array([-0.55, -0.65, 0.52]); L /= np.linalg.norm(L)
    lam = np.clip((n * L).sum(2), 0, 1)
    Hv = L + np.array([0, 0, 1.0]); Hv /= np.linalg.norm(Hv)
    spec = np.clip((n * Hv).sum(2), 0, 1) ** 60
    ys, xs = np.nonzero(m8); y0, y1 = ys.min(), ys.max()
    yy = np.clip((np.arange(mask.shape[0])[:, None] - y0) / max(1, y1 - y0), 0, 1)
    base = np.dstack([70 + 90 * (1 - yy), 165 + 60 * (1 - yy), 240 + 15 * (1 - yy)]) * np.ones((1, mask.shape[1], 1))
    core = np.clip(dist / rad, 0, 1)
    col = base * (0.80 + 0.30 * lam[..., None]) + np.array([150, 225, 255]) * (0.35 * core[..., None] ** 2)
    edge = np.clip(1 - dist / (rad * st["rim"]), 0, 1) * mask
    rc = np.array(st["edge_rgb"], np.float64)
    col = col * (1 - 0.8 * edge[..., None]) + rc * (0.8 * edge[..., None])
    col = col + 255 * spec[..., None] * 1.1
    alpha = np.clip(mask * (0.88 + 0.12 * edge + 0.5 * spec), 0, 1)
    return col, alpha, spec * mask, core * mask


def _soft_shadow(mask, sigma, dy, dx):
    sh = cv2.GaussianBlur(mask, (0, 0), sigma) if sigma > 0 else mask.copy()
    Mt = np.float32([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(sh, Mt, (mask.shape[1], mask.shape[0]), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)


def _blur(a, sigma):
    return cv2.GaussianBlur(a, (0, 0), sigma) if sigma > 0 else a.copy()


def _tube_optics(mask, u, s0):
    """credits_lib_v3.tube_optics: S-res glass-tube profile of a mask"""
    m8 = (mask > 0.5).astype(np.uint8)
    if m8.sum() == 0:
        z = np.zeros_like(mask)
        return dict(sx=z, sy=z, rim=z, lam=z, spec=z, absorb=z, h=z, rad=1.0)
    dist = cv2.distanceTransform(m8, cv2.DIST_L2, 5)
    rad = max(1.0, float(np.percentile(dist[m8 > 0], 98)))
    h = np.sqrt(np.clip(1 - (1 - np.clip(dist / rad, 0, 1)) ** 2, 0, 1))
    h = cv2.GaussianBlur(h, (0, 0), max(0.6, 1.2 * u))
    gy, gx = np.gradient(h)
    sx, sy = gx * rad, gy * rad
    mag = np.sqrt(sx * sx + sy * sy)
    f = 1.0 / np.sqrt(1 + (mag / s0) ** 2)
    n = np.dstack([-sx, -sy, np.ones_like(h)]); n /= np.linalg.norm(n, axis=2, keepdims=True)
    L = np.array([-0.55, -0.65, 0.52]); L /= np.linalg.norm(L)
    lam = np.clip((n * L).sum(2), 0, 1)
    Hv = L + np.array([0, 0, 1.0]); Hv /= np.linalg.norm(Hv)
    spec = np.clip((n * Hv).sum(2), 0, 1) ** 60
    cos = 1.0 / np.sqrt(1 + mag * mag)
    return dict(sx=sx * f, sy=sy * f, rim=(1 - cos), lam=lam, spec=spec, absorb=np.clip(mag / s0 - 0.6, 0, 1), h=h, rad=rad)


def _top2_labels(lab: np.ndarray, nlab: int):
    """per pixel the two labels with the largest sigma-1 Gaussian weight of the per-label indicator (split_proto.build_fmap2);
    -1 = none. Each label is blurred inside its own box (+6 px, exact: the kernel reaches 4 px, the margin is zero)."""
    Hc, Wc = lab.shape
    l1 = np.full((Hc, Wc), -1, np.int16); l2 = np.full((Hc, Wc), -1, np.int16)
    w1 = np.zeros((Hc, Wc), np.float32); w2 = np.zeros((Hc, Wc), np.float32)
    for l in range(nlab):
        ys, xs = np.nonzero(lab == l)
        if ys.size == 0:
            continue
        ya, yb = max(0, ys.min() - 6), min(Hc, ys.max() + 7)
        xa, xb = max(0, xs.min() - 6), min(Wc, xs.max() + 7)
        ind = (lab[ya:yb, xa:xb] == l).astype(np.float32)
        wl = cv2.GaussianBlur(ind, (0, 0), 1.0)
        L1, W1, L2, W2 = l1[ya:yb, xa:xb], w1[ya:yb, xa:xb], l2[ya:yb, xa:xb], w2[ya:yb, xa:xb]
        top = wl > W1
        sec = (~top) & (wl > W2)
        L2[top] = L1[top]; W2[top] = W1[top]
        L1[top] = l; W1[top] = wl[top]
        L2[sec] = l; W2[sec] = wl[sec]
    l1[w1 <= 0] = -1; w1[w1 <= 0] = 0
    l2[w2 <= 0] = -1; w2[w2 <= 0] = 0
    return l1, w1, l2, w2


PLANES = ("M", "HC", "TXm", "TYm", "LXm", "LYm", "RIM", "HL", "ABSm", "core", "spec", "NC_r", "NC_g", "NC_b", "NA",
          "RP_r", "RP_g", "RP_b", "RA", "OO_r", "OO_g", "OO_b", "OA", "l1", "w1", "l2", "w2")


def _empty_master(credit_n: dict, ms: float = 0.0) -> dict:
    return {"empty": True, "W": 0, "H": 0, "planes": {}, "ink": [0, 0, 0, 0], "name_ink": [0, 0, 0, 0], "glints": [],
            "cx": 0.0, "cy": 0.0, "nlab": 0, "letter_base": [1.0], "letter_ph": [0.0], "letter_hz": [0.2],
            "name_size": float(credit_n["style"]["name_size"]), "build_ms": ms}


def build_master(credit_n: dict) -> dict:
    """static fields of one card at the design scale (2560x1440 screen px), WITHOUT the position (cache key excludes pos).
    Port of credits_lib_v3.Card._build (sc = 1, S = 2) with unit offset fields and coverage-premultiplied planes."""
    t0 = time.perf_counter()
    st, rf = credit_n["style"], credit_n["refract"]
    fonts = {role: _font_file(st["fonts"][role]) for role in FONT_ROLES}
    role, name = credit_n["role"], credit_n["name"]
    if not any(ch.strip() for ch in name):
        return _empty_master(credit_n, (time.perf_counter() - t0) * 1000)
    role_g = _line_glyphs(role, "role", st, fonts) if any(ch.strip() for ch in role) else None
    name_g = _line_glyphs(name, "name", st, fonts)
    ne, _ = _line_extent(name_g)
    if ne is None:
        return _empty_master(credit_n, (time.perf_counter() - t0) * 1000)
    re_ = None
    if role_g:
        re_, _ = _line_extent(role_g)
        if re_ is None:
            role_g = None
    sc = 1.0
    nsz = st["name_size"] * sc * S
    gap = st["line_gap"] * nsz
    nw, nh = ne[2] - ne[0], ne[3] - ne[1]
    if role_g:
        rw, rh = re_[2] - re_[0], re_[3] - re_[1]; bw = max(nw, rw); bh = rh + gap + nh
    else:
        rw = rh = 0; bw, bh = nw, nh
    align = credit_n["align"]
    margin = int(math.ceil(nsz * 0.9 + (7.5 + 12) * sc * S))       # = v2/v3 canvas -> same raster phase
    W = int(math.ceil(bw + 2 * margin)); H = int(math.ceil(bh + 2 * margin))
    W += (-W) % (2 * S); H += (-H) % (2 * S)
    if W * H > MAX_MASTER_PX:
        raise CreditError(f"字幕が大きすぎます({W // S}×{H // S} px。文字を短くするか小さくしてください)", status=422)

    def xoff(w):
        return margin + {"left": 0, "center": (bw - w) / 2, "right": bw - w}[align]
    y_role_top = margin
    y_name_top = margin + (rh + gap if role_g else 0)
    name_mask, lab, nlab = _draw_line(name_g, W, H, xoff(nw) - ne[0], y_name_top - ne[1])
    if role_g:
        role_mask, _, _ = _draw_line(role_g, W, H, xoff(rw) - re_[0], y_role_top - re_[1], label_start=nlab)
    else:
        role_mask = np.zeros_like(name_mask)
    if not (name_mask > 0.5).any():
        return _empty_master(credit_n, (time.perf_counter() - t0) * 1000)
    u = S * st["name_size"] * sc / 88.0
    col, alpha, spec, core = _glass_rgba(name_mask, max(0.5, u), st)
    glow = _blur(name_mask, st["glow_sigma"] * nsz) * (1 - name_mask)
    sh = _soft_shadow(name_mask, st["shadow_sigma"] * nsz, st["shadow_off"][0] * nsz, st["shadow_off"][1] * nsz) * (1 - name_mask)
    rsh = _soft_shadow(role_mask, max(1.0, 0.09 * st["role_size"] * sc * S), 0.05 * st["role_size"] * sc * S,
                       0.03 * st["role_size"] * sc * S) * (1 - role_mask)
    rys = np.nonzero(role_mask > 0.5)[0] if role_g else np.zeros(0, int)
    if rys.size:
        ry0, ry1 = rys.min(), rys.max()
        gg = np.clip((np.arange(H)[:, None] - ry0) / max(1, ry1 - ry0), 0, 1)
        white = np.dstack([255 - 27 * gg, 255 - 22 * gg, 255 - 14 * gg]) * np.ones((1, W, 1))
    else:
        white = np.full((H, W, 3), 255.0)
    if st["plate"] > 0:
        both = np.maximum(name_mask, role_mask)
        pl = _blur(cv2.dilate(both, np.ones((int(nsz * 0.25) | 1,) * 2, np.uint8)), st["plate_sigma"] * nsz)
        pl = np.clip(pl / max(1e-6, pl.max()), 0, 1) * st["plate"]
    else:
        pl = np.zeros_like(name_mask)
    P = np.zeros((H, W, 3)); A = np.zeros((H, W))

    def over_pm(P, A, rgb, a):
        return rgb * a[..., None] + P * (1 - a[..., None]), a + A * (1 - a)
    P, A = over_pm(P, A, np.array(st["plate_rgb"], np.float64), pl)
    P, A = over_pm(P, A, np.array([15, 50, 130], np.float64), np.clip(st["shadow"] * sh, 0, 1))
    P, A = over_pm(P, A, np.array([15, 50, 130], np.float64), np.clip(st["role_shadow"] * rsh, 0, 1))
    P, A = over_pm(P, A, np.array([225, 245, 255], np.float64), np.clip(st["glow"] * glow, 0, 1))
    Wo, Ho = W // S, H // S

    def dn(a):
        return cv2.resize(np.asarray(a, np.float32), (Wo, Ho), interpolation=cv2.INTER_AREA)
    O_pm, O_a = dn(P), dn(A)
    ra = np.clip(role_mask * 0.95, 0, 1)
    R_pm, R_a = dn(white * ra[..., None]), dn(ra)
    name_col = dn(np.clip(col, 0, 255) * alpha[..., None]); name_a = dn(alpha)
    specmap = dn(spec); coremap = dn(core); nmask = dn(name_mask)
    both = np.maximum(name_mask, role_mask)
    M = dn(both)
    lab_o = lab[::S, ::S][:Ho, :Wo]
    s0 = rf["slope_sat"]
    on = _tube_optics(name_mask, max(0.5, u), s0)
    orl = _tube_optics(role_mask, max(0.5, S * st["role_size"] * sc / 88.0), s0)
    tx_u = (on["sx"] * on["rad"] * name_mask + orl["sx"] * orl["rad"] * role_mask) / S        # tube = 1
    ty_u = (on["sy"] * on["rad"] * name_mask + orl["sy"] * orl["rad"] * role_mask) / S
    sl = rf["letter_sigma"] * nsz
    TL = cv2.GaussianBlur(both.astype(np.float32), (0, 0), sl)
    ly, lx = np.gradient(TL)
    kl_u = sl / 0.40 * 1.0 * st["name_size"] * sc                                                # letter = 1
    rimw = (on["rim"] ** rf["fres_pow"]) * (0.30 + 0.70 * on["lam"]) * name_mask \
        + (orl["rim"] ** rf["fres_pow"]) * (0.30 + 0.70 * orl["lam"]) * role_mask
    planes = {
        "M": M, "HC": dn(on["h"] * name_mask + orl["h"] * role_mask),
        "TXm": dn(tx_u), "TYm": dn(ty_u), "LXm": dn(lx * kl_u * both), "LYm": dn(ly * kl_u * both),
        "RIM": dn(rimw), "HL": dn(on["spec"] * name_mask + 0.7 * orl["spec"] * role_mask),
        "ABSm": dn(on["absorb"] * name_mask + orl["absorb"] * role_mask),
        "core": coremap, "spec": specmap,
        "NC_r": name_col[..., 0], "NC_g": name_col[..., 1], "NC_b": name_col[..., 2], "NA": name_a,
        "RP_r": R_pm[..., 0], "RP_g": R_pm[..., 1], "RP_b": R_pm[..., 2], "RA": R_a,
        "OO_r": O_pm[..., 0] * (1 - M), "OO_g": O_pm[..., 1] * (1 - M), "OO_b": O_pm[..., 2] * (1 - M), "OA": O_a * (1 - M),
    }
    l1, w1, l2, w2 = _top2_labels(lab_o, nlab)
    planes.update(l1=l1, w1=w1, l2=l2, w2=w2)
    planes = {k: np.ascontiguousarray(v, np.int16 if k in ("l1", "l2") else np.float32) for k, v in planes.items()}
    ys, xs = np.nonzero(both > 0.5)
    ink = [xs.min() / S, ys.min() / S, (xs.max() + 1) / S, (ys.max() + 1) / S]
    nys, nxs = np.nonzero(name_mask > 0.5)
    name_ink = [nxs.min() / S, nys.min() / S, (nxs.max() + 1) / S, (nys.max() + 1) / S]
    sp = specmap * (nmask > 0.5)
    glints = []
    if st["glints"] > 0 and sp.max() > 0:            # v3 drew one glint for glints = 0 (max(1, n)); here 0 = none
        thr = np.percentile(sp[sp > 0], 97)
        ys2, xs2 = np.nonzero(sp >= thr)
        order = np.argsort(xs2)
        for q in np.linspace(0.12, 0.88, st["glints"]):
            kk = order[int(q * (len(order) - 1))]
            glints.append([int(xs2[kk]), int(ys2[kk])])
    rng = np.random.default_rng(int(credit_n["seed"]) + 77)
    nl = max(1, nlab)
    letter_base = 1 + st["letter_var"] * (rng.random(nl) * 2 - 1) * 0.6
    letter_ph = rng.random(nl) * 2 * math.pi
    letter_hz = 0.20 + 0.25 * rng.random(nl)
    return {"empty": False, "W": Wo, "H": Ho, "planes": planes, "ink": [float(v) for v in ink],
            "name_ink": [float(v) for v in name_ink], "glints": glints,
            "cx": float((ink[0] + ink[2]) / 2), "cy": float((ink[1] + ink[3]) / 2), "nlab": int(nlab),
            "letter_base": [float(v) for v in letter_base], "letter_ph": [float(v) for v in letter_ph],
            "letter_hz": [float(v) for v in letter_hz], "name_size": float(st["name_size"]),
            "build_ms": round((time.perf_counter() - t0) * 1000, 1)}


def origin_of(master: dict, credit_n: dict) -> tuple[int, int]:
    """integer design-px origin of the master canvas from pos (v3: round(X - ax), round(Y - ink_y0), Python rounding)."""
    ink = master["ink"]
    X, Y = credit_n["pos"]
    ax = {"left": ink[0], "center": (ink[0] + ink[2]) / 2, "right": ink[2]}[credit_n["align"]]
    return int(round(X - ax)), int(round(Y - ink[1]))


# ── master cache ──────────────────────────────────────────────────────────────────────────────────────────────────

_MEM: "OrderedDict[str, dict]" = OrderedDict()
_MEM_MAX = 6
_MEM_LOCK = threading.Lock()
_KEY_LOCKS: dict[str, threading.Lock] = {}
_BUILD_SEM = threading.BoundedSemaphore(2)          # at most 2 concurrent master builds (production stays responsive)
DISK_CAP = 1 << 30


def cache_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "data" / "credit_cache" / "master"


def _font_stamp(credit_n: dict) -> list:
    out = []
    for role in FONT_ROLES:
        p = font_path(credit_n["style"]["fonts"][role])
        try:
            s = p.stat() if p else None
            out.append([role, p.name if p else None, s.st_size if s else 0, s.st_mtime_ns if s else 0])
        except OSError:
            out.append([role, None, 0, 0])
    return out


def master_key(credit_n: dict) -> str:
    return _sha1({"maps_version": MAPS_VERSION, "build_rev": BUILD_REV, "subset": map_subset(credit_n, with_pos=False),
                  "fonts": _font_stamp(credit_n)})


def _save_disk(key: str, m: dict) -> None:
    d = cache_dir()
    try:
        d.mkdir(parents=True, exist_ok=True)
        meta = {k: v for k, v in m.items() if k != "planes"}
        tmp = d / f".{key}.{os.getpid()}.{threading.get_ident()}.tmp.npz"
        np.savez_compressed(tmp, _meta=np.frombuffer(json.dumps(meta).encode(), np.uint8), **m["planes"])
        os.replace(tmp, d / f"{key}.npz")
        files = sorted((p for p in d.glob("*.npz")), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        while files and total > DISK_CAP:
            p = files.pop(0)
            total -= p.stat().st_size
            p.unlink(missing_ok=True)
    except Exception:
        pass                                          # the cache is an optimisation only


def _load_disk(key: str) -> Optional[dict]:
    p = cache_dir() / f"{key}.npz"
    if not p.is_file():
        return None
    try:
        with np.load(p) as z:
            meta = json.loads(bytes(z["_meta"]).decode())
            planes = {k: z[k] for k in z.files if k != "_meta"}
        if not meta.get("empty") and set(planes) != set(PLANES):
            return None
        meta["planes"] = planes
        os.utime(p)
        return meta
    except Exception:
        return None


def get_master(credit_n: dict, use_disk: bool = True) -> tuple[dict, bool]:
    """-> (master, from_cache). Same key requested twice at once builds once (per-key lock)."""
    key = master_key(credit_n)
    with _MEM_LOCK:
        m = _MEM.get(key)
        if m is not None:
            _MEM.move_to_end(key)
            return m, True
        lk = _KEY_LOCKS.setdefault(key, threading.Lock())
    with lk:
        with _MEM_LOCK:
            m = _MEM.get(key)
            if m is not None:
                _MEM.move_to_end(key)
                return m, True
        m = _load_disk(key) if use_disk else None
        cached = m is not None
        if m is None:
            with _BUILD_SEM:
                m = build_master(credit_n)
            if use_disk:
                _save_disk(key, m)
        with _MEM_LOCK:
            _MEM[key] = m
            _MEM.move_to_end(key)
            while len(_MEM) > _MEM_MAX:
                _MEM.popitem(last=False)
            _KEY_LOCKS.pop(key, None)
        return m, cached


# ── geometry (§3) ─────────────────────────────────────────────────────────────────────────────────────────────────

def geometry(box, content) -> dict:
    """design (2560x1440) -> output box mapping. corner map: u_box = u_design*K + cx ; v_box = v_design*K + cy
    (= (u_design + off_d.x)*K - off_o.x; written so that the identity case is exact)."""
    Wd, Hd = DESIGN
    Wc, Hc = float(content[0]), float(content[1])
    bw, bh = float(box[0]), float(box[1])
    s_d = max(Wd / Wc, Hd / Hc)
    off_d = ((Wc * s_d - Wd) / 2, (Hc * s_d - Hd) / 2)
    s_o = max(bw / Wc, bh / Hc)
    off_o = ((Wc * s_o - bw) / 2, (Hc * s_o - bh) / 2)
    K = s_o / s_d
    return {"K": K, "s_d": s_d, "s_o": s_o, "off_d": off_d, "off_o": off_o,
            "cx": off_d[0] * K - off_o[0], "cy": off_d[1] * K - off_o[1]}


def _overlap(a: np.ndarray, b: np.ndarray, j0: int, j1: int):
    """sparse W[j - j0, i] = |[j, j+1) ∩ [a_i, b_i)| for box px j in [j0, j1) (CSC, scipy.sparse: single-threaded C,
    exact 0/1 weights at K = 1). Dense BLAS is avoided on purpose: OpenBLAS's thread pool thrashes on a loaded box."""
    from scipy import sparse
    lo = np.floor(a).astype(np.int64)
    hi = np.ceil(b).astype(np.int64)
    rows, cols, vals = [], [], []
    idx = np.arange(len(a))
    for t in range(int((hi - lo).max()) + 1 if len(a) else 0):
        j = lo + t
        v = np.minimum(j + 1, b) - np.maximum(j, a)
        ok = (v > 0) & (j >= j0) & (j < j1)
        rows.append(j[ok] - j0); cols.append(idx[ok]); vals.append(v[ok])
    r = np.concatenate(rows) if rows else np.zeros(0, np.int64)
    c = np.concatenate(cols) if cols else np.zeros(0, np.int64)
    v = np.concatenate(vals) if vals else np.zeros(0)
    return sparse.csc_matrix((v, (r, c)), shape=(j1 - j0, len(a)))


def map_fields(master: dict, credit_n: dict, box, content, key: Optional[str] = None) -> tuple[dict, dict]:
    """master -> (maps {name: float32 HxW}, header) on the output box grid (§4.2). Pure; no DB."""
    t0 = time.perf_counter()
    bw, bh = int(box[0]), int(box[1])
    Wc, Hc = int(content[0]), int(content[1])
    G = geometry((bw, bh), (Wc, Hc))
    K, ccx, ccy = G["K"], G["cx"], G["cy"]
    hdr = {"v": 1, "key": key or maps_key(credit_n, (bw, bh), (Wc, Hc)), "box": [bw, bh], "content": [Wc, Hc], "k": K,
           "x0": 0, "y0": 0, "W": 0, "H": 0, "cx": 0.0, "cy": 0.0, "name_ink": [0.0, 0.0, 0.0, 0.0], "glints": [],
           "nlab": int(master["nlab"]), "letter_base": list(master["letter_base"]), "letter_ph": list(master["letter_ph"]),
           "letter_hz": list(master["letter_hz"]), "star_r": 0.20 * master["name_size"] * K,
           "max_t": 0.0, "max_l": 0.0, "max_r": 0.0, "ink_box_design": [0.0, 0.0, 0.0, 0.0],
           "ink_box_box": [0.0, 0.0, 0.0, 0.0], "empty": True, "build_ms": 0.0,
           "textures": copy.deepcopy(TEXTURES)}
    if master["empty"]:
        hdr["build_ms"] = round(master.get("build_ms", 0.0) + (time.perf_counter() - t0) * 1000, 1)
        return {}, hdr
    oxi, oyi = origin_of(master, credit_n)
    ink = master["ink"]
    ibd = [oxi + ink[0], oyi + ink[1], oxi + ink[2], oyi + ink[3]]
    hdr["ink_box_design"] = [float(v) for v in ibd]
    hdr["ink_box_box"] = [ibd[0] * K + ccx, ibd[1] * K + ccy, ibd[2] * K + ccx, ibd[3] * K + ccy]
    Wm, Hm = master["W"], master["H"]
    ax = (oxi + np.arange(Wm, dtype=np.float64)) * K + ccx
    bx = (oxi + np.arange(1, Wm + 1, dtype=np.float64)) * K + ccx
    ay = (oyi + np.arange(Hm, dtype=np.float64)) * K + ccy
    by = (oyi + np.arange(1, Hm + 1, dtype=np.float64)) * K + ccy
    jx0 = max(0, int(math.floor(ax[0])) - 1); jx1 = min(bw, int(math.ceil(bx[-1])) + 1)
    jy0 = max(0, int(math.floor(ay[0])) - 1); jy1 = min(bh, int(math.ceil(by[-1])) + 1)
    if jx1 <= jx0 or jy1 <= jy0:                      # the card is completely outside the box
        hdr["build_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        return {}, hdr
    Wx = _overlap(ax, bx, jx0, jx1)                   # (W, Wm)
    Wy = _overlap(ay, by, jy0, jy1)                   # (H, Hm)
    W, H = jx1 - jx0, jy1 - jy0
    pl = master["planes"]

    def area(P):
        T1 = Wy @ np.asarray(P, np.float64)            # (H, Wm) dense
        return np.asarray((Wx @ T1.T).T)               # (H, W)

    Ma = area(pl["M"])
    cov = Ma > 1e-4
    Mc = np.where(cov, Ma, 1.0)
    out = {"M": Ma}
    for k in ("RIM", "HL", "core", "spec", "NC_r", "NC_g", "NC_b", "NA", "RP_r", "RP_g", "RP_b", "RA",
              "OO_r", "OO_g", "OO_b", "OA"):
        out[k] = area(pl[k])
    out["HN"] = np.where(cov, area(pl["HC"]) / Mc, 0.0)
    out["ABSn"] = np.where(cov, area(pl["ABSm"]) / Mc, 0.0)
    for src, dst in (("TXm", "TX"), ("TYm", "TY"), ("LXm", "LX"), ("LYm", "LY")):
        out[dst] = np.where(cov, K * area(pl[src]) / Mc, 0.0)
    # labels: W_l = area(NA·w_l) / area(NA); keep the two largest
    NAm = pl["NA"].astype(np.float64)
    NAa = out["NA"]
    nz = NAa > 1e-6
    NAd = np.where(nz, NAa, 1.0)
    L1 = np.full((H, W), -1.0); L2 = np.full((H, W), -1.0); W1 = np.zeros((H, W)); W2 = np.zeros((H, W))
    ml1, ml2, mw1, mw2 = pl["l1"], pl["l2"], pl["w1"].astype(np.float64), pl["w2"].astype(np.float64)
    for l in range(int(master["nlab"])):
        wl = np.where(ml1 == l, mw1, 0.0) + np.where(ml2 == l, mw2, 0.0)
        ys, xs = np.nonzero(wl > 0)
        if ys.size == 0:
            continue
        ya, yb, xa, xb = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        T1 = Wy[:, ya:yb] @ (NAm[ya:yb, xa:xb] * wl[ya:yb, xa:xb])
        part = np.asarray((Wx[:, xa:xb] @ T1.T).T)
        Wl = np.where(nz, part / NAd, 0.0)
        top = Wl > W1
        sec = (~top) & (Wl > W2)
        L2 = np.where(top, L1, np.where(sec, l, L2)); W2 = np.where(top, W1, np.where(sec, Wl, W2))
        L1 = np.where(top, l, L1); W1 = np.where(top, Wl, W1)
    L1 = np.where(W1 > 0, L1, -1.0); W1 = np.where(W1 > 0, W1, 0.0)
    L2 = np.where(W2 > 0, L2, -1.0); W2 = np.where(W2 > 0, W2, 0.0)
    out.update(l1=L1, w1=W1, l2=L2, w2=W2, zero=np.zeros((H, W)))
    maps = {k: np.ascontiguousarray(v, np.float32) for k, v in out.items()}

    def pt(px, py):
        return ((oxi + px + 0.5) * K + ccx - 0.5 - jx0, (oyi + py + 0.5) * K + ccy - 0.5 - jy0)
    cx, cy = pt(master["cx"], master["cy"])
    ni = master["name_ink"]
    a = pt(ni[0], ni[1]); b = pt(ni[2], ni[3])
    hdr.update(x0=int(jx0), y0=int(jy0), W=int(W), H=int(H), cx=float(cx), cy=float(cy),
               name_ink=[float(a[0]), float(a[1]), float(b[0]), float(b[1])],
               glints=[[float(v) for v in pt(gx, gy)] for gx, gy in master["glints"]], empty=False)
    hdr["max_t"] = float(np.sqrt(maps["TX"].astype(np.float64) ** 2 + maps["TY"].astype(np.float64) ** 2).max())
    hdr["max_l"] = float(np.sqrt(maps["LX"].astype(np.float64) ** 2 + maps["LY"].astype(np.float64) ** 2).max())
    yy, xx = np.nonzero(maps["M"] > 0)
    hdr["max_r"] = float(np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2).max()) if xx.size else 0.0
    hdr["build_ms"] = round(master.get("build_ms", 0.0) + (time.perf_counter() - t0) * 1000, 1)
    return maps, hdr


def card_maps(credit: Any, box, content, use_disk: bool = True,
              max_canvas_px: Optional[int] = None) -> tuple[dict, dict, dict]:
    """credit (any) -> (normalized credit, maps, header); the master comes from the cache.
    max_canvas_px (API only): refuse (CreditError 413) when the map canvas on the box grid would exceed this many px
    (map_fields holds ~30 float64 planes of that size; the API runs inside the production backend process)."""
    cn = normalize(credit)
    m, cached = get_master(cn, use_disk=use_disk)
    if max_canvas_px and not m["empty"]:
        K = geometry(box, content)["K"]
        est = (m["W"] * K + 3) * (m["H"] * K + 3)
        if est > max_canvas_px:
            raise CreditError(f"字幕の地図が大きすぎます(約 {int(est):,} px > {int(max_canvas_px):,} px。枠を小さくしてください)",
                              413)
    t0 = time.perf_counter()
    maps, hdr = map_fields(m, cn, box, content)
    hdr["build_ms"] = round((0.0 if cached else m.get("build_ms", 0.0)) + (time.perf_counter() - t0) * 1000, 1)
    return cn, maps, hdr


# ── KCM1 binary (§5) ──────────────────────────────────────────────────────────────────────────────────────────────

def pack_kcm1(maps: dict, hdr: dict) -> bytes:
    h = {k: hdr[k] for k in HEADER_FIELDS}
    h["textures"] = copy.deepcopy(TEXTURES)
    if hdr["empty"] or not maps:
        h.update(empty=True, W=0, H=0)
    js = json.dumps(h, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    js += b" " * ((-len(js)) % 4)
    parts = [b"KCM1", struct.pack("<I", len(js)), js]
    if not h["empty"]:
        for t in TEXTURES:
            arr = np.stack([maps[c] for c in t["channels"]], axis=-1).astype("<f4")
            parts.append(np.ascontiguousarray(arr).tobytes())
    return b"".join(parts)


def parse_kcm1(data: bytes) -> tuple[dict, dict]:
    if data[:4] != b"KCM1":
        raise ValueError("not a KCM1 blob")
    n = struct.unpack("<I", data[4:8])[0]
    hdr = json.loads(data[8:8 + n].decode("utf-8"))
    maps = {}
    off = 8 + n
    W, H = hdr["W"], hdr["H"]
    if not hdr["empty"]:
        for t in hdr["textures"]:
            sz = W * H * 4 * 4
            arr = np.frombuffer(data[off:off + sz], "<f4").reshape(H, W, 4)
            for c, ch in enumerate(t["channels"]):
                maps[ch] = arr[..., c].astype(np.float32)
            off += sz
    return maps, hdr


def gzip_bytes(b: bytes, level: int = 4) -> bytes:
    return gzip.compress(b, compresslevel=level, mtime=0)


# ── per-frame formula (§6) ────────────────────────────────────────────────────────────────────────────────────────

def ease(x: float) -> float:
    c = min(1.0, max(0.0, x))
    return c * c * (3 - 2 * c)


def frame_scalars(credit_n: dict, hdr: dict, start_frame: int, duration_frames: int, opacity: Optional[float],
                  f: int, fps: float) -> dict:
    """per clip / per frame scalars in double precision. The TS twin (creditLook.frameScalars) must give the same values
    (<= 1e-9): keep the evaluation order of every expression (fixtures/scalars_vectors.json)."""
    tm, st, rf = credit_n["timing"], credit_n["style"], credit_n["refract"]
    i = f - start_frame
    dur = duration_frames
    a = tm["appear_frames"]; d = tm["disappear_frames"]
    active = (0 <= i < dur) and not hdr["empty"]
    e = min(ease((i + 1) / (a + 1)), ease((dur - i) / (d + 1)))
    g0 = rf["g0"]
    s = min(1.0, max(0.0, (e - g0) / (1 - g0)))
    g = ease(s)
    pre = e * (1 - g)
    n_max = rf["n_max"]
    F0 = ((n_max - 1) / (n_max + 1)) ** 2
    disp = rf["disp"]
    kR = e * (1 - disp * e); kG = e; kB = e * (1 + disp * e)
    fresw = rf["fres"] * pre
    absw = rf["absorb"] * pre
    hlw = 255 * rf["hl"] * 1.1 * e ** 1.5 * (1 - g)
    t = f / fps
    fac = [lb * (1 + 0.02 * math.sin(2 * math.pi * hz * t + ph))
           for lb, ph, hz in zip(hdr["letter_base"], hdr["letter_ph"], hdr["letter_hz"])]
    sw0 = tm["sheen_start"] if tm["sheen_start"] is not None else a - 2
    sw1 = tm["sheen_end"] if tm["sheen_end"] is not None else dur - d + 2
    q = (i - sw0) / (sw1 - sw0) if sw1 > sw0 else 0.0
    on = st["sheen"] > 0 and sw1 > sw0 and -0.05 <= q <= 1.05
    nx0, ny0, nx1, ny1 = hdr["name_ink"]
    w = nx1 - nx0
    pos = nx0 - 0.35 * w + 1.7 * w * q
    yc = (ny0 + ny1) / 2
    bw = st["sheen_width"] * (ny1 - ny0)
    amp = ease((q + 0.05) / 0.25) * ease((1.05 - q) / 0.25) if on else 0.0
    inten = []
    for gx, gy in hdr["glints"]:
        b = amp * math.exp(-(((gx - pos) + 0.55 * (gy - yc)) / bw) ** 2) if (on and bw > 0) else 0.0
        inten.append(0.65 * b if b >= 0.08 else 0.0)
    o = 1.0 if opacity is None else min(1.0, max(0.0, float(opacity)))
    return {"active": bool(active), "i": i, "e": e, "s": s, "g": g, "pre": pre, "F0": F0, "kR": kR, "kG": kG, "kB": kB,
            "fresw": fresw, "absw": absw, "hlw": hlw, "t": t, "fac": fac, "sheen_on": bool(on), "q": q,
            "pos": pos, "yc": yc, "bw": bw, "amp": amp, "inten": inten, "o": o,
            # copies of the uniforms the pixel formula needs (not part of the parity vectors)
            "tube": rf["tube"], "letter": rf["letter"], "zoom": rf["zoom"], "sheen": st["sheen"], "fill_q": rf["fill_q"],
            "fres_rgb": list(rf["fres_rgb"]), "star_r": hdr["star_r"], "k": hdr["k"]}


def _bilin(ch: np.ndarray, mx: np.ndarray, my: np.ndarray, bw: int, bh: int, px0: int, py0: int) -> np.ndarray:
    """float bilinear of one picture channel at box coordinates (mx, my), clamped to [0, bw-1]x[0, bh-1].
    ch covers box px [px0, px0 + w) x [py0, py0 + h)."""
    h, w = ch.shape
    x = np.clip(mx, 0, bw - 1); y = np.clip(my, 0, bh - 1)
    xi = np.floor(x); yi = np.floor(y)
    fx = x - xi; fy = y - yi
    xi = xi.astype(np.int64); yi = yi.astype(np.int64)
    x1 = np.minimum(xi + 1, bw - 1); y1 = np.minimum(yi + 1, bh - 1)
    xa = np.clip(xi - px0, 0, w - 1); xb = np.clip(x1 - px0, 0, w - 1)
    ya = np.clip(yi - py0, 0, h - 1); yb = np.clip(y1 - py0, 0, h - 1)
    return (ch[ya, xa] * (1 - fx) + ch[ya, xb] * fx) * (1 - fy) + (ch[yb, xa] * (1 - fx) + ch[yb, xb] * fx) * fy


STAR_RGB = np.array([255.0, 253.0, 246.0])
SHEEN_RGB = np.array([0.92, 0.97, 1.0])


def compose_rgb(maps: dict, hdr: dict, sc: dict, pic: np.ndarray, pic_x0: int = 0, pic_y0: int = 0,
                want_parts: bool = False):
    """§6 per-pixel formula over the map canvas. pic = float RGB (0..255) covering box px [pic_x0, ...) x [pic_y0, ...),
    at least the map canvas and its refraction margin. -> (out RGB float64 HxWx3 for box px [x0, x0+W) x [y0, y0+H),
    A float64 HxW). Pixels with A = 0 come back equal to the picture (clamped to 0..255)."""
    H, W = hdr["H"], hdr["W"]
    x0, y0 = hdr["x0"], hdr["y0"]
    bw, bh = hdr["box"]
    f8 = lambda k: maps[k].astype(np.float64)
    M = f8("M")
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)
    cx, cy = hdr["cx"], hdr["cy"]
    Dx = sc["tube"] * f8("TX") + sc["letter"] * f8("LX") - sc["zoom"] * (xx - cx) * M
    Dy = sc["tube"] * f8("TY") + sc["letter"] * f8("LY") - sc["zoom"] * (yy - cy) * M
    X = xx + x0; Y = yy + y0
    picd = pic.astype(np.float64, copy=False)
    RGB = np.empty((H, W, 3))
    for c, k in enumerate((sc["kR"], sc["kG"], sc["kB"])):
        RGB[..., c] = _bilin(picd[..., c], X + Dx * k, Y + Dy * k, bw, bh, pic_x0, pic_y0)
    RGB *= (1 - sc["absw"] * f8("ABSn"))[..., None]
    F0 = sc["F0"]
    add = (sc["fresw"] * (F0 + (1 - F0) * f8("RIM")))[..., None] * np.array(sc["fres_rgb"], np.float64) \
        + (sc["hlw"] * f8("HL"))[..., None]
    body = RGB * M[..., None] + add
    fac = np.concatenate([np.asarray(sc["fac"], np.float64), [1.0]])
    nf = len(fac) - 1
    l1 = np.rint(f8("l1")).astype(np.int64); l2 = np.rint(f8("l2")).astype(np.int64)
    l1 = np.where((l1 >= 0) & (l1 < nf), l1, nf); l2 = np.where((l2 >= 0) & (l2 < nf), l2, nf)
    fm = 1 + f8("w1") * (fac[l1] - 1) + f8("w2") * (fac[l2] - 1)
    NC = np.dstack([f8("NC_r"), f8("NC_g"), f8("NC_b")]) * fm[..., None]
    NA = f8("NA")
    if sc["sheen_on"]:
        band = sc["amp"] * np.exp(-(((xx - sc["pos"]) + 0.55 * (yy - sc["yc"])) / sc["bw"]) ** 2)
        NC += (255 * band * (0.35 + 0.65 * f8("core")) * sc["sheen"] * NA)[..., None] * SHEEN_RGB
        NC += (255 * 1.2 * band * f8("spec"))[..., None]
    Gpm = NC + np.dstack([f8("RP_r"), f8("RP_g"), f8("RP_b")])
    Ga = NA + f8("RA")
    fq = sc["fill_q"]
    kq = np.clip(sc["s"] * (1 + fq) - fq * f8("HN"), 0, 1)
    gm = kq * kq * (3 - 2 * kq)
    Gpm *= gm[..., None]; Ga *= gm
    body = Gpm + (1 - np.clip(Ga / np.maximum(M, 1e-6), 0, 1))[..., None] * body
    g = sc["g"]
    P = body + np.dstack([f8("OO_r"), f8("OO_g"), f8("OO_b")]) * g
    A = M + f8("OA") * g
    if g > 0 and any(v > 0 for v in sc["inten"]):
        r = sc["star_r"]; k = sc["k"]
        cw = 0.10 * r + 0.6 * k; rw = 0.035 * r + 0.5 * k
        keep = np.ones((H, W))
        R = int(math.ceil(1.2 * r + 2)) + 1
        offs = (np.arange(4) + 0.5) / 4 - 0.5
        for (gx, gy), inten in zip(hdr["glints"], sc["inten"]):
            if inten <= 0:
                continue
            xa, xb = max(0, int(math.floor(gx)) - R), min(W, int(math.ceil(gx)) + R + 1)
            ya, yb = max(0, int(math.floor(gy)) - R), min(H, int(math.ceil(gy)) + R + 1)
            if xb <= xa or yb <= ya:
                continue
            Yb, Xb = np.mgrid[ya:yb, xa:xb].astype(np.float64)
            acc = np.zeros(Xb.shape)
            for oy in offs:
                for ox in offs:
                    dx = Xb + ox - gx; dy = Yb + oy - gy
                    rr = np.sqrt(dx * dx + dy * dy) + 1e-3
                    core = np.exp(-(rr / cw) ** 2)
                    rays = (np.exp(-(dy / rw) ** 2) + np.exp(-(dx / rw) ** 2)) * np.clip(1 - rr / r, 0, 1) ** 1.6
                    acc += np.clip((core + 0.8 * rays) * inten, 0, 1)
            keep[ya:yb, xa:xb] *= 1 - acc / 16
        Sg = g * (1 - keep)
        P = STAR_RGB * Sg[..., None] + (1 - Sg)[..., None] * P
        A = Sg + (1 - Sg) * A
    P = np.minimum(P, 255 * A[..., None])
    o = sc["o"]
    P *= o; A = A * o
    under = picd[y0 - pic_y0:y0 - pic_y0 + H, x0 - pic_x0:x0 - pic_x0 + W]
    out = np.clip(P + (1 - A)[..., None] * under, 0, 255)
    if want_parts:
        return out, A, {"P": P}
    return out, A


def apply_rgb(pic: np.ndarray, maps: dict, hdr: dict, sc: dict) -> np.ndarray:
    """whole-box helper: pic (bh, bw, 3) float -> a copy with the card composed (pixels with A = 0 untouched)."""
    out = np.array(pic, np.float64, copy=True)
    if hdr["empty"] or not sc["active"]:
        return out
    o, A = compose_rgb(maps, hdr, sc, out, 0, 0)
    x0, y0, W, H = hdr["x0"], hdr["y0"], hdr["W"], hdr["H"]
    reg = out[y0:y0 + H, x0:x0 + W]
    m = A > A_WRITE_EPS
    reg[m] = o[m]
    return out


# ── YUV 4:2:0 helpers (BT.709 limited, H.264 default chroma siting) ──────────────────────────────────────────────

def upsample_chroma(C: np.ndarray, x0: int, x1: int, y0: int, y1: int) -> np.ndarray:
    """chroma plane C (h/2, w/2) -> values on luma px [x0, x1) x [y0, y1) (float64). Vertical: centred
    (y = 2k -> 0.75 C[k] + 0.25 C[k-1], y = 2k+1 -> 0.75 C[k] + 0.25 C[k+1]); horizontal: co-sited (even x = C[x/2],
    odd x = mean of the two neighbours); edges clamped. Vertical first, then horizontal."""
    hc, wc = C.shape
    ys = np.arange(y0, y1)
    k = ys // 2
    kn = np.where(ys % 2 == 0, k - 1, k + 1)
    k = np.clip(k, 0, hc - 1); kn = np.clip(kn, 0, hc - 1)
    xs = np.arange(x0, x1)
    xa = np.clip(xs // 2, 0, wc - 1)
    xb = np.clip(np.where(xs % 2 == 0, xs // 2, xs // 2 + 1), 0, wc - 1)
    cols = np.unique(np.concatenate([xa, xb]))
    Cd = C[:, cols].astype(np.float64)
    V = 0.75 * Cd[k] + 0.25 * Cd[kn]                      # (len(ys), len(cols))
    ia = np.searchsorted(cols, xa); ib = np.searchsorted(cols, xb)
    return 0.5 * (V[:, ia] + V[:, ib])


def yuv_to_rgb(Yp: np.ndarray, U: np.ndarray, V: np.ndarray) -> np.ndarray:
    """BT.709 limited range -> RGB float 0..255 scale, NO clamping (Y, U, V on the same grid, float)."""
    Ey = (Yp - 16) / 219
    Pb = (U - 128) / 224
    Pr = (V - 128) / 224
    R = 255 * (Ey + 1.5748 * Pr)
    B = 255 * (Ey + 1.8556 * Pb)
    G = 255 * (Ey - (0.2126 * 1.5748 * Pr + 0.0722 * 1.8556 * Pb) / 0.7152)
    return np.dstack([R, G, B])


def rgb_to_ypbpr(rgb: np.ndarray):
    Ey = (0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]) / 255
    Pb = (rgb[..., 2] / 255 - Ey) / 1.8556
    Pr = (rgb[..., 0] / 255 - Ey) / 1.5748
    return Ey, Pb, Pr


def _even_lo(v: int) -> int:
    return v - (v % 2)


def _even_hi(v: int) -> int:
    return v + (v % 2)


def apply_card_yuv(Yp: np.ndarray, Up: np.ndarray, Vp: np.ndarray, card: dict, f: int, fps: float) -> bool:
    """compose one card IN PLACE on a yuv420p frame (planes uint8, writable). Only pixels with A > 0 and the 2x2 chroma
    blocks that contain one are rewritten. -> True if anything was written."""
    hdr, maps, cn = card["hdr"], card["maps"], card["credit"]
    sc = frame_scalars(cn, hdr, card["start"], card["dur"], card["opacity"], f, fps)
    if not sc["active"] or sc["o"] <= 0:
        return False
    fh, fw = Yp.shape
    rx, ry, bw, bh = card["rect"]                     # box in frame px (even)
    # card rect Rc (frame px, even) = map canvas; sample rect Rs = Rc + margin, clamped to the box
    cx0 = _even_lo(rx + hdr["x0"]); cy0 = _even_lo(ry + hdr["y0"])
    cx1 = min(rx + bw, _even_hi(rx + hdr["x0"] + hdr["W"])); cy1 = min(ry + bh, _even_hi(ry + hdr["y0"] + hdr["H"]))
    m = int(math.ceil(sc["kB"] * (sc["tube"] * hdr["max_t"] + sc["letter"] * hdr["max_l"] + sc["zoom"] * hdr["max_r"]))) + 2
    sx0 = max(rx, _even_lo(cx0 - m)); sy0 = max(ry, _even_lo(cy0 - m))
    sx1 = min(rx + bw, _even_hi(cx1 + m)); sy1 = min(ry + bh, _even_hi(cy1 + m))
    Us = upsample_chroma(Up, sx0, sx1, sy0, sy1)
    Vs = upsample_chroma(Vp, sx0, sx1, sy0, sy1)
    pic = yuv_to_rgb(Yp[sy0:sy1, sx0:sx1].astype(np.float64), Us, Vs)
    out, A = compose_rgb(maps, hdr, sc, pic, sx0 - rx, sy0 - ry)
    # write back on Rc: canvas px (x0 + rx + i) -> frame px
    X0, Y0 = rx + hdr["x0"], ry + hdr["y0"]
    Ey, Pb, Pr = rgb_to_ypbpr(out)
    sel = A > A_WRITE_EPS                             # the faint halo (A <= 1/1024: < 0.25 code values) keeps its bytes
    if not sel.any():
        return False
    Yreg = Yp[Y0:Y0 + hdr["H"], X0:X0 + hdr["W"]]
    Ynew = np.clip(np.floor(16 + 219 * Ey + 0.5), 0, 255)
    Yreg[sel] = Ynew[sel].astype(np.uint8)
    # chroma: per 2x2 block of Rc, U += mean over its 4 px of (U_new - U_up) (0 where A = 0)
    Hr, Wr = cy1 - cy0, cx1 - cx0
    dU = np.zeros((Hr, Wr)); dV = np.zeros((Hr, Wr)); hit = np.zeros((Hr, Wr), bool)
    oy, ox = Y0 - cy0, X0 - cx0
    Uup = Us[Y0 - sy0:Y0 - sy0 + hdr["H"], X0 - sx0:X0 - sx0 + hdr["W"]]
    Vup = Vs[Y0 - sy0:Y0 - sy0 + hdr["H"], X0 - sx0:X0 - sx0 + hdr["W"]]
    hh, ww = min(hdr["H"], Hr - oy), min(hdr["W"], Wr - ox)
    s2 = sel[:hh, :ww]
    dU[oy:oy + hh, ox:ox + ww] = np.where(s2, (128 + 224 * Pb[:hh, :ww]) - Uup[:hh, :ww], 0.0)
    dV[oy:oy + hh, ox:ox + ww] = np.where(s2, (128 + 224 * Pr[:hh, :ww]) - Vup[:hh, :ww], 0.0)
    hit[oy:oy + hh, ox:ox + ww] = s2
    mU = dU.reshape(Hr // 2, 2, Wr // 2, 2).mean(axis=(1, 3))
    mV = dV.reshape(Hr // 2, 2, Wr // 2, 2).mean(axis=(1, 3))
    blk = hit.reshape(Hr // 2, 2, Wr // 2, 2).any(axis=(1, 3))
    Ub = Up[cy0 // 2:cy1 // 2, cx0 // 2:cx1 // 2]
    Vb = Vp[cy0 // 2:cy1 // 2, cx0 // 2:cx1 // 2]
    Ub[blk] = np.clip(np.floor(Ub[blk] + mU[blk] + 0.5), 0, 255).astype(np.uint8)
    Vb[blk] = np.clip(np.floor(Vb[blk] + mV[blk] + 0.5), 0, 255).astype(np.uint8)
    return True


# ── export pass: python -m app.services.credit_fx render <plan.json> ──────────────────────────────────────────────

def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        import shutil
        return shutil.which("ffmpeg") or "ffmpeg"


def _fps_arg(fps: float) -> str:
    from fractions import Fraction
    if abs(fps - round(fps)) < 1e-6:
        return str(int(round(fps)))
    fr = Fraction(fps).limit_denominator(1001)
    return f"{fr.numerator}/{fr.denominator}"


def decode_cmd(ff: str, path: str) -> list[str]:
    return [ff, "-nostdin", "-v", "error", "-i", str(path), "-map", "0:v:0", "-vf", "format=yuv420p",
            "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]


def encode_cmd(ff: str, out: str, w: int, h: int, fps: float) -> list[str]:
    return [ff, "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", f"{w}x{h}",
            "-r", _fps_arg(fps), "-i", "-",
            "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", str(out)]


def rect_px(rect, W: int, H: int):
    from app.services.satsuei_fx import rect_px as _rp
    return _rp(rect, W, H)


def prepare_plan(plan: dict, use_disk: bool = True) -> tuple[list[dict], list[list[int]]]:
    """plan -> (cards in apply order, per frame j the card indexes active at f0 + j). Masters and maps are built here
    (in the parent, before the worker pool)."""
    w, h, n = int(plan["w"]), int(plan["h"]), int(plan["frames"])
    f0 = int(plan.get("f0") or 0)
    fps = float(plan.get("fps") or 24.0)
    content = plan.get("content") or [w, h]
    cards: list[dict] = []
    skipped = plan.setdefault("_skipped", [])
    for layer in plan.get("layers") or []:
        r = rect_px(layer.get("rect"), w, h)
        rx, ry, bw, bh = r if r else (0, 0, w, h)
        clips = sorted(layer.get("clips") or [], key=lambda c: (int(c["start"]), int(c.get("id") or 0)))
        for c in clips:
            dur = int(c["dur"])
            op = c.get("opacity")
            o = 1.0 if op is None else min(1.0, max(0.0, float(op)))
            if dur <= 0 or o <= 0:
                continue
            try:
                cn, maps, hdr = card_maps(c.get("credit"), (bw, bh), content, use_disk=use_disk)
            except CreditError as e:
                if e.status >= 500:                   # environment (a missing font): fail the render loudly
                    raise
                # a card that cannot be built (too large): the preview draws nothing for it either, so the export
                # leaves it out instead of failing the whole render; the warning reaches the job log (stderr tail)
                print(f"WARN credit clip {c.get('id')} skipped: {e}", file=sys.stderr, flush=True)
                skipped.append({"id": c.get("id"), "error": str(e)})
                continue
            if hdr["empty"]:
                continue
            cards.append({"id": c.get("id"), "credit": cn, "maps": maps, "hdr": hdr, "start": int(c["start"]), "dur": dur,
                          "opacity": o, "rect": (rx, ry, bw, bh), "track_key": layer.get("track_key")})
    table: list[list[int]] = [[] for _ in range(n)]
    for ci, c in enumerate(cards):
        for f in range(max(f0, c["start"]), min(f0 + n, c["start"] + c["dur"])):
            table[f - f0].append(ci)
    return cards, table


_WS: dict = {}
POOL_TIMEOUT_S = 180                                   # one frame takes < 1 s; longer means the pool is stuck
from multiprocessing import TimeoutError as mp_TimeoutError  # noqa: E402


def _worker_init(state: dict) -> None:
    try:
        cv2.setNumThreads(1)
    except Exception:
        pass
    _WS.clear()
    _WS.update(state)


def process_frame(buf: bytes, f: int, idxs: list[int], st: dict) -> bytes:
    w, h, fps = st["w"], st["h"], st["fps"]
    arr = np.frombuffer(buf, np.uint8).copy()
    Yp = arr[:w * h].reshape(h, w)
    Up = arr[w * h:w * h + (w // 2) * (h // 2)].reshape(h // 2, w // 2)
    Vp = arr[w * h + (w // 2) * (h // 2):].reshape(h // 2, w // 2)
    changed = False
    for ci in idxs:
        changed |= apply_card_yuv(Yp, Up, Vp, st["cards"][ci], f, fps)
    return arr.tobytes() if changed else buf


def _worker_frame(args) -> bytes:
    f, idxs, buf = args
    return process_frame(buf, f, idxs, _WS)


def render(plan: dict, progress: Optional[Callable[[float], None]] = None) -> dict:
    """plan = {src, out, w, h, fps, frames, f0: 0, ffmpeg, content: [Wc, Hc],
               layers: [{track_key, rect, clips: [{id, start, dur, opacity, credit}]}]}  (layers bottom -> top)
    Decodes src as yuv420p, composes every active card of every frame in place (only A > 0 pixels / their chroma blocks),
    encodes lossless yuv420p (x264 qp0, BT.709 tags). Frames without an active card are written byte-identical."""
    t_start = time.time()
    src, out = str(plan["src"]), str(plan["out"])
    w, h, n = int(plan["w"]), int(plan["h"]), int(plan["frames"])
    fps = float(plan.get("fps") or 24.0)
    f0 = int(plan.get("f0") or 0)
    if w <= 0 or h <= 0 or n <= 0 or w % 2 or h % 2:
        raise ValueError(f"大きさかコマ数がおかしい: {w}x{h} {n} コマ")
    t_prep = time.time()
    cards, table = prepare_plan(plan)
    t_prep = time.time() - t_prep
    ff = plan.get("ffmpeg") or ffmpeg_exe()
    state = {"w": w, "h": h, "fps": fps, "cards": cards}
    n_active = sum(1 for t in table if t)
    procs = int(plan.get("threads") or 0) or min(12, max(1, (os.cpu_count() or 4) - 2))
    procs = max(1, min(procs, n_active or 1))
    op = Path(out)
    tmp = str(op.with_name(op.stem + ".part" + (op.suffix or ".mp4")))
    size = w * h * 3 // 2
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

    def _result(item) -> bytes:
        """a pooled frame; if the pool stops answering, drop it and finish the remaining frames in this process."""
        nonlocal pool
        ar, args = item
        if pool is not None:
            try:
                return ar.get(timeout=POOL_TIMEOUT_S)
            except mp_TimeoutError:
                sys.stderr.write(f"warning: 字幕の並列処理が {POOL_TIMEOUT_S} 秒応答しないので、1 本で続けます\n")
                pool.terminate()
                pool.join()
                pool = None
                _worker_init(state)
        return process_frame(args[2], args[0], args[1], _WS)

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
        dec = subprocess.Popen(decode_cmd(ff, src), stdout=subprocess.PIPE, stderr=err_dec)
        enc = subprocess.Popen(encode_cmd(ff, tmp, w, h, fps), stdin=subprocess.PIPE, stderr=err_enc)
        pending: deque = deque()
        window = procs * 2
        last = None
        for j in range(n):
            buf = dec.stdout.read(size)
            if not buf or len(buf) < size:
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
            idxs = table[j]
            if not idxs:
                pending.append(buf)
            elif pool is None:
                pending.append(process_frame(buf, f, idxs, _WS))
            else:
                pending.append((pool.apply_async(_worker_frame, ((f, idxs, buf),)), (f, idxs, buf)))
            while pending:
                head = pending[0]
                if isinstance(head, (bytes, bytearray)):
                    put(head)
                elif len(pending) > window or head[0].ready():
                    put(_result(head))
                else:
                    break
                pending.popleft()
        while pending:
            head = pending.popleft()
            put(head if isinstance(head, (bytes, bytearray)) else _result(head))
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
    return {"out": out, "frames": written, "cards": len(cards), "card_frames": sum(len(t) for t in table),
            "active_frames": n_active, "padded": short, "procs": procs, "prep_sec": round(t_prep, 2),
            "sec": round(sec, 2), "fps": round(written / max(sec, 1e-6), 2), "skipped": list(plan.get("_skipped") or [])}


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[1] != "render":
        sys.stderr.write("usage: python -m app.services.credit_fx render <plan.json>\n")
        return 2
    try:
        plan = json.loads(Path(argv[2]).read_text())
    except Exception as e:
        sys.stderr.write(f"字幕の計画を読めませんでした: {e}\n")
        return 2
    try:
        os.nice(5)
    except (AttributeError, OSError):
        pass
    # 11/01: render() forks a worker pool after prepare_plan(); if OpenCV's own thread pool is already running at
    # fork time the children can deadlock on its mutex (v44 hung at credit_03 with all workers in futex_wait).
    # This process only renders, so keep OpenCV sequential here (the workers already use 1 thread each).
    try:
        cv2.setNumThreads(0)
    except Exception:
        pass

    def prog(p: float) -> None:
        sys.stdout.write(f"PROGRESS {p:.4f}\n"); sys.stdout.flush()

    try:
        stats_ = render(plan, prog)
    except Exception as e:
        sys.stderr.write(f"字幕の書き出しに失敗しました: {type(e).__name__}: {e}\n")
        return 1
    sys.stdout.write("DONE " + json.dumps(stats_, ensure_ascii=False) + "\n"); sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
