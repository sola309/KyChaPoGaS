#!/usr/bin/env bash
# Krea 2 LoRA 学習トラック: musubi-tuner セットアップ (aarch64 / GB10 / cu130)
# 使い方: bash scripts/setup_musubi.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MT="$REPO/tools/musubi-tuner"

[ -d "$MT" ] || git clone https://github.com/kohya-ss/musubi-tuner.git "$MT"

cd "$MT"
[ -d .venv ] || python3 -m venv .venv
# cu130 torch (sd-scripts と同じ構成; bitsandbytes は aarch64 非対応なので adamw を使う)
.venv/bin/pip install torch==2.12.1 torchvision --index-url https://download.pytorch.org/whl/cu130
.venv/bin/pip install -e .
.venv/bin/pip install accelerate
.venv/bin/python -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"

cat <<'EOF'

== 学習に必要な追加モデル(推論用fp8とは別。必要になったらDL) ==
  DiT RAW bf16 (24.5GB):
    curl -L -o tools/comfyui/models/diffusion_models/krea2_raw_bf16.safetensors \
      https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_raw_bf16.safetensors
  TE bf16 (8.3GB):
    curl -L -o tools/comfyui/models/text_encoders/qwen3vl_4b_bf16.safetensors \
      https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors
  VAE は推論用と共用 (models/vae/qwen_image_vae.safetensors)

== 学習手順の要点 (docs/krea2.md 準拠) ==
  1) krea2_cache_latents.py --dataset_config <toml> --vae <qwen_image_vae>
  2) krea2_cache_text_encoder_outputs.py --dataset_config <toml> --text_encoder <qwen3vl_4b_bf16>
  3) accelerate launch src/musubi_tuner/krea2_train_network.py \
       --dit <krea2_raw_bf16> --vae <qwen_image_vae> --dataset_config <toml> \
       --sdpa --mixed_precision bf16 \
       --timestep_sampling krea2_shift --weighting_scheme none \
       --optimizer_type adamw --learning_rate 1e-4 --gradient_checkpointing \
       --network_module networks.lora_krea2 --network_dim 32 --network_alpha 32 \
       --max_train_epochs 16 --save_every_n_epochs 1 --seed 42 \
       --output_dir <out> --output_name <name>
  ※ bitsandbytes(adamw8bit)は aarch64 で使えないため adamw を指定
  ※ dataset_config は lora-kit の datasets/<name>/img をそのまま toml で指せる
EOF
