#!/usr/bin/env python3
"""
face_variants — パペットの口形素・閉眼差分をSDXLインペイントで自動生成する。

「手続き変形(潰し伸ばし)」から「描かれた差分(ブレンドシェイプ)」への転換。
CartoonAlive/Live2D流: 口=あ/い/う/え/お、目=閉/半眼 をレイヤ差分として持つ。

usage (backend venv):
  python scripts/face_variants.py --puppet kyoko_magical [--model waiNSFWIllustrious_v140.safetensors]
出力: backend/data/puppets/<id>/variants/*.png + manifest.rig.variants 追記
"""
from __future__ import annotations

import argparse
import io
import json
import time
from pathlib import Path

import httpx
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

REPO = Path(__file__).resolve().parent.parent
PUPPETS = REPO / "backend" / "data" / "puppets"
COMFY = "http://localhost:8188"

# 口形素/目差分のプロンプト(ベースタグに追記)。杏子の恒常タグは呼び出し側で結合。
VARIANTS = {
    "mouth_a": ("mouth wide open, open jaw, singing, upper teeth, inside of mouth visible", "mouth"),
    "mouth_i": ("wide grin, teeth pressed together, showing teeth row", "mouth"),
    "mouth_u": ("small puckered lips, tiny round open mouth, whistling", "mouth"),
    "mouth_e": ("half-open mouth, relaxed jaw, slight smile", "mouth"),
    "mouth_o": ("round wide open mouth, surprised, singing o vowel", "mouth"),
    "eyes_closed": ("eyes closed, gentle curved closed eyelids, peaceful expression", "eyes"),
    "eyes_half": ("half-closed eyes, sleepy relaxed eyelids", "eyes"),
}
NEG = ("worst quality, low quality, blurry, deformed, extra teeth, extra mouth, "
       "nose change, face shape change, watermark")


def flatten(mdir: Path, m: dict) -> Image.Image:
    canvas = Image.new("RGBA", tuple(m["canvas"]), (255, 255, 255, 255))
    for layer in sorted(m["layers"], key=lambda x: x["z"]):
        im = Image.open(mdir / layer["file"]).convert("RGBA")
        canvas.alpha_composite(im)
    return canvas.convert("RGB")


def region_mask(canvas, region, kind) -> tuple[Image.Image, tuple]:
    l, t, r, b = [int(v) for v in region]
    w, h = r - l, b - t
    if kind == "mouth":     # 開口ぶん下へ広げる
        l -= int(w * .45); r += int(w * .45)
        t -= int(h * .55); b += int(h * 1.9)
    else:                   # 目: まつ毛/眉に少し届く程度
        l -= int(w * .16); r += int(w * .16)
        t -= int(h * .55); b += int(h * .55)
    mask = Image.new("L", tuple(canvas), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse([l, t, r, b], fill=255)
    return mask.filter(ImageFilter.GaussianBlur(6)), (l, t, r, b)


def upload(cli, name: str, im: Image.Image) -> str:
    buf = io.BytesIO(); im.save(buf, "PNG")
    r = cli.post(f"{COMFY}/upload/image",
                 files={"image": (name, buf.getvalue(), "image/png")},
                 data={"overwrite": "true"})
    r.raise_for_status()
    return r.json()["name"]


def run_wf(cli, wf: dict, timeout=600) -> Image.Image:
    pid = cli.post(f"{COMFY}/prompt", json={"prompt": wf}).json()["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = cli.get(f"{COMFY}/history/{pid}").json()
        if pid in h and h[pid].get("outputs"):
            for node in h[pid]["outputs"].values():
                for img in node.get("images", []):
                    r = cli.get(f"{COMFY}/view", params=img)
                    return Image.open(io.BytesIO(r.content))
        time.sleep(2)
    raise TimeoutError("ComfyUI inpaint timeout")


def main():
    import sys
    sys.path.insert(0, str(REPO / "backend"))
    from app.services.workflow_builder import build_sdxl_inpaint

    ap = argparse.ArgumentParser()
    ap.add_argument("--puppet", required=True)
    ap.add_argument("--model", default="waiNSFWIllustrious_v140.safetensors")
    ap.add_argument("--base-tags", default="1girl, sakura kyoko, mahou shoujo madoka magica, "
                    "aoki ume, red hair, red eyes, masterpiece, best quality")
    ap.add_argument("--seed", type=int, default=4649)
    ap.add_argument("--only", default=None, help="カンマ区切りで対象差分を限定")
    a = ap.parse_args()

    mdir = PUPPETS / a.puppet
    m = json.loads((mdir / "manifest.json").read_text())
    rig = m["rig"]
    flat = flatten(mdir, m)
    vdir = mdir / "variants"; vdir.mkdir(exist_ok=True)

    todo = {k: v for k, v in VARIANTS.items()
            if not a.only or k in a.only.split(",")}
    out_meta = m["rig"].get("variants", {})
    with httpx.Client(timeout=30) as cli:
        img_name = upload(cli, f"fv_{a.puppet}.png", flat)
        for name, (desc, kind) in todo.items():
            region = rig["mouth"]["region"] if kind == "mouth" else rig["eye"]["region"]
            mask, bbox = region_mask(m["canvas"], region, kind)
            mask_name = upload(cli, f"fv_{a.puppet}_{name}_mask.png", mask.convert("RGB"))
            wf = build_sdxl_inpaint(a.model, img_name, mask_name,
                                    f"{a.base_tags}, {desc}", NEG, seed=a.seed)
            print(f"[{name}] inpainting…")
            result = run_wf(cli, wf).convert("RGB")
            # 色マッチ: マスク内の平均色をベースに寄せる(インペイントの色ドリフト対策)
            ma = np.asarray(mask, dtype=np.float32) / 255.0
            rb, bb = np.asarray(result, np.float32), np.asarray(flat, np.float32)
            w3 = ma[..., None]
            shift = ((bb * w3).sum((0, 1)) - (rb * w3).sum((0, 1))) / max(w3.sum(), 1)
            result = Image.fromarray(np.clip(rb + shift * 0.8, 0, 255).astype(np.uint8))
            # 差分パッチ: RGB=インペイント結果 / alpha=フェザー付き楕円マスク
            patch = Image.new("RGBA", tuple(m["canvas"]), (0, 0, 0, 0))
            patch.paste(result, (0, 0))
            patch.putalpha(mask)
            patch.save(vdir / f"{name}.png")
            out_meta.setdefault(kind, {})[name.split("_", 1)[1]] = f"variants/{name}.png"
            print(f"  → variants/{name}.png bbox={bbox}")

    m["rig"]["variants"] = out_meta
    (mdir / "manifest.json").write_text(json.dumps(m, ensure_ascii=False))
    print("manifest updated: rig.variants =", json.dumps(out_meta, ensure_ascii=False))


if __name__ == "__main__":
    main()
