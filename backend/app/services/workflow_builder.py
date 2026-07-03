"""
ComfyUI Workflow Builder.

Programmatically constructs ComfyUI API-format workflows for each generation type.
These are "bare" workflows that use only built-in ComfyUI nodes.

Model compatibility:
  build_sdxl_txt2img  → SDXL checkpoints (.safetensors)
  build_sd15_txt2img  → SD 1.5 checkpoints
  build_flux_txt2img  → FLUX.1 dev/schnell (requires UNETLoader + DualCLIPLoader)
  build_svd_i2v       → Stable Video Diffusion XT (img2vid-xt)
  build_cogvideox_i2v → CogVideoX-I2V (via custom nodes — may need VideoHelperSuite)
"""

import random


def _seed(seed: int) -> int:
    return random.randint(0, 2**31 - 1) if seed == -1 else seed


# ── Text-to-Image: SDXL / SD1.5 ──────────────────────────────────────────────

def build_sdxl_txt2img(
    model_filename: str,
    prompt: str,
    negative_prompt: str = "",
    width: int = 1024,
    height: int = 1024,
    seed: int = -1,
    steps: int = 25,
    cfg: float = 7.0,
    loras: list | None = None,   # [(lora_filename, strength)] — チェーン適用
) -> dict:
    """
    Standard SDXL/SD1.5 text-to-image workflow.
    Works with any checkpoint loadable by CheckpointLoaderSimple.
    """
    s = _seed(seed)
    wf = {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": model_filename},
        },
        "2": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt, "clip": ["1", 1]},
        },
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative_prompt or "low quality, blurry, deformed", "clip": ["1", 1]},
        },
        "4": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1},
        },
        "5": {
            "class_type": "KSampler",
            "inputs": {
                "seed": s, "steps": steps, "cfg": cfg,
                "sampler_name": "dpmpp_2m", "scheduler": "karras",
                "denoise": 1.0,
                "model":        ["1", 0],
                "positive":     ["2", 0],
                "negative":     ["3", 0],
                "latent_image": ["4", 0],
            },
        },
        "6": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["5", 0], "vae": ["1", 2]},
        },
        "7": {
            "class_type": "SaveImage",
            "inputs": {"filename_prefix": "kychapogas_img_", "images": ["6", 0]},
        },
    }
    # LoRAチェーン: model/clip を LoraLoader 経由に差し替える
    if loras:
        prev_model, prev_clip = ["1", 0], ["1", 1]
        for i, (lname, strength) in enumerate(loras):
            nid = f"lora{i}"
            wf[nid] = {"class_type": "LoraLoader",
                       "inputs": {"model": prev_model, "clip": prev_clip,
                                  "lora_name": lname,
                                  "strength_model": float(strength),
                                  "strength_clip": float(strength)}}
            prev_model, prev_clip = [nid, 0], [nid, 1]
        for node in wf.values():
            ins = node.get("inputs", {})
            if ins.get("model") == ["1", 0] and node["class_type"] != "LoraLoader":
                ins["model"] = prev_model
            if ins.get("clip") == ["1", 1] and node["class_type"] != "LoraLoader":
                ins["clip"] = prev_clip
    return wf



# ── Text-to-Image: FLUX.1 ─────────────────────────────────────────────────────

def build_flux_txt2img(
    unet_filename: str,
    clip1_filename: str,
    clip2_filename: str,
    vae_filename: str,
    prompt: str,
    width: int = 1024,
    height: int = 1024,
    seed: int = -1,
    steps: int = 20,
    guidance: float = 3.5,
) -> dict:
    """
    FLUX.1 text-to-image workflow.
    Requires UNETLoader, DualCLIPLoader, VAELoader nodes (built-in ComfyUI).
    """
    s = _seed(seed)
    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": unet_filename, "weight_dtype": "fp8_e4m3fn"}},
        "2": {"class_type": "DualCLIPLoader",
              "inputs": {"clip_name1": clip1_filename, "clip_name2": clip2_filename,
                         "type": "flux", "device": "default"}},
        "3": {"class_type": "VAELoader",
              "inputs": {"vae_name": vae_filename}},
        "4": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "EmptySD3LatentImage",
              "inputs": {"width": width, "height": height, "batch_size": 1}},
        "6": {"class_type": "FluxGuidance",
              "inputs": {"guidance": guidance, "conditioning": ["4", 0]}},
        "7": {"class_type": "BasicScheduler",
              "inputs": {"scheduler": "simple", "steps": steps, "denoise": 1.0,
                         "model": ["1", 0]}},
        "8": {"class_type": "RandomNoise",
              "inputs": {"noise_seed": s}},
        "9": {"class_type": "BasicGuider",
              "inputs": {"model": ["1", 0], "conditioning": ["6", 0]}},
        "10": {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": ["8", 0], "guider": ["9", 0],
                          "sampler": ["11", 0], "sigmas": ["7", 0],
                          "latent_image": ["5", 0]}},
        "11": {"class_type": "KSamplerSelect",
               "inputs": {"sampler_name": "euler"}},
        "12": {"class_type": "VAEDecode",
               "inputs": {"samples": ["10", 0], "vae": ["3", 0]}},
        "13": {"class_type": "SaveImage",
               "inputs": {"filename_prefix": "kychapogas_flux_", "images": ["12", 0]}},
    }


