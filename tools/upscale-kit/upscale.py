#!/usr/bin/env python3
"""最終アップスケーラー候補(ComfyUI 経由)。完成した H3 クリップを高解像度化する。
  h3up    : ComfyUI-H3-Video-Upsampler(H3 の潜在アップスケーラー + h3upscale x2 LoRA で 1 ステップ描き直し、denoise 0.1)
            元クリップを半分の大きさのガイドにして「元の細部を復元」する。素の H3 本体(ref2va bf16)に載せる(Turbo LoRA は重ねない)
  seedvr2 : SeedVR2 3B int8(1 ステップ、lab 色補正)。静かなアップ向き。動きの大きいカットは輪郭のゆらぎに注意
  esrgan  : Real-ESRGAN animevideov3(安定・忠実。比較の基準)
usage: upscale.py <h3up|seedvr2|esrgan> <in.mp4> <out.mp4> [--mp 2.0] [--denoise 0.1] [--mult 1.875] [--tile 70000]
GPU を使うので H3 生成ジョブと同時に流さない(ComfyUI のキューで直列にはなるが、メモリ競合を避ける)。"""
import argparse, glob, json, os, shutil, subprocess, sys, time, urllib.request, uuid
API = 'http://localhost:8188'
C = '/home/kigarashi309/workspace/projects/KyChaPoGaS/repo/tools/comfyui'
ap = argparse.ArgumentParser()
ap.add_argument('method', choices=['h3up', 'seedvr2', 'esrgan'])
ap.add_argument('src'); ap.add_argument('out')
ap.add_argument('--mp', type=float, default=2.0)
ap.add_argument('--denoise', type=float, default=0.1)
ap.add_argument('--mult', type=float, default=1.875)          # seedvr2/esrgan 前の倍率(1344→2520)
ap.add_argument('--tile', type=int, default=70000)
a = ap.parse_args()
name = f'up_{uuid.uuid4().hex[:8]}.mp4'
shutil.copy(a.src, f'{C}/input/{name}')
pref = f'upscale/{uuid.uuid4().hex[:8]}'
if a.method == 'h3up':
    g = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_ref2va_bf16.safetensors", "weight_dtype": "default"}},
         "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
         "3": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
         "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
         "5": {"class_type": "LoadVideo", "inputs": {"file": name}},
         "6": {"class_type": "GetVideoComponents", "inputs": {"video": ["5", 0]}},
         "7": {"class_type": "H3VideoUpsampler", "inputs": {"model": ["1", 0], "clip": ["2", 0], "vae": ["3", 0], "images": ["6", 0],
               "prompt": "h3upscale, increase resolution and restore fine details while preserving the original content and visual style.",
               "upscale_model": "minimax_h3_latent_upscaler_3d_bf16.safetensors", "megapixels": a.mp, "denoise": a.denoise,
               "lora": "h3upscale_v2_x2.safetensors", "lora_strength": 1.0, "tile_tokens": a.tile, "sampler_name": "euler"}},
         "8": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": pref}}}
elif a.method == 'seedvr2':
    g = {"1": {"class_type": "LoadVideo", "inputs": {"file": name}},
         "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
         "3": {"class_type": "ResizeImageMaskNode", "inputs": {"input": ["2", 0], "resize_type": "scale by multiplier", "resize_type.multiplier": a.mult, "scale_method": "lanczos"}},
         "4": {"class_type": "SeedVR2Preprocess", "inputs": {"resized_images": ["3", 0]}},
         "5": {"class_type": "VAELoader", "inputs": {"vae_name": "seedvr2_ema_vae_fp16.safetensors"}},
         "6": {"class_type": "UNETLoader", "inputs": {"unet_name": "seedvr2_3b_int8_convrot.safetensors", "weight_dtype": "default"}},
         "7": {"class_type": "VAEEncodeTiled", "inputs": {"pixels": ["4", 0], "vae": ["5", 0], "tile_size": 512, "overlap": 128, "temporal_size": 64, "temporal_overlap": 8}},
         "8": {"class_type": "SeedVR2Conditioning", "inputs": {"model": ["6", 0], "vae_conditioning": ["7", 0]}},
         "9": {"class_type": "KSampler", "inputs": {"model": ["6", 0], "positive": ["8", 0], "negative": ["8", 1], "latent_image": ["7", 0], "seed": 42, "steps": 1,
               "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1}},
         "10": {"class_type": "VAEDecodeTiled", "inputs": {"samples": ["9", 0], "vae": ["5", 0], "tile_size": 512, "overlap": 128, "temporal_size": 64, "temporal_overlap": 8}},
         "11": {"class_type": "SeedVR2PostProcessing", "inputs": {"images": ["10", 0], "original_resized_images": ["3", 0], "color_correction_method": "lab"}},
         "12": {"class_type": "SaveImage", "inputs": {"images": ["11", 0], "filename_prefix": pref}}}
else:
    g = {"1": {"class_type": "LoadVideo", "inputs": {"file": name}},
         "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
         "3": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": "realesr-animevideov3.pth"}},
         "4": {"class_type": "ImageUpscaleWithModel", "inputs": {"upscale_model": ["3", 0], "image": ["2", 0]}},
         "5": {"class_type": "SaveImage", "inputs": {"images": ["4", 0], "filename_prefix": pref}}}
r = urllib.request.Request(API + '/prompt', data=json.dumps({"prompt": g, "client_id": str(uuid.uuid4())}).encode(), headers={'Content-Type': 'application/json'})
try:
    pid = json.load(urllib.request.urlopen(r))['prompt_id']
except urllib.error.HTTPError as e:
    sys.exit('ERR ' + e.read()[:2000].decode())
t = time.time()
while True:
    h = json.load(urllib.request.urlopen(f'{API}/history/{pid}'))
    if pid in h:
        st = h[pid].get('status', {})
        if st.get('status_str') != 'success':
            os.remove(f'{C}/input/{name}'); sys.exit('FAILED ' + json.dumps(st)[:2000])
        break
    time.sleep(5)
fs = sorted(glob.glob(f'{C}/output/{pref}_*.png'))
subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-framerate', '24', '-pattern_type', 'glob', '-i', f'{C}/output/{pref}_*.png',
                '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-pix_fmt', 'yuv420p',
                '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', a.out], check=True)
for f in fs:
    os.remove(f)
os.remove(f'{C}/input/{name}')
print('done', a.method, a.out, len(fs), 'frames', round(time.time() - t), 's')
