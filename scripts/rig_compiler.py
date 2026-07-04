#!/usr/bin/env python3
"""
Rig Compiler v2 — "Semantic Canonical Rig" (SCR).

Turns ANY character decomposition (See-Through → build_puppet.py v1 manifest +
full-frame layer PNGs) into a high-fidelity, riggable manifest, WITHOUT any
per-character tuning. Everything is derived from the semantic part names plus
light per-layer image analysis, so a brand-new generated image gets the same
quality automatically.

What it fixes / adds vs the raw decomposition:
  #1 Canonical z-order   — facial features are re-stacked onto a fixed anime
                            face order (e.g. eyebrow ABOVE face skin), so the
                            decomposer's noisy PSD order can't bury the brows.
  #2 Semantic depth      — 2.5D parallax depth comes from the canonical order
                            (monotonic, near→far), replacing noisy monocular
                            depth (which mis-placed e.g. the nose at depth 1.0).
  #3/#4/#5 rig metadata  — samples the skin tone, locates the eye/mouth regions,
                            splits left/right eyes, and emits control points +
                            mask sources so the runtime can do real eyelid blink,
                            pupil-only gaze, viseme mouth and facial mesh-warp.

Usage:  python rig_compiler.py <puppet_dir>          # rewrites manifest.json (v1 backup kept)
Run with a python that has PIL+numpy (e.g. tools/see-through/.venv).
"""
import json
import os
import shutil
import sys

import numpy as np
from PIL import Image

# ── Canonical anime-face stack (back → front). Lower index = drawn first/behind.
# Any decomposition is re-stacked onto this; unknown parts keep their relative
# order, slotted just behind the body.
SEMANTIC_ORDER = [
    "wings", "back hair", "tail", "objects",
    "footwear", "legwear", "bottomwear",
    "neck",                      # BEHIND the torso wear so the collar hides the neck's cut
                                 # base edge (drawing it in front exposes the See-Through seam)
    "topwear", "neckwear",
    "handwear",                  # arms/sleeves sit in FRONT of torso wear (arms-at-sides)
    "ears", "earwear",
    "face", "nose", "blush",
    "eyebrow", "eyewhite", "irides", "eyelash", "eyewear",
    "mouth",
    "headwear", "front hair",
]
_ORDER_IDX = {n: i for i, n in enumerate(SEMANTIC_ORDER)}


def _canon_index(name: str, fallback: int) -> float:
    return _ORDER_IDX.get(name.strip().lower(), len(SEMANTIC_ORDER) * 0.5 + fallback * 1e-3)


def _opaque(path: str, thresh: int = 40):
    """(rgb[N,3], xs, ys) of pixels with alpha>thresh; ([],[],[]) if missing."""
    if not os.path.exists(path):
        return np.empty((0, 3)), np.array([]), np.array([])
    im = np.asarray(Image.open(path).convert("RGBA"))
    a = im[..., 3] > thresh
    ys, xs = np.where(a)
    return im[ys, xs, :3], xs, ys


# Face-feature layers from See-Through carry a faint-alpha halo (iterative Gaussian
# padding). On the sclera it shows as a grey band when the brows rise; on the small
# mouth/nose the semi-transparent edge reads as a faint "frame" around the part.
# Hard-clip faint alpha per layer (small parts need a higher cut to remove the ring).
# Originals are backed up to *.orig.png so the clip is re-tunable / idempotent.
HALO_ALPHA = {"eyewhite": 96, "eyelash": 96, "irides": 96, "eyebrow": 96,
              "mouth": 175, "nose": 150}


def _clean_halos(puppet_dir: str, by_name: dict) -> None:
    for name, thresh in HALO_ALPHA.items():
        if name not in by_name:
            continue
        p = os.path.join(puppet_dir, by_name[name]["file"])
        if not os.path.exists(p):
            continue
        orig = p[:-4] + ".orig.png"
        if not os.path.exists(orig):
            shutil.copy(p, orig)
        im = np.array(Image.open(orig).convert("RGBA"))
        a = im[..., 3]
        im[..., 3] = np.where(a < thresh, 0, a)
        Image.fromarray(im).save(p)


