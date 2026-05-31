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
) -> dict:
    """
    Standard SDXL/SD1.5 text-to-image workflow.
    Works with any checkpoint loadable by CheckpointLoaderSimple.
    """
    s = _seed(seed)
    return {
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
