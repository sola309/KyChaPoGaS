#!/usr/bin/env python3
"""
outpaint_margins — バストアップ素体の外周をアウトペイントし、
フレームで途切れた髪・肩・胴を自然に終端させる(ポートレートパペットの前処理)。

usage (backend venv):
  python scripts/outpaint_margins.py IN.png OUT.png \
      [--pad-b 176 --pad-lr 96 --pad-t 48] [--prompt "..."] [--model waiNSFWIllustrious_v170.safetensors]
"""
import argparse
import io
import time
from pathlib import Path

import httpx
from PIL import Image, ImageFilter

COMFY = "http://localhost:8188"


def _upload(cli, name, im):
    buf = io.BytesIO(); im.save(buf, "PNG")
    r = cli.post(f"{COMFY}/upload/image", files={"image": (name, buf.getvalue(), "image/png")},
                 data={"overwrite": "true"})
    r.raise_for_status(); return r.json()["name"]


def main():
    import sys
    REPO = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(REPO / "backend"))
    from app.services.workflow_builder import build_sdxl_inpaint

    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--pad-b", type=int, default=176)
    ap.add_argument("--pad-lr", type=int, default=96)
    ap.add_argument("--pad-t", type=int, default=48)
    ap.add_argument("--prompt", default="hair ends, long flowing hair tips, upper body continuation, "
                    "simple background, light grey background, flat color, masterpiece")
    ap.add_argument("--model", default="waiNSFWIllustrious_v170.safetensors")
    ap.add_argument("--seed", type=int, default=4649)
    a = ap.parse_args()

    im = Image.open(a.src).convert("RGB")
    w, h = im.size
    W = (w + 2 * a.pad_lr) // 8 * 8
    H = (h + a.pad_t + a.pad_b) // 8 * 8
    ox, oy = (W - w) // 2, a.pad_t
    # 端の色を引き伸ばして下地に(インペイントの種)
    big = im.resize((W, H)).filter(ImageFilter.GaussianBlur(40))
    big.paste(im, (ox, oy))
    # マスク: 外周のみ白(元画像との境界を12pxオーバーラップ)
    mask = Image.new("L", (W, H), 255)
    mask.paste(0, (ox + 12, oy + 12, ox + w - 12, oy + h - 12))
    mask = mask.filter(ImageFilter.GaussianBlur(6))

    with httpx.Client(timeout=30) as cli:
        img_name = _upload(cli, "op_src.png", big)
        mask_name = _upload(cli, "op_mask.png", mask.convert("RGB"))
        wf = build_sdxl_inpaint(a.model, img_name, mask_name, a.prompt,
                                "worst quality, extra limbs, extra person, text, watermark, frame, border",
                                seed=a.seed, denoise=1.0, grow_mask=8)
        pid = cli.post(f"{COMFY}/prompt", json={"prompt": wf}).json()["prompt_id"]
        t0 = time.time()
        while time.time() - t0 < 600:
            hst = cli.get(f"{COMFY}/history/{pid}").json()
            if pid in hst and hst[pid].get("outputs"):
                for node in hst[pid]["outputs"].values():
                    for img in node.get("images", []):
                        r = cli.get(f"{COMFY}/view", params=img)
                        Image.open(io.BytesIO(r.content)).save(a.dst)
                        print(f"{a.dst} ({W}x{H})")
                        return
            time.sleep(2)
        raise TimeoutError("outpaint timeout")


if __name__ == "__main__":
    main()
