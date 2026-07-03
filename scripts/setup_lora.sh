#!/usr/bin/env bash
# LoRA学習環境(kohya sd-scripts)のセットアップ — DGX Spark (aarch64/GB10, cu130) 対応
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRAINER="$ROOT/tools/lora-trainer"
mkdir -p "$TRAINER"
cd "$TRAINER"

if [ ! -d sd-scripts ]; then
  echo "[lora] kohya sd-scripts を取得しています..."
  git clone --depth 1 https://github.com/kohya-ss/sd-scripts.git
fi

if [ ! -d .venv ]; then
  echo "[lora] venv を作成しています..."
  python3 -m venv .venv
fi
source .venv/bin/activate
pip -q install --upgrade pip

echo "[lora] PyTorch (cu130 / aarch64) を導入しています..."
pip -q install torch torchvision --index-url https://download.pytorch.org/whl/cu130

echo "[lora] sd-scripts 依存を導入しています..."
# bitsandbytes は aarch64 で不安定なため除外(AdamW運用)。xformersも不要(sdpa使用)。
# requirements.txt 末尾の "-e ." は sd-scripts 自身の editable install なので cwd を合わせる。
cd sd-scripts
grep -vE "bitsandbytes|xformers" requirements.txt > /tmp/lora_req.txt
pip -q install -r /tmp/lora_req.txt
cd ..
pip -q install onnxruntime huggingface_hub   # WD14タガー用(prepare.py)

python - <<'EOF'
import torch
print(f"[lora] OK: torch {torch.__version__} cuda={torch.cuda.is_available()}")
EOF
echo "[lora] セットアップ完了。使い方は tools/lora-kit/README.md"