# ── Image-to-Video: Stable Video Diffusion XT ────────────────────────────────

def build_svd_i2v(
    model_filename: str,
    uploaded_image_name: str,
    width: int = 1024,
    height: int = 576,
    seed: int = -1,
    fps: int = 6,
    motion_bucket_id: int = 127,
    augmentation_level: float = 0.0,
    steps: int = 20,
    min_cfg: float = 1.0,
    cfg: float = 2.5,
) -> dict:
    """
    Stable Video Diffusion XT image-to-video workflow.
    model_filename: e.g. 'svd_xt.safetensors' (ImageOnlyCheckpointLoader)
    uploaded_image_name: name returned by POST /upload/image
    Output: GIF/video frames (saved as images; combine with FFmpeg for MP4)
    """
    s = _seed(seed)
    return {
        "1": {"class_type": "ImageOnlyCheckpointLoader",
              "inputs": {"ckpt_name": model_filename}},
        "2": {"class_type": "LoadImage",
              "inputs": {"image": uploaded_image_name, "upload": "image"}},
        "3": {"class_type": "ImageScale",
              "inputs": {"image": ["2", 0], "width": width, "height": height,
                         "upscale_method": "lanczos", "crop": "center"}},
        "4": {"class_type": "SVD_img2vid_Conditioning",
              "inputs": {
                  "clip_vision": ["1", 1], "init_image": ["3", 0], "vae": ["1", 2],
                  "width": width, "height": height,
                  "video_frames": fps * 2,  # ~2 seconds
                  "motion_bucket_id": motion_bucket_id,
                  "fps": fps,
                  "augmentation_level": augmentation_level,
              }},
        "5": {"class_type": "KSamplerAdvanced",
              "inputs": {
                  "model": ["1", 0],
                  "positive": ["4", 0], "negative": ["4", 1],
                  "latent_image": ["4", 2],
                  "seed": s, "steps": steps,
                  "cfg": cfg, "sampler_name": "euler",
                  "scheduler": "karras", "denoise": 1.0,
                  "add_noise": "enable", "return_with_leftover_noise": "disable",
                  "start_at_step": 0, "end_at_step": 10000,
              }},
        "6": {"class_type": "VAEDecode",
              "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage",
              "inputs": {"filename_prefix": "kychapogas_svd_", "images": ["6", 0]}},
    }


# ── Image-to-Video: Wan2.2 14B (first/last frame, MoE + Lightning) ───────────
#
# Verified on DGX Spark / GB10. Key facts baked in from the smoke test:
#   - The 14B I2V / Fun-InP models use the Wan2.1 VAE (wan_2.1_vae.safetensors);
#     the Wan2.2 VAE is only for the TI2V-5B model and yields a channel mismatch.
#   - umt5 text encoder loads via CLIPLoader(type="wan").
#   - A14B is a 2-expert MoE: a HIGH-noise UNET denoises the first steps, then a
#     LOW-noise UNET finishes — two chained KSamplerAdvanced passes.
#   - Lightning 4-step distillation LoRA (high/low) → 4 total steps, cfg=1.0.

WAN22_VAE            = "wan_2.1_vae.safetensors"
WAN22_TEXT_ENCODER   = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
WAN22_LIGHTNING_HIGH = "Wan2.2-Lightning/high_noise_model.safetensors"
WAN22_LIGHTNING_LOW  = "Wan2.2-Lightning/low_noise_model.safetensors"

# mode → (high_noise_unet, low_noise_unet, conditioning_node_class)
WAN22_VIDEO_MODELS: dict[str, tuple[str, str, str]] = {
    "wan2.2-flf2v": (
        "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
        "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
        "WanFirstLastFrameToVideo",
    ),
    "wan2.2-fun-inp": (
        "wan2.2_fun_inpaint_high_noise_14B_fp8_scaled.safetensors",
        "wan2.2_fun_inpaint_low_noise_14B_fp8_scaled.safetensors",
        "WanFunInpaintToVideo",
    ),
}


def _round_to(value: int, multiple: int) -> int:
    return max(multiple, int(round(value / multiple)) * multiple)