# ── sway classification ──────────────────────────────────────────────────────
# Decide per layer whether it's a "sway-able" piece (hair / hanging cloth) and how.
# Hair always sways; clothing sways only if it hangs loose (a skirt/dress/cape that
# flares with a solid free hem) — tight tops, pants (split legs) and tights stay rigid.
def _shape_metrics(path: str):
    """(flare_ratio, solid_bottom) — flare = bottom-width / top-width; solid_bottom
    = the hem's central span is filled (skirt) vs split/empty (pants)."""
    if not os.path.exists(path):
        return 1.0, False
    a = np.asarray(Image.open(path).convert("RGBA"))[..., 3] > 80
    ys, xs = np.where(a)
    if len(xs) < 50:
        return 1.0, False
    t, b = int(ys.min()), int(ys.max()); h = max(1, b - t)
    l, r = int(xs.min()), int(xs.max())

    def width(y0, y1):
        cols = np.where(a[max(0, y0):y1].any(0))[0]
        return (cols.max() - cols.min()) if len(cols) else 0

    wt = width(t, t + int(0.30 * h) + 1)
    wb = width(b - int(0.30 * h), b + 1)
    flare = wb / max(1, wt)
    band = a[b - int(0.20 * h):b + 1]
    cl, cr = l + int(0.30 * (r - l)), l + int(0.70 * (r - l))
    central = band[:, cl:cr + 1]
    solid_bottom = bool(central.mean() > 0.5) if central.size else False
    return float(flare), solid_bottom


def _classify_sway(name: str, puppet_dir: str, file: str):
    n = name.strip().lower()
    if n == "back hair":  return {"type": "hair", "pin": "head", "amp": 1.0}
    if n == "front hair": return {"type": "hair", "pin": "head", "amp": 0.32}
    if n == "neck":       return {"type": "neck", "pin": "", "amp": 0.0}
    if n == "neckwear":   return {"type": "cloth", "pin": "head", "amp": 0.30}
    if n == "tail":       return {"type": "cloth", "pin": "body", "amp": 0.60}
    if n == "wings":      return {"type": "cloth", "pin": "body", "amp": 0.45}
    if n in ("bottomwear", "topwear", "objects"):
        flare, solid = _shape_metrics(os.path.join(puppet_dir, file))
        if n == "bottomwear":
            # skirt (flares + solid hem) sways; pants (split / non-flaring) stay rigid
            if solid and flare >= 0.95:
                return {"type": "cloth", "pin": "body", "amp": round(min(0.5, 0.30 + 0.22 * max(0.0, flare - 1)), 3)}
            return None
        # topwear / objects: only loose, flaring, solid-hem pieces (dress / cape / cloak)
        if flare >= 1.20 and solid:
            return {"type": "cloth", "pin": "body", "amp": 0.32}
        return None
    return None


def _clip_backfill(puppet_dir, by_name) -> None:
    """服の遮蔽補完(背側の布)が首より手前に描画される問題のクリップ。
    首シルエット内(下端際を除く)に重なる topwear/neckwear の画素は
    「首の後ろの布」なので透明化する(.orig から冪等に再クリップ)。"""
    import numpy as np
    from PIL import Image
    from pathlib import Path
    neck = by_name.get("neck")
    if not neck:
        return
    nd = Path(puppet_dir)
    na = np.asarray(Image.open(nd / neck["file"]).convert("RGBA"))[:, :, 3]
    nb = neck.get("bbox")
    if nb is None:
        return
    guard_y = int(nb[3] - (nb[3] - nb[1]) * 0.22)   # 首下端22%は襟前面が正当に重なる
    mask = (na > 200)
    mask[guard_y:, :] = False
    if not mask.any():
        return
    for lname in ("topwear", "neckwear"):
        ly = by_name.get(lname)
        if not ly:
            continue
        fp = nd / ly["file"]
        orig = fp.with_suffix(".clip_orig.png")
        src = orig if orig.exists() else fp
        im = Image.open(src).convert("RGBA")
        if not orig.exists():
            im.save(orig)
        arr = np.asarray(im).copy()
        before = int((arr[:, :, 3] > 0)[mask].sum())
        arr[:, :, 3][mask] = 0
        if before:
            Image.fromarray(arr).save(fp)
            print(f"  [backfill-clip] {lname}: {before}px を首の背側として除去")


