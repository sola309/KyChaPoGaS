#!/usr/bin/env bash
# =============================================================================
# KyChaPoGaS — Wan2.2 動画モデル ダウンローダー (ComfyUI 用)
# =============================================================================
# DGX Spark / GB10 向けに、アニメ I2V（最初/最後フレーム指定）で使う Wan2.2 を取得。
#
#   (a) Wan2.2-Fun-InP A14B fp8   — first/last frame 専用モデル
#   (b) Wan2.2 native FLF2V (I2V-A14B fp8) — 公式 ComfyUI FLF2V ワークフロー用
#   + 共有: VAE / UMT5 テキストエンコーダ / Lightning 4-step LoRA (I2V-A14B)
#
# HuggingFace の hf CLI を使用（並列・レジューム対応）。約 90GB。
# 使い方: ./scripts/download_wan22.sh
# =============================================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'
info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC}   $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
step()    { echo -e "\n${BOLD}▶ $1${NC}"; }

COMFY_MODELS="$ROOT_DIR/tools/comfyui/models"
# ComfyUI の venv の Python を使う（huggingface_hub 導入済み）
PY="$ROOT_DIR/tools/comfyui/.venv/bin/python"

if [ ! -x "$PY" ]; then
  warn "ComfyUI venv が見つかりません。先に ./scripts/setup.sh を実行してください。"
  exit 1
fi
# huggingface_hub と高速転送を保証
"$PY" -m pip install --quiet --upgrade "huggingface_hub[hf_transfer]" >/dev/null 2>&1 || true
export HF_HUB_ENABLE_HF_TRANSFER=1

mkdir -p "$COMFY_MODELS/diffusion_models" "$COMFY_MODELS/vae" \
         "$COMFY_MODELS/text_encoders" "$COMFY_MODELS/loras/Wan2.2-Lightning"

REPACK="Comfy-Org/Wan_2.2_ComfyUI_Repackaged"

# hf_hub_download (安定 Python API) で単一ファイルを取得し、所定フォルダへ配置
# 引数: <repo> <repo内パス> <配置先ディレクトリ>
fetch() {
  local repo="$1" path="$2" destdir="$3"
  local fname; fname="$(basename "$path")"
  if [ -f "$destdir/$fname" ]; then
    success "既存スキップ: $fname"; return
  fi
  info "DL: $fname"
  local stage="$ROOT_DIR/tools/_hf_stage"
  local src
  src="$("$PY" - "$repo" "$path" "$stage" <<'PY'
import sys
from huggingface_hub import hf_hub_download
repo, path, stage = sys.argv[1], sys.argv[2], sys.argv[3]
# local_dir に実体ファイルとして取得（キャッシュのシンボリックリンクを避ける）
print(hf_hub_download(repo_id=repo, filename=path, local_dir=stage))
PY
)"
  mv -f "$src" "$destdir/$fname"
  success "配置完了: $destdir/$fname"
}

step "(b) Wan2.2 native FLF2V (I2V-A14B fp8) + 共有ファイル"
fetch "$REPACK" "split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors" "$COMFY_MODELS/diffusion_models"
fetch "$REPACK" "split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"  "$COMFY_MODELS/diffusion_models"
fetch "$REPACK" "split_files/vae/wan2.2_vae.safetensors"                                        "$COMFY_MODELS/vae"
fetch "$REPACK" "split_files/vae/wan_2.1_vae.safetensors"                                       "$COMFY_MODELS/vae"
fetch "$REPACK" "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"              "$COMFY_MODELS/text_encoders"

step "(a) Wan2.2-Fun-InP A14B fp8 (first/last frame 専用)"
fetch "$REPACK" "split_files/diffusion_models/wan2.2_fun_inpaint_high_noise_14B_fp8_scaled.safetensors" "$COMFY_MODELS/diffusion_models"
fetch "$REPACK" "split_files/diffusion_models/wan2.2_fun_inpaint_low_noise_14B_fp8_scaled.safetensors"  "$COMFY_MODELS/diffusion_models"

step "Lightning 4-step LoRA (I2V-A14B / 速度効率化)"
fetch "lightx2v/Wan2.2-Lightning" "Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/high_noise_model.safetensors" "$COMFY_MODELS/loras/Wan2.2-Lightning"
fetch "lightx2v/Wan2.2-Lightning" "Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/low_noise_model.safetensors"  "$COMFY_MODELS/loras/Wan2.2-Lightning"

# ステージング掃除
rm -rf "$ROOT_DIR/tools/_hf_stage"

echo ""
success "Wan2.2 モデルのダウンロード完了"
info "配置先: tools/comfyui/models/{diffusion_models,vae,text_encoders,loras}"