def build_wan22_video(
    mode: str,
    start_image_name: str,
    end_image_name: str | None,
    prompt: str,
    negative_prompt: str = "",
    width: int = 640,
    height: int = 640,
    length: int = 81,
    seed: int = -1,
    use_lightning: bool = True,
    total_steps: int = 4,
    shift: float = 8.0,
) -> dict:
    """
    Wan2.2 14B image-to-video with first (and optional last) frame control.

    mode: "wan2.2-flf2v" (native first-last-frame) or "wan2.2-fun-inp" (Fun-InP).
    start_image_name / end_image_name: names returned by ComfyUI /upload/image.
    Output: individual frames (SaveImage) — combine to MP4 with FFmpeg downstream.
    """
    if mode not in WAN22_VIDEO_MODELS:
        raise ValueError(f"Unknown Wan2.2 video mode: {mode}")
    high_unet, low_unet, cond_class = WAN22_VIDEO_MODELS[mode]

    s = _seed(seed)
    width  = _round_to(width, 16)
    height = _round_to(height, 16)
    length = _round_to(length - 1, 4) + 1          # Wan length must be 4n+1
    if use_lightning:
        steps, cfg = max(2, total_steps), 1.0
    else:
        steps, cfg = max(10, total_steps), 3.5
    boundary = max(1, steps // 2)                  # high-noise → low-noise split

    cond_inputs: dict[str, object] = {
        "positive": ["pos", 0], "negative": ["neg", 0], "vae": ["vae", 0],
        "width": width, "height": height, "length": length, "batch_size": 1,
        "start_image": ["img_start", 0],
    }
    wf: dict[str, dict] = {
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": WAN22_TEXT_ENCODER, "type": "wan"}},
        "vae":  {"class_type": "VAELoader", "inputs": {"vae_name": WAN22_VAE}},
        "pos":  {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["clip", 0]}},
        "neg":  {"class_type": "CLIPTextEncode",
                 "inputs": {"text": negative_prompt or "low quality, static, blurry, deformed",
                            "clip": ["clip", 0]}},
        "img_start": {"class_type": "LoadImage", "inputs": {"image": start_image_name}},

        # High-noise expert
        "unet_high": {"class_type": "UNETLoader",
                      "inputs": {"unet_name": high_unet, "weight_dtype": "default"}},
        # Low-noise expert
        "unet_low":  {"class_type": "UNETLoader",
                      "inputs": {"unet_name": low_unet, "weight_dtype": "default"}},
    }

    # Optional last frame
    if end_image_name:
        wf["img_end"] = {"class_type": "LoadImage", "inputs": {"image": end_image_name}}
        cond_inputs["end_image"] = ["img_end", 0]

    # Lightning LoRA on each expert (skip for full-quality mode)
    if use_lightning:
        wf["lora_high"] = {"class_type": "LoraLoaderModelOnly",
                           "inputs": {"model": ["unet_high", 0],
                                      "lora_name": WAN22_LIGHTNING_HIGH, "strength_model": 1.0}}
        wf["lora_low"]  = {"class_type": "LoraLoaderModelOnly",
                           "inputs": {"model": ["unet_low", 0],
                                      "lora_name": WAN22_LIGHTNING_LOW, "strength_model": 1.0}}
        high_src, low_src = ["lora_high", 0], ["lora_low", 0]
    else:
        high_src, low_src = ["unet_high", 0], ["unet_low", 0]

    wf["model_high"] = {"class_type": "ModelSamplingSD3", "inputs": {"model": high_src, "shift": shift}}
    wf["model_low"]  = {"class_type": "ModelSamplingSD3", "inputs": {"model": low_src,  "shift": shift}}

    wf["cond"] = {"class_type": cond_class, "inputs": cond_inputs}

    # Two-pass MoE sampling: high-noise then low-noise
    wf["ksampler_high"] = {"class_type": "KSamplerAdvanced", "inputs": {
        "model": ["model_high", 0], "add_noise": "enable", "noise_seed": s,
        "steps": steps, "cfg": cfg, "sampler_name": "euler", "scheduler": "simple",
        "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["cond", 2],
        "start_at_step": 0, "end_at_step": boundary, "return_with_leftover_noise": "enable"}}
    wf["ksampler_low"] = {"class_type": "KSamplerAdvanced", "inputs": {
        "model": ["model_low", 0], "add_noise": "disable", "noise_seed": s,
        "steps": steps, "cfg": cfg, "sampler_name": "euler", "scheduler": "simple",
        "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["ksampler_high", 0],
        "start_at_step": boundary, "end_at_step": 10000, "return_with_leftover_noise": "disable"}}
    wf["decode"] = {"class_type": "VAEDecode", "inputs": {"samples": ["ksampler_low", 0], "vae": ["vae", 0]}}
    wf["save"]   = {"class_type": "SaveImage",
                    "inputs": {"filename_prefix": "kychapogas_wan22", "images": ["decode", 0]}}
    return wf


# ── Model type detection helper ───────────────────────────────────────────────

def detect_model_type(model_id: str) -> str:
    """Heuristic to determine workflow type from model ID."""
    m = model_id.lower()
    if any(k in m for k in ("flux", "flux1")):
        return "flux"
    if any(k in m for k in ("svd", "svd_xt", "stable-video")):
        return "svd_i2v"
    if any(k in m for k in ("cogvideo",)):
        return "cogvideox_i2v"
    if any(k in m for k in ("xl", "sdxl")):
        return "sdxl"
    return "sd15"   # default to SD 1.5 compatible
