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
    # v-predictionモデル(NoobAI vPred等): サンプリング設定を合わせないと彩度が破綻する
    if "vpred" in model_filename.lower() or "v_pred" in model_filename.lower():
        wf["vpred"] = {"class_type": "ModelSamplingDiscrete",
                       "inputs": {"model": ["1", 0], "sampling": "v_prediction", "zsnr": True}}
        wf["rescale"] = {"class_type": "RescaleCFG",
                         "inputs": {"model": ["vpred", 0], "multiplier": 0.7}}
        for node in wf.values():
            ins = node.get("inputs", {})
            if ins.get("model") == ["1", 0] and node["class_type"] not in ("ModelSamplingDiscrete",):
                ins["model"] = ["rescale", 0]
    # LoRAチェーン: model/clip を LoraLoader 経由に差し替える
    if loras:
        vpred_on = "vpred" in wf
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
            if node["class_type"] == "LoraLoader":
                continue
            if vpred_on:
                # vpredチェーンの根本(ModelSamplingDiscreteの入力)をLoRA出力に付け替える
                if node["class_type"] == "ModelSamplingDiscrete" and ins.get("model") == ["1", 0]:
                    ins["model"] = prev_model
            elif ins.get("model") == ["1", 0]:
                ins["model"] = prev_model
            if ins.get("clip") == ["1", 1]:
                ins["clip"] = prev_clip
    return wf



def build_sdxl_img2img(
    model_filename: str,
    init_image_name: str,      # ComfyUI /upload/image 済み
    prompt: str,
    negative_prompt: str = "",
    width: int = 1024,
    height: int = 1024,
    seed: int = -1,
    steps: int = 25,
    cfg: float = 7.0,
    denoise: float = 0.6,      # 0=元画像そのまま … 1=ほぼt2i
    loras: list | None = None,
) -> dict:
    """
    SDXL image-to-image。t2iワークフローの潜在源をVAEEncode(初期画像)に差し替える。
    vpred/LoRAチェーンはbuild_sdxl_txt2imgの処理をそのまま継承する。
    """
    wf = build_sdxl_txt2img(model_filename, prompt, negative_prompt,
                            width, height, seed, steps, cfg, loras)
    wf["img_init"] = {"class_type": "LoadImage", "inputs": {"image": init_image_name}}
    wf["img_fit"] = {"class_type": "ImageScale", "inputs": {
        "image": ["img_init", 0], "upscale_method": "lanczos",
        "width": width, "height": height, "crop": "center"}}
    wf["4"] = {"class_type": "VAEEncode",
               "inputs": {"pixels": ["img_fit", 0], "vae": ["1", 2]}}
    wf["5"]["inputs"]["denoise"] = max(0.05, min(1.0, float(denoise)))
    return wf


# ── Text-to-Image: Krea 2 (12B DiT, Qwen3-VL TE, Qwen Image VAE) ─────────────

def build_sdxl_inpaint(
    model_filename: str,
    image_name: str,           # ComfyUI /upload/image 済み
    mask_name: str,            # 同上(白=描き直す領域)
    prompt: str,
    negative_prompt: str = "",
    seed: int = -1,
    steps: int = 28,
    cfg: float = 6.0,
    denoise: float = 0.92,
    grow_mask: int = 12,
) -> dict:
    """
    SDXL inpaint(InpaintModelConditioning使用 — 通常checkpointでOK)。
    コンパニオンの口形素/閉眼など「差分スプライト」生成に使う。
    """
    s = _seed(seed)
    wf = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": model_filename}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode",
              "inputs": {"text": negative_prompt or "low quality, blurry, deformed, extra teeth",
                         "clip": ["1", 1]}},
        "img": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "mimg": {"class_type": "LoadImage", "inputs": {"image": mask_name}},
        "mask": {"class_type": "ImageToMask", "inputs": {"image": ["mimg", 0], "channel": "red"}},
        "grow": {"class_type": "GrowMask",
                 "inputs": {"mask": ["mask", 0], "expand": grow_mask, "tapered_corners": True}},
        "cond": {"class_type": "InpaintModelConditioning", "inputs": {
            "positive": ["2", 0], "negative": ["3", 0], "vae": ["1", 2],
            "pixels": ["img", 0], "mask": ["grow", 0], "noise_mask": True}},
        "5": {"class_type": "KSampler", "inputs": {
            "seed": s, "steps": steps, "cfg": cfg,
            "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": denoise,
            "model": ["1", 0], "positive": ["cond", 0], "negative": ["cond", 1],
            "latent_image": ["cond", 2]}},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage",
              "inputs": {"filename_prefix": "kychapogas_inpaint_", "images": ["6", 0]}},
    }
    # vPredモデル対応(既存txt2imgと同じ流儀)
    if "vpred" in model_filename.lower():
        wf["vpred"] = {"class_type": "ModelSamplingDiscrete",
                       "inputs": {"model": ["1", 0], "sampling": "v_prediction", "zsnr": True}}
        wf["rescale"] = {"class_type": "RescaleCFG", "inputs": {"model": ["vpred", 0], "multiplier": 0.7}}
        wf["5"]["inputs"]["model"] = ["rescale", 0]
    return wf


def build_krea2_txt2img(
    unet_filename: str,          # krea2_turbo_fp8_scaled / krea2_raw_fp8_scaled
    te_filename: str,            # qwen3vl_4b_fp8_scaled.safetensors
    vae_filename: str,           # qwen_image_vae.safetensors
    prompt: str,
    negative_prompt: str = "",
    width: int = 1024,
    height: int = 1024,
    seed: int = -1,
    steps: int | None = None,
    cfg: float | None = None,
    loras: list | None = None,   # [(lora_filename, strength)] — LoraLoaderModelOnly チェーン
) -> dict:
    """
    Krea 2 text-to-image (ComfyUI 0.26+ ネイティブ対応, CLIPType "krea2")。
    Turbo(蒸留)は 8step/cfg1.0、RAW は 28step/cfg4.0 を既定にする。
    shift(1.15)はモデル定義側に内蔵なので ModelSampling ノードは不要。
    """
    turbo = "turbo" in unet_filename.lower()
    steps = steps if steps is not None else (8 if turbo else 28)
    cfg = cfg if cfg is not None else (1.0 if turbo else 4.0)
    s = _seed(seed)
    wf = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": unet_filename, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": te_filename, "type": "krea2", "device": "default"}},
        "3": {"class_type": "VAELoader",
              "inputs": {"vae_name": vae_filename}},
        "4": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode",
              "inputs": {"text": negative_prompt, "clip": ["2", 0]}},
        # Krea 2 の latent は Wan21 系16ch — Qwen Image と同じく SD3 latent ノードで良い
        "6": {"class_type": "EmptySD3LatentImage",
              "inputs": {"width": width, "height": height, "batch_size": 1}},
        "7": {"class_type": "KSampler",
              "inputs": {"seed": s, "steps": steps, "cfg": cfg,
                         "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
                         "model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0],
                         "latent_image": ["6", 0]}},
        "8": {"class_type": "VAEDecode",
              "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage",
              "inputs": {"filename_prefix": "kychapogas_krea2_", "images": ["8", 0]}},
    }
    prev = ["1", 0]
    for i, (lname, strength) in enumerate(loras or []):
        nid = f"lora{i}"
        wf[nid] = {"class_type": "LoraLoaderModelOnly",
                   "inputs": {"lora_name": lname, "strength_model": float(strength),
                              "model": prev}}
        prev = [nid, 0]
    if prev != ["1", 0]:
        wf["7"]["inputs"]["model"] = prev
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

