#!/usr/bin/env python3
"""C6 LongTake submit (direct ComfyUI API, bypasses backend).
usage: ef_c6_longtake.py --sheet c6_sheet_full_1.png --face c6_face_4267.png --prompt FILE
        [--project c6_lt_t1] [--mp 0.52] [--steps 4] [--turbo 0.75] [--clip 124] [--ctx 5]
        [--seed N] [--mode continue|restart] [--max-clips N] [--dry-run] [--anchor keyframe]
"""
import argparse, json, random, urllib.request
ap = argparse.ArgumentParser()
ap.add_argument("--sheet", required=True); ap.add_argument("--face", default="")
ap.add_argument("--prompt", required=True); ap.add_argument("--project", default="c6_lt_t1")
ap.add_argument("--mp", type=float, default=0.52); ap.add_argument("--steps", type=int, default=4)
ap.add_argument("--turbo", type=float, default=0.75)
ap.add_argument("--lora", default="minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors")
ap.add_argument("--clip", type=int, default=124); ap.add_argument("--ctx", default="5")
ap.add_argument("--seed", type=int, default=-1); ap.add_argument("--mode", default="continue")
ap.add_argument("--max-clips", type=int, default=0); ap.add_argument("--dry-run", action="store_true")
ap.add_argument("--anchor", default="keyframe"); ap.add_argument("--scheduler", default="simple")
ap.add_argument("--ref-image-size", default="match"); ap.add_argument("--seam", default="off")
ap.add_argument("--source", default="ref_C6_full_276_982.mp4")
ap.add_argument("--redo-clip", type=int, default=0)
ap.add_argument("--shift-video", type=float, default=None); ap.add_argument("--shift-audio", type=float, default=None)
a = ap.parse_args()
seed = a.seed if a.seed >= 0 else random.randint(0, 2**31)
prompt = open(a.prompt).read()
wf = {
 "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_ref2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
 "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
 "vvae": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
 "avae": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
 "sheet": {"class_type": "LoadImage", "inputs": {"image": a.sheet}},
}
model = ["unet", 0]
if a.turbo > 0:
    wf["lora"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"lora_name": a.lora, "strength_model": a.turbo, "model": model}}
    model = ["lora", 0]
if a.shift_video is not None:
    wf["shift"] = {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": model, "shift_video": a.shift_video, "shift_audio": a.shift_audio if a.shift_audio is not None else 3.0}}
    model = ["shift", 0]
lt = {"model": model, "clip": ["clip", 0], "vae": ["vvae", 0], "audio_vae": ["avae", 0],
      "source_file": a.source, "prompt": prompt, "project_name": a.project,
      "width": 896, "height": 576, "clip_frames": a.clip, "context_frames": a.ctx, "seed": seed,
      "steps": a.steps, "sampler_name": "euler", "scheduler": a.scheduler, "mode": a.mode,
      "redo_from_clip": a.redo_clip, "max_clips": a.max_clips, "dry_run": a.dry_run,
      "ref_image_1": ["sheet", 0], "ref_image_size": a.ref_image_size, "ref_video_size": "match",
      "audio_context": False, "use_source_audio": False, "aspect": "source", "megapixels": a.mp,
      "anchor_mode": a.anchor, "source_role": "reference", "seam_match": a.seam}
if a.face:
    wf["face"] = {"class_type": "LoadImage", "inputs": {"image": a.face}}
    lt["ref_image_2"] = ["face", 0]
wf["lt"] = {"class_type": "H3LongTakeRender", "inputs": lt}
wf["out"] = {"class_type": "PreviewImage", "inputs": {"images": ["lt", 0]}}
r = urllib.request.Request("http://localhost:8188/prompt", data=json.dumps({"prompt": wf}).encode(), headers={"Content-Type": "application/json"})
res = json.load(urllib.request.urlopen(r))
print("seed", seed, "prompt_id", res.get("prompt_id"), "errors", res.get("node_errors") or "none")
