#!/usr/bin/env python3
"""
See-Through 出力 → KyChaPoGaS パペット・マニフェスト。

PSDのレイヤ順(=描画z順)とbboxを読み、各パーツを group/pivot 付きで manifest.json に
まとめ、フルフレームPNGを backend/data/puppets/<id>/ にコピーする。
フロントのPixiJSパペットレンダラがこのmanifestを読んでリギング+手続き動作する。

使い方:  .venv/bin/python build_puppet.py <seethrough_out_dir> <psd_path> <puppet_id> <display_name>
"""
import json
import os
import shutil
import sys
from psd_tools import PSDImage

out_dir, psd_path, pid, dispname = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
import pathlib
DEST_ROOT = str(pathlib.Path(__file__).resolve().parent.parent / "backend" / "data" / "puppets")
dest = os.path.join(DEST_ROOT, pid)
os.makedirs(dest, exist_ok=True)

# part名 → リグのグループ
GROUP = {
    "back hair": "backhair", "wings": "backhair",
    "front hair": "fronthair",
    "face": "head", "ears": "head", "nose": "head", "headwear": "head", "earwear": "head", "neck": "head",
    "eyebrow": "eyes", "eyewhite": "eyes", "eyelash": "eyes", "irides": "eyes", "eyewear": "eyes",
    "mouth": "mouth",
    "topwear": "body", "bottomwear": "body", "legwear": "body", "footwear": "body",
    "handwear": "body", "neckwear": "body", "objects": "body", "tail": "body",
}

psd = PSDImage.open(psd_path)
W, H = psd.width, psd.height

def mean_depth(name: str) -> float:
    """Mean pseudo-depth (0..1) of a layer's content from its See-Through
    *_depth.png — used for 2.5D parallax on head turn (nearer = more shift)."""
    from PIL import Image
    import numpy as np
    dp = os.path.join(out_dir, f"{name}_depth.png")
    rgba = os.path.join(out_dir, f"{name}.png")
    if not (os.path.exists(dp) and os.path.exists(rgba)):
        return 0.5
    try:
        d = np.asarray(Image.open(dp).convert("L"), dtype=float) / 255.0
        a = np.asarray(Image.open(rgba).convert("RGBA"))[..., 3] > 16
        return float(d[a].mean()) if a.sum() >= 4 else 0.5
    except Exception:
        return 0.5


layers = []   # in z-order (bottom→top = psd order)
bbox_by = {}
for ly in psd:
    if ly.is_group():
        continue
    name = ly.name
    bb = ly.bbox  # (l, t, r, b)
    if bb is None or (bb[2] - bb[0]) < 2 or (bb[3] - bb[1]) < 2:
        continue
    src_png = os.path.join(out_dir, f"{name}.png")
    if not os.path.exists(src_png):
        continue
    fname = name.replace(" ", "_") + ".png"
    shutil.copy(src_png, os.path.join(dest, fname))
    bbox_by[name] = bb
    layers.append({
        "name": name, "file": fname, "group": GROUP.get(name, "body"),
        "z": len(layers), "bbox": list(bb), "depth": round(mean_depth(name), 3),
    })

def center(bb):  return [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]
def union(*names):
    bs = [bbox_by[n] for n in names if n in bbox_by]
    if not bs: return None
    return (min(b[0] for b in bs), min(b[1] for b in bs),
            max(b[2] for b in bs), max(b[3] for b in bs))

# ── ピボット推定 ──────────────────────────────────────────────────────────
pivots = {}
# 頭: 首の付け根(首bboxの下端中央) ／ 無ければ顔の下端
if "neck" in bbox_by:
    nb = bbox_by["neck"]; pivots["head"] = [(nb[0] + nb[2]) / 2, nb[3]]
elif "face" in bbox_by:
    fb = bbox_by["face"]; pivots["head"] = [(fb[0] + fb[2]) / 2, fb[3]]
else:
    pivots["head"] = [W / 2, H * 0.28]
# 目: 瞳/白目/まつ毛の合併中心
eb = union("irides", "eyewhite", "eyelash")
pivots["eyes"] = center(eb) if eb else [W / 2, H * 0.19]
# 口
pivots["mouth"] = center(bbox_by["mouth"]) if "mouth" in bbox_by else [W / 2, H * 0.24]
# 体(呼吸): 腰あたり
pivots["body"] = [W / 2, H * 0.80]
# 前髪パララックスの基準は頭ピボットを流用

manifest = {
    "id": pid, "name": dispname, "canvas": [W, H],
    "pivots": pivots, "layers": layers,
}
with open(os.path.join(dest, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=1)

print(f"puppet '{pid}' built: {len(layers)} layers → {dest}")
for l in layers:
    print(f"  z{l['z']:2d} {l['name']:12s} [{l['group']}]")
print("pivots:", pivots)