# Wan公式リポジトリ/LightX2V配布スクリプト同梱の推奨ネガティブプロンプト
WAN22_DEFAULT_NEGATIVE = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，"
    "低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，"
    "毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)

WAN22_VAE            = "wan_2.1_vae.safetensors"
WAN22_TEXT_ENCODER   = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
# Seko-V1 (2025-08) — fun_control で実績のある旧世代。I2V/VACE は 1022 を使う。
WAN22_LIGHTNING_HIGH = "Wan2.2-Lightning/high_noise_model.safetensors"
WAN22_LIGHTNING_LOW  = "Wan2.2-Lightning/low_noise_model.safetensors"
# lightx2v 1022 蒸留LoRA (2025-10) — I2V-A14B 用の現行推奨。shift=5/cfg=1/euler+simple。
WAN22_LIGHTNING_1022_HIGH = "wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors"
WAN22_LIGHTNING_1022_LOW  = "wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors"
# Lightning蒸留はshift=5.0のシグマで学習されている(非蒸留は従来どおり8.0)
WAN22_SHIFT_LIGHTNING = 5.0
WAN22_SHIFT_FULL      = 8.0

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
    shift: float | None = None,
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
    if shift is None:
        shift = WAN22_SHIFT_LIGHTNING if use_lightning else WAN22_SHIFT_FULL
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
                 "inputs": {"text": negative_prompt or WAN22_DEFAULT_NEGATIVE,
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
    # 1022 蒸留LoRA (lightx2v/Wan2.2-Distill-Loras) — I2V-A14B 現行推奨
    if use_lightning:
        wf["lora_high"] = {"class_type": "LoraLoaderModelOnly",
                           "inputs": {"model": ["unet_high", 0],
                                      "lora_name": WAN22_LIGHTNING_1022_HIGH, "strength_model": 1.0}}
        wf["lora_low"]  = {"class_type": "LoraLoaderModelOnly",
                           "inputs": {"model": ["unet_low", 0],
                                      "lora_name": WAN22_LIGHTNING_1022_LOW, "strength_model": 1.0}}
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


# ── Wan2.2 VACE: 任意フレーム位置のキーフレーム条件付け ──────────────────────
#
# WanVaceToVideo は「control_video(グレー=自由/画像=固定) + control_masks
# (1=生成/0=固定)」で任意のフレーム位置に画像を釘打ちできる。FLF2Vの区間連結と
# 違い1パス生成なので、つなぎ目のモーション断絶が起きない。
# コントロール列は ComfyUI ノードだけで組み立てる(EmptyImage+ImageBatch連鎖)。

WAN22_VACE_HIGH = "wan2.2_fun_vace_high_noise_14B_fp8_scaled.safetensors"
WAN22_VACE_LOW  = "wan2.2_fun_vace_low_noise_14B_fp8_scaled.safetensors"

_GRAY  = 0x7F7F7F   # EmptyImage color: 自由領域(VACEの「未指定」はグレー)
_WHITE = 0xFFFFFF   # マスク1 = ここを生成する
_BLACK = 0x000000   # マスク0 = キーフレームで固定


def build_wan22_vace_video(
    keyframes: list[tuple[str, int]],   # (uploaded_image_name, frame_index) 昇順
    prompt: str,
    negative_prompt: str = "",
    width: int = 640,
    height: int = 640,
    length: int = 81,
    seed: int = -1,
    use_lightning: bool = True,
    total_steps: int = 4,
    shift: float | None = None,
    vace_strength: float = 1.0,
) -> dict:
    """
    Wan2.2 VACE Fun: 最初/最後に限らず任意のフレーム位置へキーフレームを固定した
    1パス生成。keyframes は (アップロード済み画像名, フレーム番号) のリスト。
    出力はフレーム列(SaveImage) — 下流で FFmpeg 結合。
    """
    s = _seed(seed)
    width  = _round_to(width, 16)
    height = _round_to(height, 16)
    length = _round_to(length - 1, 4) + 1
    if shift is None:
        shift = WAN22_SHIFT_LIGHTNING if use_lightning else WAN22_SHIFT_FULL
    if use_lightning:
        steps, cfg = max(2, total_steps), 1.0
    else:
        steps, cfg = max(10, total_steps), 3.5
    boundary = max(1, steps // 2)

    # フレーム番号を正規化(重複除去・範囲内・昇順)
    kfs: list[tuple[str, int]] = []
    seen: set[int] = set()
    for name, idx in sorted(keyframes, key=lambda kf: kf[1]):
        idx = max(0, min(length - 1, int(idx)))
        if idx in seen:
            continue
        seen.add(idx)
        kfs.append((name, idx))
    if not kfs:
        raise ValueError("VACE には最低1つのキーフレームが必要です")

    wf: dict[str, dict] = {
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": WAN22_TEXT_ENCODER, "type": "wan"}},
        "vae":  {"class_type": "VAELoader", "inputs": {"vae_name": WAN22_VAE}},
        "pos":  {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["clip", 0]}},
        "neg":  {"class_type": "CLIPTextEncode",
                 "inputs": {"text": negative_prompt or WAN22_DEFAULT_NEGATIVE,
                            "clip": ["clip", 0]}},
        "unet_high": {"class_type": "UNETLoader",
                      "inputs": {"unet_name": WAN22_VACE_HIGH, "weight_dtype": "default"}},
        "unet_low":  {"class_type": "UNETLoader",
                      "inputs": {"unet_name": WAN22_VACE_LOW, "weight_dtype": "default"}},
    }

    # ── control_video / control_masks をノードで組み立てる ──
    # 各キーフレーム位置に画像1枚、それ以外はグレー。マスクは固定=黒(0)/生成=白(1)。
    def _gray(node_id: str, n: int, color: int) -> None:
        wf[node_id] = {"class_type": "EmptyImage", "inputs": {
            "width": width, "height": height, "batch_size": n, "color": color}}

    ctl_chain: list[list] = []   # 連結順の [node_id, out] 参照
    msk_chain: list[list] = []
    cursor = 0
    for i, (name, idx) in enumerate(kfs):
        if idx > cursor:                        # キーフレーム前の自由区間
            _gray(f"ctl_gap{i}", idx - cursor, _GRAY)
            _gray(f"msk_gap{i}", idx - cursor, _WHITE)
            ctl_chain.append([f"ctl_gap{i}", 0])
            msk_chain.append([f"msk_gap{i}", 0])
        wf[f"kf{i}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
        wf[f"kf{i}_fit"] = {"class_type": "ImageScale", "inputs": {
            "image": [f"kf{i}", 0], "upscale_method": "lanczos",
            "width": width, "height": height, "crop": "center"}}
        _gray(f"msk_kf{i}", 1, _BLACK)
        ctl_chain.append([f"kf{i}_fit", 0])
        msk_chain.append([f"msk_kf{i}", 0])
        cursor = idx + 1
    if cursor < length:                          # 末尾の自由区間
        _gray("ctl_tail", length - cursor, _GRAY)
        _gray("msk_tail", length - cursor, _WHITE)
        ctl_chain.append(["ctl_tail", 0])
        msk_chain.append(["msk_tail", 0])

    def _concat(prefix: str, chain: list[list]) -> list:
        ref = chain[0]
        for j, nxt in enumerate(chain[1:]):
            nid = f"{prefix}_cat{j}"
            wf[nid] = {"class_type": "ImageBatch",
                       "inputs": {"image1": ref, "image2": nxt}}
            ref = [nid, 0]
        return ref

    ctl_ref = _concat("ctl", ctl_chain)
    msk_img = _concat("msk", msk_chain)
    wf["msk_mask"] = {"class_type": "ImageToMask",
                      "inputs": {"image": msk_img, "channel": "red"}}

    if use_lightning:
        # I2V蒸留LoRAをVACE Funに転用(A14B同系)。モーション崩れ時はhigh側を0.6-0.8へ。
        wf["lora_high"] = {"class_type": "LoraLoaderModelOnly",
                           "inputs": {"model": ["unet_high", 0],
                                      "lora_name": WAN22_LIGHTNING_1022_HIGH, "strength_model": 1.0}}
        wf["lora_low"]  = {"class_type": "LoraLoaderModelOnly",
                           "inputs": {"model": ["unet_low", 0],
                                      "lora_name": WAN22_LIGHTNING_1022_LOW, "strength_model": 1.0}}
        high_src, low_src = ["lora_high", 0], ["lora_low", 0]
    else:
        high_src, low_src = ["unet_high", 0], ["unet_low", 0]

    wf["model_high"] = {"class_type": "ModelSamplingSD3", "inputs": {"model": high_src, "shift": shift}}
    wf["model_low"]  = {"class_type": "ModelSamplingSD3", "inputs": {"model": low_src,  "shift": shift}}

    wf["cond"] = {"class_type": "WanVaceToVideo", "inputs": {
        "positive": ["pos", 0], "negative": ["neg", 0], "vae": ["vae", 0],
        "width": width, "height": height, "length": length, "batch_size": 1,
        "strength": vace_strength,
        "control_video": ctl_ref, "control_masks": ["msk_mask", 0]}}

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
    wf["trim"]   = {"class_type": "TrimVideoLatent",
                    "inputs": {"samples": ["ksampler_low", 0], "trim_amount": ["cond", 3]}}
    wf["decode"] = {"class_type": "VAEDecode", "inputs": {"samples": ["trim", 0], "vae": ["vae", 0]}}
    wf["save"]   = {"class_type": "SaveImage",
                    "inputs": {"filename_prefix": "kychapogas_vace", "images": ["decode", 0]}}
    return wf


# ── Wan2.2 S2V: 音声駆動ビデオ(歌わせる/喋らせる) ────────────────────────────

WAN22_S2V_UNET = "wan2.2_s2v_14B_fp8_scaled.safetensors"
WAN22_S2V_AUDIO_ENC = "wav2vec2_large_english_fp16.safetensors"


def build_wan22_s2v(
    ref_image_name: str,          # ComfyUI /upload/image 済みの参照画像(歌わせたいキャラ)
    audio_name: str,              # ComfyUI input/ に置いた音声ファイル名(wav)
    prompt: str,
    negative_prompt: str = "",
    width: int = 640,
    height: int = 640,
    length: int = 77,             # 4n+1
    seed: int = -1,
    steps: int = 20,
    cfg: float = 6.0,
    shift: float = 8.0,
) -> dict:
    """
    Wan2.2 S2V (Sound-to-Video): 参照画像+音声 → リップシンク/演技付き動画。
    出力はSaveImage(フレーム列) — 既存のWan経路と同じくFFmpegで結合する。
    """
    s = _seed(seed)
    width, height = _round_to(width, 16), _round_to(height, 16)
    length = _round_to(length - 1, 4) + 1
    return {
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": WAN22_TEXT_ENCODER, "type": "wan"}},
        "vae":  {"class_type": "VAELoader", "inputs": {"vae_name": WAN22_VAE}},
        "pos":  {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["clip", 0]}},
        "neg":  {"class_type": "CLIPTextEncode",
                 "inputs": {"text": negative_prompt or WAN22_DEFAULT_NEGATIVE,
                            "clip": ["clip", 0]}},
        "img":  {"class_type": "LoadImage", "inputs": {"image": ref_image_name}},
        "aud":  {"class_type": "LoadAudio", "inputs": {"audio": audio_name}},
        "aenc_l": {"class_type": "AudioEncoderLoader",
                   "inputs": {"audio_encoder_name": WAN22_S2V_AUDIO_ENC}},
        "aenc": {"class_type": "AudioEncoderEncode",
                 "inputs": {"audio_encoder": ["aenc_l", 0], "audio": ["aud", 0]}},
        "unet": {"class_type": "UNETLoader",
                 "inputs": {"unet_name": WAN22_S2V_UNET, "weight_dtype": "default"}},
        "model": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["unet", 0], "shift": shift}},
        "cond": {"class_type": "WanSoundImageToVideo", "inputs": {
            "positive": ["pos", 0], "negative": ["neg", 0], "vae": ["vae", 0],
            "width": width, "height": height, "length": length, "batch_size": 1,
            "audio_encoder_output": ["aenc", 0], "ref_image": ["img", 0]}},
        "ksampler": {"class_type": "KSampler", "inputs": {
            "seed": s, "steps": steps, "cfg": cfg,
            "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
            "model": ["model", 0], "positive": ["cond", 0], "negative": ["cond", 1],
            "latent_image": ["cond", 2]}},
        "decode": {"class_type": "VAEDecode", "inputs": {"samples": ["ksampler", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage",
                 "inputs": {"filename_prefix": "kychapogas_s2v", "images": ["decode", 0]}},
    }


# ── Model type detection helper ───────────────────────────────────────────────

def detect_model_type(model_id: str) -> str:
    """Heuristic to determine workflow type from model ID."""
    m = model_id.lower()
    if any(k in m for k in ("krea2", "krea-2", "krea 2")):
        return "krea2"
    if any(k in m for k in ("flux", "flux1")):
        return "flux"
    if any(k in m for k in ("svd", "svd_xt", "stable-video")):
        return "svd_i2v"
    if any(k in m for k in ("cogvideo",)):
        return "cogvideox_i2v"
    if any(k in m for k in ("xl", "sdxl")):
        return "sdxl"
    return "sd15"   # default to SD 1.5 compatible


# ── 3D生成: Hunyuan3D-2 (画像→GLBメッシュ) ───────────────────────────────────

HY3D_CKPT = "hunyuan3d-dit-v2_fp16.safetensors"
HY3D_MV_CKPT = "hunyuan3d-dit-v2-mv_fp16.safetensors"


def build_hunyuan3d_i23d(
    image_name: str,
    seed: int = -1,
    steps: int = 30,
    cfg: float = 5.0,
    resolution: int = 3072,
    octree_resolution: int = 256,
    algorithm: str = "surface net",   # VoxelToMesh: "surface net" | "basic"
) -> dict:
    """単一画像→3Dメッシュ(GLB)。入力は背景透過画像が最良(cutout-kit前処理推奨)。"""
    s = _seed(seed)
    return {
        "ckpt": {"class_type": "ImageOnlyCheckpointLoader", "inputs": {"ckpt_name": HY3D_CKPT}},
        "img": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "cv": {"class_type": "CLIPVisionEncode",
               "inputs": {"clip_vision": ["ckpt", 1], "image": ["img", 0], "crop": "center"}},
        "cond": {"class_type": "Hunyuan3Dv2Conditioning", "inputs": {"clip_vision_output": ["cv", 0]}},
        "latent": {"class_type": "EmptyLatentHunyuan3Dv2",
                   "inputs": {"resolution": resolution, "batch_size": 1}},
        "sampler": {"class_type": "KSampler", "inputs": {
            "model": ["ckpt", 0], "seed": s, "steps": steps, "cfg": cfg,
            "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0,
            "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["latent", 0]}},
        "voxel": {"class_type": "VAEDecodeHunyuan3D", "inputs": {
            "samples": ["sampler", 0], "vae": ["ckpt", 2],
            "num_chunks": 8000, "octree_resolution": octree_resolution}},
        "mesh": {"class_type": "VoxelToMesh", "inputs": {"voxel": ["voxel", 0],
                 "algorithm": algorithm, "threshold": 0.6}},
        "save": {"class_type": "SaveGLB", "inputs": {"mesh": ["mesh", 0],
                 "filename_prefix": "3d/kychapogas_hy3d"}},
    }


def build_hunyuan3d_mv(
    views: dict,                  # {"front": name, "left": name, "back": name, "right": name} 一部省略可
    seed: int = -1,
    steps: int = 30,
    cfg: float = 5.0,
    resolution: int = 3072,
    octree_resolution: int = 256,
) -> dict:
    """マルチビュー(正面/左/背面/右)→3Dメッシュ。コンパニオン素材シートの流用に最適。"""
    s = _seed(seed)
    wf = {
        "ckpt": {"class_type": "ImageOnlyCheckpointLoader", "inputs": {"ckpt_name": HY3D_MV_CKPT}},
        "latent": {"class_type": "EmptyLatentHunyuan3Dv2",
                   "inputs": {"resolution": resolution, "batch_size": 1}},
    }
    cond_inputs = {}
    for view, name in views.items():
        if not name:
            continue
        wf[f"img_{view}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
        wf[f"cv_{view}"] = {"class_type": "CLIPVisionEncode",
                            "inputs": {"clip_vision": ["ckpt", 1], "image": [f"img_{view}", 0], "crop": "center"}}
        cond_inputs[view] = [f"cv_{view}", 0]
    wf["cond"] = {"class_type": "Hunyuan3Dv2ConditioningMultiView", "inputs": cond_inputs}
    wf["sampler"] = {"class_type": "KSampler", "inputs": {
        "model": ["ckpt", 0], "seed": s, "steps": steps, "cfg": cfg,
        "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1.0,
        "positive": ["cond", 0], "negative": ["cond", 1], "latent_image": ["latent", 0]}}
    wf["voxel"] = {"class_type": "VAEDecodeHunyuan3D", "inputs": {
        "samples": ["sampler", 0], "vae": ["ckpt", 2],
        "num_chunks": 8000, "octree_resolution": octree_resolution}}
    wf["mesh"] = {"class_type": "VoxelToMesh", "inputs": {"voxel": ["voxel", 0],
                  "algorithm": "surface net", "threshold": 0.6}}
    wf["save"] = {"class_type": "SaveGLB", "inputs": {"mesh": ["mesh", 0],
                  "filename_prefix": "3d/kychapogas_hy3dmv"}}
    return wf


# ── 3D生成: MoGe-2 レリーフメッシュ(一枚絵→テクスチャ付き深度メッシュ) ──────

MOGE_MODEL = "moge_2_vitl_normal_fp16.safetensors"


def build_moge_relief(
    image_name: str,
    resolution_level: int = 9,
    decimation: int = 2,      # 頂点ストライド1-8(1=フル解像度)
    discontinuity_threshold: float = 0.03,
    fov_x_degrees: float = 60.0,
) -> dict:
    """一枚絵→元絵テクスチャ付きレリーフメッシュ(GLB)。イラスト内をカメラが飛ぶ3Dフォト演出用。"""
    return {
        "model": {"class_type": "LoadMoGeModel", "inputs": {"model_name": MOGE_MODEL}},
        "img": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "geo": {"class_type": "MoGeInference", "inputs": {
            "moge_model": ["model", 0], "image": ["img", 0],
            "resolution_level": resolution_level, "fov_x_degrees": fov_x_degrees,
            "batch_size": 1, "force_projection": True, "apply_mask": True}},
        "mesh": {"class_type": "MoGePointMapToMesh", "inputs": {
            "moge_geometry": ["geo", 0], "batch_index": 0,
            "decimation": decimation,
            "discontinuity_threshold": discontinuity_threshold, "texture": True}},
        "save": {"class_type": "SaveGLB", "inputs": {"mesh": ["mesh", 0],
                 "filename_prefix": "3d/kychapogas_relief"}},
    }


# ── Wan2.2 Fun Control: 3Dカメラワーク×AIレンダ ──────────────────────────────

WAN22_FUNCTRL_HIGH = "wan2.2_fun_control_high_noise_14B_fp8_scaled.safetensors"
WAN22_FUNCTRL_LOW  = "wan2.2_fun_control_low_noise_14B_fp8_scaled.safetensors"


def build_wan22_fun_control(
    ref_image_name: str,          # /upload/image 済みの参照画像(キャラ原画=画風・キャラ維持)
    control_video_name: str,      # /upload/image 済みのコントロール動画(深度/線画列, 16fps)
    prompt: str,
    negative_prompt: str = "",
    width: int = 832,
    height: int = 480,
    length: int = 81,
    seed: int = -1,
    use_lightning: bool = True,
    total_steps: int = 4,
    shift: float = 8.0,
) -> dict:
    """
    Wan2.2 Fun Control: 3Dシーンの深度レンダ(render_orbit.mjs --style depth)を
    control_video に流し、そのカメラワークどおりの動画を ref_image の画風で生成する。
    出力はフレーム列(SaveImage) — 下流で FFmpeg 結合。
    """
    s = _seed(seed)
    width  = _round_to(width, 16)
    height = _round_to(height, 16)
    length = _round_to(length - 1, 4) + 1
    if use_lightning:
        steps, cfg = max(2, total_steps), 1.0
    else:
        steps, cfg = max(10, total_steps), 3.5
    boundary = max(1, steps // 2)

    wf: dict[str, dict] = {
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": WAN22_TEXT_ENCODER, "type": "wan"}},
        "vae":  {"class_type": "VAELoader", "inputs": {"vae_name": WAN22_VAE}},
        "pos":  {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["clip", 0]}},
        "neg":  {"class_type": "CLIPTextEncode",
                 "inputs": {"text": negative_prompt or WAN22_DEFAULT_NEGATIVE,
                            "clip": ["clip", 0]}},
        "img_ref": {"class_type": "LoadImage", "inputs": {"image": ref_image_name}},
        "ctl_vid": {"class_type": "LoadVideo", "inputs": {"file": control_video_name}},
        "ctl_img": {"class_type": "GetVideoComponents", "inputs": {"video": ["ctl_vid", 0]}},
        "unet_high": {"class_type": "UNETLoader",
                      "inputs": {"unet_name": WAN22_FUNCTRL_HIGH, "weight_dtype": "default"}},
        "unet_low":  {"class_type": "UNETLoader",
                      "inputs": {"unet_name": WAN22_FUNCTRL_LOW, "weight_dtype": "default"}},
    }

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

    wf["cond"] = {"class_type": "Wan22FunControlToVideo", "inputs": {
        "positive": ["pos", 0], "negative": ["neg", 0], "vae": ["vae", 0],
        "width": width, "height": height, "length": length, "batch_size": 1,
        "ref_image": ["img_ref", 0], "control_video": ["ctl_img", 0]}}

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
                    "inputs": {"filename_prefix": "kychapogas_3dcam", "images": ["decode", 0]}}
    return wf


# ══════════════════════════════════════════════════════════════════════════════
# ✏️ AI画像編集(instruction edit) — Qwen-2511 / HiDream-O1 / FLUX.2 klein KV
# 公式テンプレート(comfyui_workflow_templates 0.11.15)のグラフ構造を移植。
# ══════════════════════════════════════════════════════════════════════════════

QWEN_EDIT_BF16      = "qwen_image_edit_2511_bf16.safetensors"
QWEN_EDIT_FP8_LIGHT = "qwen_image_edit_2511_fp8_lightning_4steps.safetensors"  # Lightning融合済み
QWEN_EDIT_LORA_4S   = "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
QWEN_EDIT_TE        = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
QWEN_EDIT_VAE       = "qwen_image_vae.safetensors"

HIDREAM_O1_DEV_CKPT = "hidream_o1_image_dev_fp8_scaled.safetensors"

FLUX2_KLEIN_KV_UNET = "flux-2-klein-9b-kv-fp8.safetensors"
FLUX2_KLEIN_TE      = "qwen_3_8b_fp8mixed.safetensors"
FLUX2_VAE           = "flux2-vae.safetensors"

# UI/API向けの編集モデルID
IMAGE_EDIT_MODELS = {"qwen-edit-2511", "qwen-edit-2511-fp8", "hidream-o1-dev", "flux2-klein-kv"}


def build_qwen_image_edit(
    ref_image_names: list[str],     # /upload/image 済み(1〜3枚)。image1が編集対象
    prompt: str,
    seed: int = -1,
    use_lightning: bool = True,
    fused_fp8: bool = False,        # True=Lightning融合fp8単体(LoRA不要)
) -> dict:
    """Qwen-Image-Edit-2511: 指示文編集+マルチ参照(最大3枚)。出力サイズはimage1に追従。"""
    if not ref_image_names:
        raise ValueError("編集には参照画像が最低1枚必要です")
    s = _seed(seed)
    steps, cfg = (4, 1.0) if use_lightning else (40, 3.0)
    unet = QWEN_EDIT_FP8_LIGHT if fused_fp8 else QWEN_EDIT_BF16

    wf: dict[str, dict] = {
        "unet": {"class_type": "UNETLoader",
                 "inputs": {"unet_name": unet, "weight_dtype": "default"}},
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": QWEN_EDIT_TE, "type": "qwen_image", "device": "default"}},
        "vae":  {"class_type": "VAELoader", "inputs": {"vae_name": QWEN_EDIT_VAE}},
        "ms":   {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["unet", 0], "shift": 3.1}},
        "norm": {"class_type": "CFGNorm", "inputs": {"model": ["ms", 0], "strength": 1.0}},
    }
    model_src = ["norm", 0]
    if use_lightning and not fused_fp8:
        wf["lora"] = {"class_type": "LoraLoaderModelOnly",
                      "inputs": {"model": model_src, "lora_name": QWEN_EDIT_LORA_4S,
                                 "strength_model": 1.0}}
        model_src = ["lora", 0]

    enc_inputs: dict[str, object] = {"clip": ["clip", 0], "vae": ["vae", 0]}
    for i, name in enumerate(ref_image_names[:3]):
        wf[f"img{i}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
        if i == 0:
            # image1のみKontextスケール(出力解像度の基準になる)
            wf["scale0"] = {"class_type": "FluxKontextImageScale", "inputs": {"image": ["img0", 0]}}
            enc_inputs["image1"] = ["scale0", 0]
        else:
            enc_inputs[f"image{i+1}"] = [f"img{i}", 0]

    wf["pos"] = {"class_type": "TextEncodeQwenImageEditPlus",
                 "inputs": {**enc_inputs, "prompt": prompt}}
    wf["neg"] = {"class_type": "TextEncodeQwenImageEditPlus",
                 "inputs": {**enc_inputs, "prompt": ""}}
    wf["pos_m"] = {"class_type": "FluxKontextMultiReferenceLatentMethod",
                   "inputs": {"conditioning": ["pos", 0], "reference_latents_method": "index_timestep_zero"}}
    wf["neg_m"] = {"class_type": "FluxKontextMultiReferenceLatentMethod",
                   "inputs": {"conditioning": ["neg", 0], "reference_latents_method": "index_timestep_zero"}}
    wf["lat"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["scale0", 0], "vae": ["vae", 0]}}
    wf["ks"] = {"class_type": "KSampler", "inputs": {
        "seed": s, "steps": steps, "cfg": cfg,
        "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
        "model": model_src, "positive": ["pos_m", 0], "negative": ["neg_m", 0],
        "latent_image": ["lat", 0]}}
    wf["dec"] = {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}}
    wf["save"] = {"class_type": "SaveImage",
                  "inputs": {"filename_prefix": "kychapogas_edit_qwen", "images": ["dec", 0]}}
    return wf


def build_hidream_o1_edit(
    ref_image_names: list[str],     # 1枚=指示編集 / 2〜10枚=マルチ参照
    prompt: str,
    width: int,
    height: int,
    seed: int = -1,
    steps: int = 28,
) -> dict:
    """
    HiDream-O1 Dev: ピクセル空間の指示編集。
    公式テンプレ準拠: 参照を4MPへlanczosスケールし、出力latentは
    その参照サイズをfloor(x/32)*32したものを使う(width/height引数は使わない —
    ピクセル空間UiTは~2048級の解像度が前提で、小さいlatentだと質感が崩壊する)。
    """
    if not ref_image_names:
        raise ValueError("編集には参照画像が最低1枚必要です")
    s = _seed(seed)

    wf: dict[str, dict] = {
        "ckpt": {"class_type": "CheckpointLoaderSimple",
                 "inputs": {"ckpt_name": HIDREAM_O1_DEV_CKPT}},
        "noise": {"class_type": "ModelNoiseScale",
                  "inputs": {"model": ["ckpt", 0], "noise_scale": 7.6}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["ckpt", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["ckpt", 1]}},
        "sched": {"class_type": "BasicScheduler",
                  "inputs": {"model": ["noise", 0], "scheduler": "normal",
                             "steps": steps, "denoise": 1.0}},
        "smp": {"class_type": "SamplerLCM",
                "inputs": {"s_noise": 1.0, "s_noise_end": 1.0, "noise_clip_std": 2.5}},
    }
    ref_inputs: dict[str, object] = {"positive": ["pos", 0], "negative": ["neg", 0]}
    for i, name in enumerate(ref_image_names[:10]):
        wf[f"img{i}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
        wf[f"fit{i}"] = {"class_type": "ImageScaleToTotalPixels",
                         "inputs": {"image": [f"img{i}", 0], "upscale_method": "lanczos",
                                    "megapixels": 4.0, "resolution_steps": 1}}
        ref_inputs[f"images.image_{i+1}"] = [f"fit{i}", 0]
    wf["refs"] = {"class_type": "HiDreamO1ReferenceImages", "inputs": ref_inputs}
    # latentサイズ = 1枚目参照(4MPスケール後)のfloor(/32)*32
    wf["size"] = {"class_type": "GetImageSize", "inputs": {"image": ["fit0", 0]}}
    wf["mw"] = {"class_type": "ComfyMathExpression",
                "inputs": {"expression": "floor(a/32)*32", "values.a": ["size", 0]}}
    wf["mh"] = {"class_type": "ComfyMathExpression",
                "inputs": {"expression": "floor(a/32)*32", "values.a": ["size", 1]}}
    wf["lat"] = {"class_type": "EmptyHiDreamO1LatentImage",
                 "inputs": {"width": ["mw", 1], "height": ["mh", 1], "batch_size": 1}}
    wf["ks"] = {"class_type": "SamplerCustom", "inputs": {
        "model": ["noise", 0], "add_noise": True, "noise_seed": s, "cfg": 1.0,
        "positive": ["refs", 0], "negative": ["refs", 1],
        "sampler": ["smp", 0], "sigmas": ["sched", 0], "latent_image": ["lat", 0]}}
    wf["dec"] = {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["ckpt", 2]}}
    wf["save"] = {"class_type": "SaveImage",
                  "inputs": {"filename_prefix": "kychapogas_edit_hidream", "images": ["dec", 0]}}
    return wf


def build_flux2_klein_edit(
    ref_image_names: list[str],     # 参照1〜4枚
    prompt: str,
    width: int = 1024,
    height: int = 1024,
    seed: int = -1,
    steps: int = 4,                 # klein 9B は4step蒸留
) -> dict:
    """FLUX.2 klein 9B KV: 参照KVキャッシュ付き編集。同一参照の反復編集が高速。"""
    if not ref_image_names:
        raise ValueError("編集には参照画像が最低1枚必要です")
    s = _seed(seed)
    width, height = _round_to(width, 16), _round_to(height, 16)

    wf: dict[str, dict] = {
        "unet": {"class_type": "UNETLoader",
                 "inputs": {"unet_name": FLUX2_KLEIN_KV_UNET, "weight_dtype": "default"}},
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": FLUX2_KLEIN_TE, "type": "flux2", "device": "default"}},
        "vae":  {"class_type": "VAELoader", "inputs": {"vae_name": FLUX2_VAE}},
        "txt":  {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["clip", 0]}},
        "zero": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["txt", 0]}},
    }
    cond = ["txt", 0]
    for i, name in enumerate(ref_image_names[:4]):
        wf[f"img{i}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
        wf[f"fit{i}"] = {"class_type": "ImageScaleToTotalPixels",
                         "inputs": {"image": [f"img{i}", 0], "upscale_method": "lanczos",
                                    "megapixels": 1.0, "resolution_steps": 1}}
        wf[f"enc{i}"] = {"class_type": "VAEEncode",
                         "inputs": {"pixels": [f"fit{i}", 0], "vae": ["vae", 0]}}
        wf[f"ref{i}"] = {"class_type": "ReferenceLatent",
                         "inputs": {"conditioning": cond, "latent": [f"enc{i}", 0]}}
        cond = [f"ref{i}", 0]
    wf["kv"] = {"class_type": "FluxKVCache", "inputs": {"model": ["unet", 0]}}
    wf["guider"] = {"class_type": "CFGGuider", "inputs": {
        "model": ["kv", 0], "positive": cond, "negative": ["zero", 0], "cfg": 1.0}}
    wf["noise"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": s}}
    wf["ksel"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}}
    wf["sched"] = {"class_type": "Flux2Scheduler",
                   "inputs": {"steps": steps, "width": width, "height": height}}
    wf["lat"] = {"class_type": "EmptyFlux2LatentImage",
                 "inputs": {"width": width, "height": height, "batch_size": 1}}
    wf["ks"] = {"class_type": "SamplerCustomAdvanced", "inputs": {
        "noise": ["noise", 0], "guider": ["guider", 0], "sampler": ["ksel", 0],
        "sigmas": ["sched", 0], "latent_image": ["lat", 0]}}
    wf["dec"] = {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}}
    wf["save"] = {"class_type": "SaveImage",
                  "inputs": {"filename_prefix": "kychapogas_edit_klein", "images": ["dec", 0]}}
    return wf


