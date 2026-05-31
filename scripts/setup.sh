#!/usr/bin/env bash
# =============================================================================
# KyChaPoGaS — セットアップスクリプト (Linux / macOS)
# =============================================================================
# 使い方:
#   chmod +x scripts/setup.sh
#   ./scripts/setup.sh
#
# 実行内容:
#   1. 必須ツールの確認 (Python, Node.js, git, ffmpeg)
#   2. Python 仮想環境 + バックエンド依存関係インストール
#   3. フロントエンド npm install
#   4. ターミナルサーバー npm install
#   5. ComfyUI をクローン + 仮想環境構築
#   6. .env ファイルの生成 (未存在の場合)
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
error()   { echo -e "${RED}[ERR]${NC}  $1"; exit 1; }
step()    { echo -e "\n${BOLD}▶ $1${NC}"; }

echo -e "${BOLD}"
echo "  ██╗  ██╗██╗   ██╗ ██████╗██╗  ██╗ █████╗ ██████╗  ██████╗  ██████╗  █████╗ ███████╗"
echo "  ██║ ██╔╝╚██╗ ██╔╝██╔════╝██║  ██║██╔══██╗██╔══██╗██╔═══██╗██╔════╝ ██╔══██╗██╔════╝"
echo "  █████╔╝  ╚████╔╝ ██║     ███████║███████║██████╔╝██║   ██║██║  ███╗███████║███████╗"
echo "  ██╔═██╗   ╚██╔╝  ██║     ██╔══██║██╔══██║██╔═══╝ ██║   ██║██║   ██║██╔══██║╚════██║"
echo "  ██║  ██╗   ██║   ╚██████╗██║  ██║██║  ██║██║     ╚██████╔╝╚██████╔╝██║  ██║███████║"
echo "  ╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝      ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚══════╝"
echo -e "${NC}"
echo "  A MAD Video Creation Studio — Setup"
echo ""

# ── 1. 必須ツール確認 ──────────────────────────────────────────────────────────
step "必須ツールを確認しています"

check_cmd() {
  if command -v "$1" &>/dev/null; then
    success "$1 $(${2:-$1 --version 2>&1 | head -1})"
  else
    error "$1 が見つかりません。インストールしてください。"
  fi
}

check_cmd python3
PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
if python3 -c "import sys; exit(0 if sys.version_info >= (3,11) else 1)"; then
  success "Python $PY_VER"
else
  error "Python 3.11 以上が必要です (現在: $PY_VER)"
fi

check_cmd node
check_cmd npm
check_cmd git

if command -v ffmpeg &>/dev/null; then
  success "ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"
else
  warn "ffmpeg が見つかりません。レンダリング機能に必要です。後でインストールしてください。"
fi

# ── 2. バックエンド ────────────────────────────────────────────────────────────
step "バックエンド Python 環境をセットアップしています"

cd "$ROOT_DIR/backend"
if [ ! -d ".venv" ]; then
  info "仮想環境を作成中..."
  python3 -m venv .venv
fi
source .venv/bin/activate
info "依存関係をインストール中..."
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
success "バックエンド依存関係インストール完了"
deactivate
cd "$ROOT_DIR"

# ── 3. フロントエンド ──────────────────────────────────────────────────────────
step "フロントエンド npm パッケージをインストールしています"
cd "$ROOT_DIR/frontend"
npm install --silent
success "フロントエンド依存関係インストール完了"
cd "$ROOT_DIR"

# ── 4. ターミナルサーバー ──────────────────────────────────────────────────────
step "ターミナルサーバー npm パッケージをインストールしています"
cd "$ROOT_DIR/terminal-server"
npm install --silent
success "ターミナルサーバー依存関係インストール完了"
cd "$ROOT_DIR"

# ── 5. ComfyUI ────────────────────────────────────────────────────────────────
step "ComfyUI をセットアップしています"

COMFY_DIR="$ROOT_DIR/tools/comfyui"
COMFY_REPO="https://github.com/comfyanonymous/ComfyUI.git"
COMFY_TAG="latest"   # ピン止めしたい場合: "v0.3.43" など

if [ -d "$COMFY_DIR/.git" ]; then
  info "ComfyUI は既にインストール済みです。更新しています..."
  cd "$COMFY_DIR"
  git pull --ff-only 2>/dev/null || warn "git pull に失敗しました。手動で更新してください。"
  cd "$ROOT_DIR"
else
  info "ComfyUI をクローン中... (初回は数分かかります)"
  mkdir -p "$ROOT_DIR/tools"
  git clone --depth 1 "$COMFY_REPO" "$COMFY_DIR"
  success "ComfyUI クローン完了"
fi

# ComfyUI の Python 仮想環境
info "ComfyUI の Python 環境を構築中..."
cd "$COMFY_DIR"
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
success "ComfyUI 依存関係インストール完了"
deactivate
cd "$ROOT_DIR"

# ComfyUI のモデルディレクトリ作成
mkdir -p "$COMFY_DIR/models/checkpoints"
mkdir -p "$COMFY_DIR/models/loras"
mkdir -p "$COMFY_DIR/models/vae"
mkdir -p "$COMFY_DIR/models/video_models"
mkdir -p "$COMFY_DIR/models/clip"
mkdir -p "$COMFY_DIR/models/unet"
mkdir -p "$COMFY_DIR/input"
mkdir -p "$COMFY_DIR/output"
success "ComfyUI モデルディレクトリ作成完了"

# ── 6. .env ファイル ──────────────────────────────────────────────────────────
step ".env ファイルを確認しています"

ENV_FILE="$ROOT_DIR/backend/.env"
ENV_EXAMPLE="$ROOT_DIR/backend/.env.example"
if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  warn ".env を作成しました。ANTHROPIC_API_KEY などを設定してください: $ENV_FILE"
else
  success ".env は既に存在します"
fi

# ── models.local.json ────────────────────────────────────────────────────────
MODELS_LOCAL="$ROOT_DIR/scripts/models.local.json"
MODELS_EXAMPLE="$ROOT_DIR/tools/models.example.json"
if [ ! -f "$MODELS_LOCAL" ]; then
  cp "$MODELS_EXAMPLE" "$MODELS_LOCAL"
  info "models.local.json を作成しました。DLしたいモデルを enabled: true にしてください"
fi

# ── 完了 ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✓ セットアップ完了！${NC}"
echo ""
echo "  次のステップ:"
echo "  1. backend/.env を編集して ANTHROPIC_API_KEY を設定"
echo "  2. scripts/models.local.json で DL したいモデルを enabled: true に変更"
echo "  3. python scripts/install_models.py でモデルをダウンロード"
echo "  4. ./scripts/start.sh でサービスを起動"
echo ""