def _fade_bottom_edge(puppet_dir, by_name, ramp: int = 60) -> None:
    """キャンバス下端で切れているレイヤ(髪・胴)に下端アルファフェードを焼き込む。
    揺れで持ち上がっても「フラットな切り口」が見えず自然に消える(.orig冪等)。"""
    import numpy as np
    from PIL import Image
    from pathlib import Path
    nd = Path(puppet_dir)
    for name, ly in by_name.items():
        fp = nd / ly["file"]
        orig = fp.with_suffix(".fade_orig.png")
        src = orig if orig.exists() else fp
        im = Image.open(src).convert("RGBA")
        arr = np.asarray(im).copy()
        h = arr.shape[0]
        if (arr[-3:, :, 3] > 32).sum() < 40:      # 下端に接していないレイヤは対象外
            continue
        if not orig.exists():
            im.save(orig)
        grad = np.linspace(1.0, 0.0, ramp)[:, None]
        band = arr[h - ramp:, :, 3].astype(np.float32) * grad
        arr[h - ramp:, :, 3] = band.astype(np.uint8)
        Image.fromarray(arr).save(fp)
        print(f"  [bottom-fade] {name}: 下端{ramp}pxをフェード")


def compile_rig(puppet_dir: str) -> dict:
    mpath = os.path.join(puppet_dir, "manifest.json")
    # one-time backup of the original (v1) manifest before we rewrite it
    bak = os.path.join(puppet_dir, "manifest.v1.json")
    if not os.path.exists(bak):
        shutil.copy(mpath, bak)
    # always recompile from the pristine v1 so re-runs are idempotent
    m = json.load(open(bak, encoding="utf-8"))
    W, H = m["canvas"]
    layers = m["layers"]
    by_name = {l["name"]: l for l in layers}
    f = lambda n: os.path.join(puppet_dir, by_name[n]["file"]) if n in by_name else None

    # ── #0 drop spurious "headwear" fragments ────────────────────────────────
    # See-Through can't segment hats reliably: a real hat comes out as a thin
    # sliver, and on hatless inputs it sometimes hallucinates a forehead strip.
    # Either way it renders as an odd band over the face, so drop any headwear
    # whose opaque coverage is tiny (a genuine full hat covers far more).
    def _coverage(layer) -> float:
        p = os.path.join(puppet_dir, layer.get("file", ""))
        if not os.path.exists(p):
            return 0.0
        a = np.asarray(Image.open(p).convert("RGBA"))[..., 3]
        return float((a > 40).mean())
    for l in [l for l in layers if l["name"].strip().lower() == "headwear"]:
        cov = _coverage(l)
        if cov < 0.015:
            layers.remove(l); by_name.pop(l["name"], None)
            print(f"  dropped spurious headwear (coverage {cov*100:.2f}% < 1.5%)")

    # ── #1 canonical z-order ─────────────────────────────────────────────────
    layers.sort(key=lambda l: _canon_index(l["name"], l.get("z", 0)))
    for i, l in enumerate(layers):
        l["z"] = i
        # ── #2 semantic depth (monotonic near→far; front hair≈0.12, back≈0.92)
        idx = _ORDER_IDX.get(l["name"].strip().lower())
        if idx is not None:
            l["depth"] = round(0.92 - 0.80 * idx / (len(SEMANTIC_ORDER) - 1), 3)

    def bbox(n):
        return tuple(by_name[n]["bbox"]) if n in by_name else None

    def union(*names):
        bs = [bbox(n) for n in names if bbox(n)]
        if not bs:
            return None
        return [min(b[0] for b in bs), min(b[1] for b in bs),
                max(b[2] for b in bs), max(b[3] for b in bs)]

    def center(b):
        return [round((b[0] + b[2]) / 2, 1), round((b[1] + b[3]) / 2, 1)] if b else None

    # ── eyes: region, left/right pupil centroids, mask + pupil layer refs ─────
    eye_region = union("eyewhite", "irides", "eyelash")
    mb = bbox("mouth")

    # ── skin tone for procedural eyelids — the FACE layer's dominant mid-tone
    # (median of opaque pixels excluding white highlights and dark line-art), so
    # a synthesized lid blends with whatever the face actually is. Works for
    # colour OR desaturated skin and generalizes to any character. ────────────
    def _skin_color() -> str:
        if not f("face"):
            return "#e9c9b3"
        im = np.asarray(Image.open(f("face")).convert("RGBA"))
        rgb = im[im[..., 3] > 200][:, :3].astype(int)
        if len(rgb) < 40:
            return "#e9c9b3"
        mx = rgb.max(axis=1); mn = rgb.min(axis=1)
        keep = (mn < 244) & (mx > 30)        # drop highlight-white and line-art-black
        sel = rgb[keep] if keep.sum() > 40 else rgb
        med = np.median(sel, axis=0).astype(int)
        return "#%02x%02x%02x" % (int(med[0]), int(med[1]), int(med[2]))
    skin = _skin_color()
    eyeL = eyeR = None
    if f("irides"):
        _, xs, ys = _opaque(f("irides"), thresh=40)
        if len(xs) > 10:
            mid = np.median(xs)
            for side, sel in (("L", xs < mid), ("R", xs >= mid)):
                if sel.sum() > 5:
                    c = [round(float(xs[sel].mean()), 1), round(float(ys[sel].mean()), 1)]
                    if side == "L":
                        eyeL = c
                    else:
                        eyeR = c
    if eye_region and (eyeL is None or eyeR is None):
        cx, cy = center(eye_region)
        qw = (eye_region[2] - eye_region[0]) * 0.25
        eyeL, eyeR = [round(cx - qw, 1), cy], [round(cx + qw, 1), cy]

    # ── mouth + brow + cheek control points (canvas coords) ───────────────────
    mouth = None
    if mb:
        mouth = {"region": list(mb), "center": center(mb),
                 "left": [mb[0], round((mb[1] + mb[3]) / 2, 1)],
                 "right": [mb[2], round((mb[1] + mb[3]) / 2, 1)]}
    eb = bbox("eyebrow")
    brow = None
    if eb:
        brow = {"left": [round(eb[0] + (eb[2] - eb[0]) * 0.25, 1), round((eb[1] + eb[3]) / 2, 1)],
                "right": [round(eb[0] + (eb[2] - eb[0]) * 0.75, 1), round((eb[1] + eb[3]) / 2, 1)]}
    # cheeks: just below the eye region, at the face's horizontal thirds
    cheek = None
    fb = bbox("face")
    if fb and eye_region:
        cy = round(eye_region[3] + (fb[3] - eye_region[3]) * 0.35, 1)
        cheek = {"left": [round(fb[0] + (fb[2] - fb[0]) * 0.25, 1), cy],
                 "right": [round(fb[0] + (fb[2] - fb[0]) * 0.75, 1), cy]}

    # character extent (union bbox height) — the runtime scales ALL motion by this
    # instead of the canvas size, so a character framed larger/smaller (or a higher-
    # res source image) animates in the same PROPORTIONS. Resolution-independent.
    _bbs = [l["bbox"] for l in layers if l.get("bbox")]
    char_h = (max(b[3] for b in _bbs) - min(b[1] for b in _bbs)) if _bbs else m["canvas"][1]

    rig = {
        "unit": round(float(char_h), 1),
        "skinColor": skin,
        "eye": {"region": eye_region, "left": eyeL, "right": eyeR,
                "sclera": by_name["eyewhite"]["file"] if "eyewhite" in by_name else None,
                "pupil": by_name["irides"]["file"] if "irides" in by_name else None},
        "mouth": mouth,
        "brow": brow,
        "cheek": cheek,
        # groups the runtime should render as warp-capable meshes (facial morph)
        "meshGroups": ["head", "eyes", "mouth"],
    }

    _clean_halos(puppet_dir, by_name)   # strip faint-alpha halos from eye layers
    _clip_backfill(puppet_dir, by_name) # 首の背側に補完された布の除去
    _fade_bottom_edge(puppet_dir, by_name)  # 下端切り口のフェード(ポートレート対応)

    # per-layer sway classification (hair / hanging cloth / rigid) → runtime physics
    for l in layers:
        sway = _classify_sway(l["name"], puppet_dir, l["file"])
        if sway:
            l["sway"] = sway
        else:
            l.pop("sway", None)

    m["version"] = 2
    m["rig"] = rig
    m["layers"] = layers
    # preserve a user-edited display name across recompiles (v1 backup has the original)
    if os.path.exists(mpath):
        try:
            cur_name = json.load(open(mpath, encoding="utf-8")).get("name")
            if cur_name:
                m["name"] = cur_name
        except Exception:
            pass
    json.dump(m, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return m


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: rig_compiler.py <puppet_dir> [<puppet_dir> ...]")
        sys.exit(1)
    for d in sys.argv[1:]:
        m = compile_rig(d)
        print(f"[rig v2] {d}: {len(m['layers'])} layers, skin={m['rig']['skinColor']}, "
              f"eyeL={m['rig']['eye']['left']} eyeR={m['rig']['eye']['right']} "
              f"mouth={'y' if m['rig']['mouth'] else 'n'}")
        print("  z-order:", " < ".join(l["name"] for l in m["layers"]))