# ── MiniMax H3 (FL2VA): 映像+ネイティブ音声の同時生成 ────────────────────────
#
# 公式テンプレ(video_minimax_h3_i2v)準拠。最初/最後フレーム条件付け対応。
# 出力はSaveVideo(音声込みmp4)。lengthは24fps・17k+5グリッドへ切り上げスナップ。

H3_UNET = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
H3_TE = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
H3_VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
H3_AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"
H3_FPS = 24


def h3_snap_length(frames: int) -> int:
    """
    H3のフレーム数制約: 17k+5グリッドへ切り上げ+訓練域124-362へクランプ。
    (公式tooltip: 124=約5秒、訓練レンジ~124-362、超過は未検証)
    """
    n = max(124, min(362, int(frames)))
    return min(362, n + (5 - (n % 17)) % 17)


def _h3_apply_easycache(wf: dict, src: str = "unet") -> None:
    """EasyCacheノードを src と guider/scheduler の間に挿入。
    ステップ間の特徴再利用で約1.5〜2倍(内容依存)。副作用はわずかな甘さ/動きの平滑化。

    src は「モデルを供給しているノード」。LoRAを挟んだ場合は "unet" ではなく LoRA ノードを
    渡すこと。"unet" のままだとEasyCacheがLoRA前の素のUNETに繋がり、どこからも参照されない
    孤立ノードになって(ComfyUIが未使用ノードを刈るため)無言で効かなくなる。
    """
    wf["ecache"] = {"class_type": "EasyCache", "inputs": {
        "model": [src, 0],
        "reuse_threshold": 0.2, "start_percent": 0.15, "end_percent": 0.95,
        "verbose": False,
    }}
    for node in wf.values():
        ins = node.get("inputs", {})
        for k, v in ins.items():
            if node is not wf["ecache"] and isinstance(v, list) and v and v[0] == src:
                ins[k] = ["ecache", 0]


