#!/usr/bin/env python3
"""
lora-kit grid — 学習したLoRAの強度スイープ検証グリッドを ComfyUI で生成する。

出力: tools/lora-kit/grids/<lora>_grid.png(横=強度 0.0/0.4/0.6/0.8/1.0、縦=シード2種)
"""
import argparse
import asyncio
import sys
from pathlib import Path

KIT = Path(__file__).resolve().parent
ROOT = KIT.parent.parent
sys.path.insert(0, str(ROOT / "backend"))

STRENGTHS = [0.0, 0.4, 0.6, 0.8, 1.0]
SEEDS = [309, 1111]
NEG = ("worst quality, low quality, bad anatomy, bad hands, watermark, signature, "
       "text, jpeg artifacts, multiple girls, nsfw")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lora", required=True, help="loras/ 内のファイル名(拡張子なし可)")
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--base", default="waiNSFWIllustrious_v170.safetensors")
    ap.add_argument("--size", default="832x1216")
    a = ap.parse_args()
    from app.services.comfyui import ComfyUIConnector
    from app.services.workflow_builder import build_sdxl_txt2img
    from PIL import Image, ImageDraw

    w, h = (int(x) for x in a.size.split("x"))
    lname = a.lora if a.lora.endswith(".safetensors") else a.lora + ".safetensors"
    c = ComfyUIConnector()
    tmp = KIT / "grids" / "_tmp"; tmp.mkdir(parents=True, exist_ok=True)
    cells: dict[tuple, Path] = {}
    for seed in SEEDS:
        for st in STRENGTHS:
            loras = [(lname, st)] if st > 0 else None
            wf = build_sdxl_txt2img(a.base, a.prompt, NEG, width=w, height=h,
                                    seed=seed, steps=26, cfg=6.0, loras=loras)
            pid = await c.submit(wf)
            outs = await c.wait_for_outputs(pid)
            o = outs[0]
            p = await c.download_output(o["filename"], o.get("subfolder", ""),
                                        o.get("type", "output"), tmp)
            cells[(seed, st)] = Path(p)
            print(f"  seed={seed} strength={st} done")

    th = 420
    tw = int(w * th / h)
    grid = Image.new("RGB", (tw * len(STRENGTHS), th * len(SEEDS) + 28), (24, 24, 24))
    d = ImageDraw.Draw(grid)
    for yi, seed in enumerate(SEEDS):
        for xi, st in enumerate(STRENGTHS):
            im = Image.open(cells[(seed, st)]).resize((tw, th))
            grid.paste(im, (xi * tw, yi * th + 28))
    for xi, st in enumerate(STRENGTHS):
        d.text((xi * tw + 8, 6), f"strength {st}", fill=(255, 255, 120))
    out = KIT / "grids" / f"{a.lora}_grid.png"
    grid.save(out)
    for f in tmp.iterdir():
        f.unlink()
    print("→", out)


asyncio.run(main())
