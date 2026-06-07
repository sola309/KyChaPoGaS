#!/usr/bin/env bash
# =============================================================================
# KyChaPoGaS — ACE-Step (音楽生成) セットアップ
# =============================================================================
# ACE-Step 1.5 は、ボーカル付きフルソングを生成できるオープンソース音楽基盤モデル。
# 本アプリからは独立サービス (REST API) として連携します。
#
# 実行内容:
#   1. uv (Python パッケージマネージャ) を確認 / 導入
#   2. ACE-Step 1.5 を tools/ace-step にクローン
#   3. uv sync で依存関係を構築 (aarch64/DGX Spark では cu130 torch を自動選択)
#
# モデル重みは初回起動時に HuggingFace から自動ダウンロードされます。
#
# 使い方:
#   ./scripts/setup_acestep.sh
# =============================================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'
info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC}   $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
step()    { echo -e "\n${BOLD}▶ $1${NC}"; }

ACESTEP_DIR="$ROOT_DIR/tools/ace-step"
ACESTEP_REPO="https://github.com/ace-step/ACE-Step-1.5.git"

# ── 1. uv ─────────────────────────────────────────────────────────────────────
step "ACE-Step (音楽生成) をセットアップしています"

if ! command -v uv &>/dev/null; then
  # ~/.local/bin / ~/.cargo/bin に入っている場合があるので PATH を補完
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi
if ! command -v uv &>/dev/null; then
  info "uv を導入中 (Python パッケージマネージャ)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi
if ! command -v uv &>/dev/null; then
  warn "uv が見つかりません。手動で導入してください: https://astral.sh/uv"
  exit 1
fi
success "uv $(uv --version 2>/dev/null | awk '{print $2}')"

# ── 2. クローン ───────────────────────────────────────────────────────────────
if [ -d "$ACESTEP_DIR/.git" ]; then
  info "ACE-Step は既に存在します。更新しています..."
  git -C "$ACESTEP_DIR" pull --ff-only 2>/dev/null || warn "git pull に失敗しました。手動で更新してください。"
else
  info "ACE-Step 1.5 をクローン中..."
  mkdir -p "$ROOT_DIR/tools"
  git clone --depth 1 "$ACESTEP_REPO" "$ACESTEP_DIR"
  success "ACE-Step クローン完了"
fi

# ── 3. 依存関係 ───────────────────────────────────────────────────────────────
info "依存関係を構築中 (uv sync)... 初回は数分かかります"
info "  aarch64/DGX Spark では CUDA 13 (cu130) の PyTorch が選択されます"
cd "$ACESTEP_DIR"
uv sync
cd "$ROOT_DIR"
success "ACE-Step 依存関係インストール完了"

echo ""
success "ACE-Step セットアップ完了 (モデルは初回起動時に自動DL)"
info "単体起動 (REST API): cd tools/ace-step && uv run acestep-api"
info "単体起動 (Web UI):   cd tools/ace-step && uv run acestep"