def build_minimax_h3_video(
    prompt: str,
    width: int = 1280,
    height: int = 720,
    length: int = 124,              # 24fpsフレーム数(スナップされる)
    first_image_name: str | None = None,
    last_image_name: str | None = None,
    seed: int = -1,
    steps: int = 20,
    easycache: bool = True,
    preview_steps: int | None = None,   # 🎬予告編(Ref2VAと同じ仕組み。詳細はbuild_minimax_h3_ref_video参照)
) -> dict:
    s = _seed(seed)
    width = max(32, (width // 32) * 32)
    height = max(32, (height // 32) * 32)
    length = h3_snap_length(length)

    wf: dict[str, dict] = {
        "unet": {"class_type": "UNETLoader",
                 "inputs": {"unet_name": H3_UNET, "weight_dtype": "default"}},
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": H3_TE, "type": "minimax", "device": "default"}},
        "vvae": {"class_type": "VAELoader", "inputs": {"vae_name": H3_VIDEO_VAE}},
        "avae": {"class_type": "VAELoader", "inputs": {"vae_name": H3_AUDIO_VAE}},
        "cond": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
            "clip": ["clip", 0], "vae": ["vvae", 0], "prompt": prompt,
            "width": width, "height": height, "length": length}},
        "guider": {"class_type": "BasicGuider",
                   "inputs": {"model": ["unet", 0], "conditioning": ["cond", 0]}},
        "sched": {"class_type": "BasicScheduler",
                  "inputs": {"model": ["unet", 0], "scheduler": "simple",
                             "steps": steps, "denoise": 1.0}},
        "smp": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "noise": {"class_type": "RandomNoise", "inputs": {"noise_seed": s}},
        "ks": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["noise", 0], "guider": ["guider", 0], "sampler": ["smp", 0],
            "sigmas": ["sched", 0], "latent_image": ["cond", 1]}},
        "vdec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vvae", 0]}},
        "adec": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["ks", 0], "vae": ["avae", 0]}},
        "vid": {"class_type": "CreateVideo",
                "inputs": {"images": ["vdec", 0], "fps": H3_FPS, "audio": ["adec", 0]}},
        "save": {"class_type": "SaveVideo",
                 "inputs": {"video": ["vid", 0], "filename_prefix": "video/kychapogas_h3",
                            "format": "auto", "codec": "auto"}},
    }
    if first_image_name:
        wf["img_f"] = {"class_type": "LoadImage", "inputs": {"image": first_image_name}}
        wf["cond"]["inputs"]["first_frame"] = ["img_f", 0]
    if last_image_name:
        wf["img_l"] = {"class_type": "LoadImage", "inputs": {"image": last_image_name}}
        wf["cond"]["inputs"]["last_frame"] = ["img_l", 0]
    if preview_steps and 0 < preview_steps < steps:
        # Ref2VAと同一の予告編: シグマ列の先頭N段だけ走らせ、denoised_output(x0予測)から描く
        wf["split"] = {"class_type": "SplitSigmas",
                       "inputs": {"sigmas": ["sched", 0], "step": int(preview_steps)}}
        wf["ks"]["inputs"]["sigmas"] = ["split", 0]
        wf["vdec"]["inputs"]["samples"] = ["ks", 1]
        wf["adec"]["inputs"]["samples"] = ["ks", 1]
    if easycache:
        _h3_apply_easycache(wf)
    return wf


