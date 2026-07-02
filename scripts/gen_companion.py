#!/usr/bin/env python3
"""Generate N Kyoko patterns using the CONFIGURED base prompt (COMPANION_BASE_PROMPT
from /api/settings/), timing each generation. Saves PNGs + timings.json to OUT_DIR.
Pure stdlib (urllib)."""
import json, time, urllib.request, urllib.parse
from pathlib import Path

COMFY = "http://127.0.0.1:8188"
API = "http://127.0.0.1:8002"
CKPT = "waiIllustriousSDXL_v170.safetensors"
OUT_DIR = Path("/tmp/kvgen"); OUT_DIR.mkdir(parents=True, exist_ok=True)
W, H = 832, 1216

# scene/quality tail appended after base+outfit → clean full-body decomposition
TAIL = ("full body, standing, looking at viewer, arms at sides, straight-on view, "
        "symmetrical, flat color, vibrant colors, even lighting, simple background, "
        "light grey background")
NEG = ("greyscale, monochrome, sepia, desaturated, muted colors, sketch, lineart, "
       "depth of field, blurry, multiple views, crossed arms, complex background, "
       "hat, cap, headwear, (worst quality, low quality:1.2), bad anatomy, bad hands, "
       "extra limbs, cropped")

PATTERNS = [
    ("magical", "magical girl, red dress, white frills, detached sleeves, pink pleated skirt", 8201),
    ("casual",  "casual hoodie, denim short shorts, sneakers", 8202),
    ("sailor",  "summer sailor school uniform, pleated skirt, thighhighs", 8203),
    ("dress",   "red long one-piece dress, sleeveless", 8204),
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
        "7": {"class_type": "SaveImage", "inputs": {"filename_prefix": "kvgen_", "images": ["6", 0]}},
    }


def post(path, data):
    req = urllib.request.Request(COMFY + path, data=json.dumps(data).encode(),
                                headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30))


def get(url):
    return json.load(urllib.request.urlopen(url, timeout=30))


def base_prompt():
    try:
        d = get(API + "/api/settings/")
        v = (d.get("settings") or {}).get("COMPANION_BASE_PROMPT")
        if v:
            return v
    except Exception as e:
        print("  (settings fetch failed, using fallback):", e)
    return "1girl, sakura kyoko, mahou shoujo madoka magica, aoki ume, masterpiece, best quality, solo, "


def main():
    base = base_prompt()
    print("BASE PROMPT:", base.strip(), flush=True)
    timings = {}
    for tag, outfit, seed in PATTERNS:
        prompt = f"{base}{outfit}, {TAIL}"
        t0 = time.time()
        pid = post("/prompt", {"prompt": build(prompt, NEG, seed)})["prompt_id"]
        img = None
        for _ in range(200):
            time.sleep(1)
            hist = get(f"{COMFY}/history/{pid}")
            if pid in hist:
                for node in hist[pid].get("outputs", {}).values():
                    for im in node.get("images", []):
                        img = im; break
                break
        if not img:
            print(f"[{tag}] TIMEOUT", flush=True); continue
        q = urllib.parse.urlencode({"filename": img["filename"], "subfolder": img.get("subfolder", ""),
                                    "type": img.get("type", "output")})
        data = urllib.request.urlopen(f"{COMFY}/view?" + q, timeout=30).read()
        dt = time.time() - t0
        (OUT_DIR / f"kyoko_{tag}.png").write_bytes(data)
        timings[tag] = round(dt, 1)
        print(f"[{tag}] {dt:.1f}s  → kyoko_{tag}.png ({len(data)} bytes)", flush=True)
    (OUT_DIR / "timings.json").write_text(json.dumps(timings, indent=2))
    avg = sum(timings.values()) / len(timings) if timings else 0
    print(f"GEN DONE  avg={avg:.1f}s/image  total={sum(timings.values()):.1f}s", flush=True)


if __name__ == "__main__":
    main()
