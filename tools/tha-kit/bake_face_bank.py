#!/usr/bin/env python3
"""
bake_face_bank — THA3でパペットの顔フレームバンクを焼く。

まばたき(中割り6コマ)と口形素(あいうえお×開口3段)を、THA3の学習済み
画像空間モーフで生成 → 目/口領域のパッチとして書き出し、manifestに登録する。
スプライト1枚差し替え(現行variants)と違い、連続した中割りがあるため
Live2D品質の滑らかな瞬き・口パクになる。

usage: .venv/bin/python bake_face_bank.py --puppet kyoko_portrait
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageFilter

REPO = Path(__file__).resolve().parent.parent.parent
PUPPETS = REPO / "backend" / "data" / "puppets"

BLINK_STEPS = [0.2, 0.4, 0.6, 0.8, 1.0]          # 開→閉の中割り(0は素の絵)
MOUTH_OPENS = [0.4, 0.7, 1.0]                     # 各母音の開口3段
VOWELS = {"a": "mouth_aaa", "i": "mouth_iii", "u": "mouth_uuu",
          "e": "mouth_eee", "o": "mouth_ooo"}


def flatten_rgba(mdir: Path, m: dict) -> Image.Image:
    canvas = Image.new("RGBA", tuple(m["canvas"]), (0, 0, 0, 0))
    for layer in sorted(m["layers"], key=lambda x: x["z"]):
        canvas.alpha_composite(Image.open(mdir / layer["file"]).convert("RGBA"))
    return canvas


def head_crop_box(m: dict) -> tuple[int, int, int]:
    """THA3入力規約: 512x512で頭部(髪含む)が上部中央の128px箱に収まる。
    → 頭部高を目〜口から推定し、頭がクロップの1/4・頭箱中心(256,128)相当に配置。"""
    rig = m["rig"]
    ex, _ = rig["eye"]["region"][0:2]
    ex2 = rig["eye"]["region"][2]
    ey = rig["eye"]["region"][1]
    my2 = rig["mouth"]["region"][3]
    cx = (ex + ex2) / 2
    face_h = (my2 - ey) or 60
    head_h = face_h * 3.4                         # アニメ顔: 目上に髪・頭頂が大きい
    head_top = ey - head_h * 0.62                 # 目は頭部の下寄り
    size = int(head_h * 4)                        # 頭=クロップの1/4(=512中128px)
    x0 = int(cx - size / 2)
    y0 = int(head_top - size * 0.125)             # 頭箱の上端をy=12.5%に
    return x0, y0, size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--puppet", required=True)
    ap.add_argument("--device", default="cuda")
    a = ap.parse_args()

    mdir = PUPPETS / a.puppet
    m = json.loads((mdir / "manifest.json").read_text())
    rig = m["rig"]

    from tha3.poser.modes.load_poser import load_poser
    poser = load_poser("standard_float", a.device)
    names = []
    for g in poser.get_pose_parameter_groups():
        names += g.get_parameter_names()
    idx = {n: i for i, n in enumerate(names)}
    S = poser.get_image_size()

    flat = flatten_rgba(mdir, m)
    x0, y0, size = head_crop_box(m)
    crop = flat.crop((x0, y0, x0 + size, y0 + size)).resize((S, S), Image.LANCZOS)

    arr = np.asarray(crop).astype(np.float32) / 255.0
    img = torch.from_numpy(arr).permute(2, 0, 1) * 2 - 1
    img = img.to(a.device)

    def pose_image(**kw):
        vec = torch.zeros(poser.get_num_parameters(), device=a.device)
        for k, v in kw.items():
            vec[idx[k]] = v
        with torch.no_grad():
            out = poser.pose(img, vec)[0]
        o = ((out.permute(1, 2, 0).cpu().numpy() + 1) / 2 * 255).clip(0, 255).astype(np.uint8)
        return Image.fromarray(o, "RGBA").resize((size, size), Image.LANCZOS)

    def region_patch(result: Image.Image, region, pad_frac, out_name: str):
        """THA3出力(クロップ座標)から領域を切り出し、キャンバス座標のパッチに。"""
        l, t, r, b = region
        w, h = r - l, b - t
        l -= int(w * pad_frac[0]); r += int(w * pad_frac[0])
        t -= int(h * pad_frac[1]); b += int(h * pad_frac[2])
        mask = Image.new("L", tuple(m["canvas"]), 0)
        from PIL import ImageDraw
        ImageDraw.Draw(mask).ellipse([l, t, r, b], fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(5))
        patch = Image.new("RGBA", tuple(m["canvas"]), (0, 0, 0, 0))
        patch.paste(result, (x0, y0))
        patch.putalpha(mask)
        patch.save(mdir / "variants_tha" / out_name)
        return f"variants_tha/{out_name}"

    (mdir / "variants_tha").mkdir(exist_ok=True)
    bank: dict = {"eyeBlink": [], "mouth": {}}

    print("baking blink frames…")
    for i, k in enumerate(BLINK_STEPS):
        res = pose_image(eye_wink_left=k, eye_wink_right=k)
        bank["eyeBlink"].append(region_patch(res, rig["eye"]["region"], (0.18, 0.6, 0.6),
                                             f"blink_{i}.png"))
    print("baking viseme frames…")
    for v, pname in VOWELS.items():
        frames = []
        for j, op in enumerate(MOUTH_OPENS):
            res = pose_image(**{pname: op})
            frames.append(region_patch(res, rig["mouth"]["region"], (0.5, 0.6, 2.0),
                                       f"mouth_{v}{j}.png"))
        bank["mouth"][v] = frames

    # 自動検証: 全閉瞬きフレームが実際に目を変えているか(画素差)
    er = rig["eye"]["region"]
    base_eye = np.asarray(flat.crop(er).convert("L"), np.float32)
    closed = Image.open(mdir / bank["eyeBlink"][-1].replace("variants_tha/", "variants_tha/"))
    comp = flat.copy(); comp.alpha_composite(Image.open(mdir / bank["eyeBlink"][-1]))
    diff = np.abs(np.asarray(comp.crop(er).convert("L"), np.float32) - base_eye).mean()
    print(f"blink pixel-diff (eye region): {diff:.1f}  {'OK' if diff > 8 else '!! 効果なし — クロップ規約を確認'}")
    m["rig"]["thaBank"] = bank
    (mdir / "manifest.json").write_text(json.dumps(m, ensure_ascii=False))
    print(f"done: blink {len(bank['eyeBlink'])}f + mouth {len(bank['mouth'])}x{len(MOUTH_OPENS)}f")


if __name__ == "__main__":
    main()
