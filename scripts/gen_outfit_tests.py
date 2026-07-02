#!/usr/bin/env python3
"""Generate N Kyoko-outfit test images via ComfyUI (recipe prompts) for the rig
stability test. Pure stdlib (urllib) so it runs in any venv. Saves PNGs to OUT_DIR."""
import json, time, urllib.request, urllib.parse, sys
from pathlib import Path

COMFY = "http://127.0.0.1:8188"
CKPT = "waiIllustriousSDXL_v170.safetensors"
OUT_DIR = Path("/tmp/kvtest"); OUT_DIR.mkdir(parents=True, exist_ok=True)
W, H = 832, 1216

# Recipe (puppet-generation-recipe): flat vibrant color, full body, straight-on,
# arms at sides, simple grey bg → clean See-Through decomposition.
BASE = ("masterpiece, best quality, very aesthetic, flat color, vibrant colors, "
        "even lighting, simple background, light grey background, full body, standing, "
        "looking at viewer, slight smile, arms at sides, straight-on view, symmetrical")
CHAR = "1girl, sakura kyoko, red hair, very long hair, high ponytail, red eyes"
NEG = ("greyscale, monochrome, sepia, desaturated, muted colors, sketch, lineart, "
       "depth of field, blurry, multiple views, crossed arms, complex background, "
       "(worst quality, low quality:1.2), bad anatomy, bad hands, extra limbs, cropped")

# 4 outfits chosen to stress DIFFERENT sway/clothing classes:
OUTFITS = [
    ("school",   "school uniform, blazer, white shirt, red necktie, pleated skirt, thighhighs", 7101),
    ("casual",   "casual clothes, off-shoulder sweater, denim short shorts, sneakers", 7102),
    ("sundress", "long white sundress, sleeveless flowing dress, sun hat", 7103),
    ("coat",     "long winter coat, red scarf, turtleneck sweater, long pants, boots", 7104),
]


def build(prompt, neg, seed):
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": neg, "clip": ["1", 1]}},
        "4": {"class_type": "EmptyLatentImage", "inputs": {"width": W, "height": H, "batch_size": 1}},
        "5": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": 28, "cfg": 7.0, "sampler_name": "dpmpp_2m",
            "scheduler": "karras", "denoise": 1.0, "model": ["1", 0],
            "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0]}},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "inputs": {"filename_prefix": "kvtest_", "images": ["6", 0]}},
    }


def post(path, data):
    req = urllib.request.Request(COMFY + path, data=json.dumps(data).encode(),
                                headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30))


def get(path):
    return json.load(urllib.request.urlopen(COMFY + path, timeout=30))


def main():
    results = {}
    for tag, outfit, seed in OUTFITS:
        prompt = f"{CHAR}, {outfit}, {BASE}"
        pid = post("/prompt", {"prompt": build(prompt, NEG, seed)})["prompt_id"]
        print(f"[{tag}] submitted prompt_id={pid}", flush=True)
        # poll history
        img = None
        for _ in range(180):
            time.sleep(2)
            hist = get(f"/history/{pid}")
            if pid in hist:
                outs = hist[pid].get("outputs", {})
                for node in outs.values():
                    for im in node.get("images", []):
                        img = im; break
                break
        if not img:
            print(f"[{tag}] TIMEOUT/no image", flush=True); continue
        q = urllib.parse.urlencode({"filename": img["filename"],
                                    "subfolder": img.get("subfolder", ""),
                                    "type": img.get("type", "output")})
        data = urllib.request.urlopen(COMFY + "/view?" + q, timeout=30).read()
        dest = OUT_DIR / f"kyoko_{tag}.png"
        dest.write_bytes(data)
        print(f"[{tag}] saved {dest} ({len(data)} bytes)", flush=True)
        results[tag] = str(dest)
    (OUT_DIR / "manifest.json").write_text(json.dumps(results, indent=2))
    print("DONE", json.dumps(results), flush=True)


if __name__ == "__main__":
    main()