H3_REF_UNET = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"

# lightx2v蒸留のTurbo LoRA(Kijai再パック版 — プルーン版UNET向け)。
# fl2v蒸留だがRef2VA経路へ転移することを実測で確認済み(構図・キャラ・ポーズは一致)。
# 実測: 4step+LoRA=305秒 vs 通常8step=435秒(約30%短縮)。固定オーバーヘッド約175秒が下限。
# 代償: ①瓦礫等のテクスチャが平坦化する ②音声ブランチが崩壊する(RMS -20dB→-52dB、実質無音)
# 本アプリは生成音声を使わないため②は無害。①があるのでT1下見向け。
H3_TURBO_LORA = "minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy_resized_avg_rank_21_bf16.safetensors"
H3_TURBO_SAMPLER = "sa_solver"   # er_sde/sa_solverを実測比較し、錆色と暖色の保持が良い方を採用


def build_minimax_h3_ref_video(
    prompt: str,
    ref_image_names: list[str],           # ≤9(2048短辺へ自動縮小・拡大なし)
    ref_video_names: list[str] | None = None,   # ≤3 (ComfyUI input/の動画ファイル名)
    ref_audio_names: list[str] | None = None,   # ≤3 (同・音声)
    width: int = 1344,
    height: int = 768,
    length: int = 124,
    seed: int = -1,
    steps: int = 20,
    scheduler: str = "beta",              # 公式Tips: 参照過多時はbeta/normalがsimpleより安定
    ref_image_size: str = "match",        # match=速度優先 / max=同一性優先(2048短辺)
    easycache: bool = True,
    use_ref_video_audio: bool = False,    # 参照動画の音声を添付するか(既定OFF)
    turbo_lora: float | None = None,      # Turbo LoRA強度(0.75推奨)。指定時はサンプラーも切替
    preview_steps: int | None = None,     # 🎬予告編: stepsのスケジュールのうち先頭N段だけ実行
) -> dict:
    """MiniMax H3 Ref2VA: 参照(画像≤9/動画≤3/音声≤3)+指示文→映像+音声。

    preview_steps を指定すると「予告編」モードになる。steps段のシグマ列を作ってから
    SplitSigmasで先頭N段だけを取り出して走らせるため、res_multistep(決定論的)の性質により
    **完走時とまったく同じ軌道の途中経過**が得られる。ボケてはいるが構図・被写体の大きさ・
    配置は完成形と一致するので、シード選抜に使える。選んだシードを preview_steps なしで
    同条件で回せば、その予告編がそのまま仕上がる。
    (steps=5 と指定するのとは別物: あちらはシグマ列自体が変わり、別の軌道になる)
    """
    if not (ref_image_names or ref_video_names or ref_audio_names):
        raise ValueError("Ref2VAには参照が最低1つ必要です")
    s_ = _seed(seed)
    width = max(32, (width // 32) * 32)
    height = max(32, (height // 32) * 32)
    length = h3_snap_length(length)

    cond_inputs: dict[str, object] = {
        "clip": ["clip", 0], "vae": ["vvae", 0], "audio_vae": ["avae", 0],
        "prompt": prompt, "width": width, "height": height, "length": length,
        "ref_image_size": ref_image_size,
    }
    wf: dict[str, dict] = {
        "unet": {"class_type": "UNETLoader",
                 "inputs": {"unet_name": H3_REF_UNET, "weight_dtype": "default"}},
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": H3_TE, "type": "minimax", "device": "default"}},
        "vvae": {"class_type": "VAELoader", "inputs": {"vae_name": H3_VIDEO_VAE}},
        "avae": {"class_type": "VAELoader", "inputs": {"vae_name": H3_AUDIO_VAE}},
        "guider": {"class_type": "BasicGuider",
                   "inputs": {"model": ["unet", 0], "conditioning": ["cond", 0]}},
        "sched": {"class_type": "BasicScheduler",
                  "inputs": {"model": ["unet", 0], "scheduler": scheduler,
                             "steps": steps, "denoise": 1.0}},
        "smp": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "noise": {"class_type": "RandomNoise", "inputs": {"noise_seed": s_}},
        "ks": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["noise", 0], "guider": ["guider", 0], "sampler": ["smp", 0],
            "sigmas": ["sched", 0], "latent_image": ["cond", 1]}},
        "vdec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vvae", 0]}},
        "adec": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["ks", 0], "vae": ["avae", 0]}},
        "vid": {"class_type": "CreateVideo",
                "inputs": {"images": ["vdec", 0], "fps": H3_FPS, "audio": ["adec", 0]}},
        "save": {"class_type": "SaveVideo",
                 "inputs": {"video": ["vid", 0], "filename_prefix": "video/kychapogas_h3r",
                            "format": "auto", "codec": "auto"}},
    }
    for i, name in enumerate((ref_image_names or [])[:9]):
        wf[f"rimg{i}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
        cond_inputs[f"ref_images.ref_image_{i+1}"] = [f"rimg{i}", 0]
    for i, name in enumerate((ref_video_names or [])[:3]):
        wf[f"rvid{i}"] = {"class_type": "LoadVideo", "inputs": {"file": name}}
        wf[f"rvc{i}"] = {"class_type": "GetVideoComponents", "inputs": {"video": [f"rvid{i}", 0]}}
        cond_inputs[f"ref_videos.ref_video_{i+1}"] = [f"rvc{i}", 0]
        # 参照動画の音声は既定で添付しない: <Audio N>の番号がズレる上に
        # 元動画のセリフ/SFXが出力へ混入する(音声はテキストエンコーダにも入らず視覚的利得ゼロ)
        if use_ref_video_audio:
            cond_inputs[f"ref_video_audios.ref_video_audio_{i+1}"] = [f"rvc{i}", 1]
    for i, name in enumerate((ref_audio_names or [])[:3]):
        wf[f"raud{i}"] = {"class_type": "LoadAudio", "inputs": {"audio": name}}
        cond_inputs[f"ref_audios.ref_audio_{i+1}"] = [f"raud{i}", 0]
    wf["cond"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": cond_inputs}
    if preview_steps and 0 < preview_steps < steps:
        # 先頭 preview_steps 段のシグマだけを取り出す(high_sigmas=前半)。
        # ここで止めたラテントにはまだノイズが残るので、そのままデコードすると砂嵐になる。
        # SamplerCustomAdvanced の2つ目の出力 denoised_output(=x0予測)を使うと、
        # 「この軌道が行き着く先」の推定画が得られる — これが予告編の実体。
        wf["split"] = {"class_type": "SplitSigmas",
                       "inputs": {"sigmas": ["sched", 0], "step": int(preview_steps)}}
        wf["ks"]["inputs"]["sigmas"] = ["split", 0]
        wf["vdec"]["inputs"]["samples"] = ["ks", 1]
        wf["adec"]["inputs"]["samples"] = ["ks", 1]
    if turbo_lora:
        # UNETを直接参照している全ノード(guider/sched)をLoRA経由に付け替える。
        # EasyCache挿入より先に行うこと(挿入後はguiderのmodelがEasyCache出力を指すため)。
        wf["turbolora"] = {"class_type": "LoraLoaderModelOnly",
                           "inputs": {"lora_name": H3_TURBO_LORA,
                                      "strength_model": float(turbo_lora), "model": ["unet", 0]}}
        for nid, node in wf.items():
            if nid in ("unet", "turbolora"):
                continue
            m = node.get("inputs", {}).get("model")
            if isinstance(m, list) and m[0] == "unet":
                node["inputs"]["model"] = ["turbolora", 0]
        wf["smp"]["inputs"]["sampler_name"] = H3_TURBO_SAMPLER
    if easycache:
        _h3_apply_easycache(wf, src="turbolora" if turbo_lora else "unet")
    return wf
