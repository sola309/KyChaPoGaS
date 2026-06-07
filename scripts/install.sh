#!/usr/bin/env bash
# =============================================================================
# KyChaPoGaS — ワンコマンド インストーラー (Linux / DGX Spark / Ubuntu)
# =============================================================================
# これは「最初に1回だけ」実行する一括インストーラーです。
# システムに必要なツール (ffmpeg, Node.js, Python venv 等) をまとめて導入し、
# 続けてアプリ依存 (Python/npm パッケージ, ComfyUI) のセットアップまで行います。
#
# 使い方:
#   chmod +x scripts/install.sh
#   ./scripts/install.sh                 # フル (ComfyUI 含む)
#   ./scripts/install.sh --no-comfyui    # ComfyUI を省略 (まず軽く試したい時)
#   ./scripts/install.sh --yes           # 確認プロンプトをスキップ (CI 等)
#
# 対応 OS:
#   - Ubuntu / Debian 系 (apt) … DGX Spark を含む。自動インストール対応。
#   - その他 (macOS 等)        … 手順を案内して終了します。
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

# 必要な Node.js のメジャーバージョン (Vite 8 が 20+ を要求)
NODE_MAJOR_REQUIRED=20
NODE_INSTALL_VERSION=22   # 導入する場合の NodeSource バージョン (LTS)

# ── オプション解析 ────────────────────────────────────────────────────────────
ASSUME_YES=false
SETUP_ARGS=()
for arg in "$@"; do
  case $arg in
    --no-comfyui) SETUP_ARGS+=("--no-comfyui") ;;
    --yes|-y)     ASSUME_YES=true ;;
    -h|--help)
      # 先頭のドキュメントブロック (set -e より前のコメント) のみ表示
      sed -n '2,/^set -e/p' "$0" | grep -E '^#' | sed -E 's/^# ?//'
      exit 0 ;;
    *) warn "不明なオプション: $arg (無視します)" ;;
  esac
done

echo -e "${BOLD}"
echo "  KyChaPoGaS — One-Command Installer"
echo -e "${NC}  A MAD Video Creation Studio\n"

# ── 0. OS 判定 ────────────────────────────────────────────────────────────────
step "実行環境を確認しています"
OS="$(uname -s)"
ARCH="$(uname -m)"
info "OS=$OS  ARCH=$ARCH"

if [ "$OS" != "Linux" ] || ! command -v apt-get &>/dev/null; then
  warn "このインストーラーは Ubuntu/Debian 系 (apt) 専用です。"
  echo ""
  echo "  お使いの環境では、以下を手動でインストールしてから"
  echo "  ./scripts/setup.sh を実行してください:"
  echo ""
  echo "    - Python 3.11+  (venv 付き)"
  echo "    - Node.js ${NODE_MAJOR_REQUIRED}+  と npm"
  echo "    - ffmpeg"
  echo "    - git"
  echo ""
  echo "  macOS (Homebrew) の例:"
  echo "    brew install python@3.12 node ffmpeg git"
  echo "    ./scripts/setup.sh"
  echo ""
  exit 1
fi

if . /etc/os-release 2>/dev/null; then
  info "ディストリビューション: ${PRETTY_NAME:-unknown}"
fi

# ── sudo の準備 ───────────────────────────────────────────────────────────────
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  if command -v sudo &>/dev/null; then
    SUDO="sudo"
    info "システムパッケージのインストールに sudo を使用します (パスワードを求められる場合があります)"
  else
    error "root でなく sudo も無いため、システムパッケージを導入できません。"
  fi
fi

# ── 確認プロンプト ────────────────────────────────────────────────────────────
if ! $ASSUME_YES; then
  echo ""
  echo "  以下を apt でインストール/確認します:"
  echo "    ffmpeg, git, curl, build-essential,"
  echo "    python3 / python3-venv / python3-dev / python3-pip,"
  echo "    Node.js ${NODE_INSTALL_VERSION}.x (未導入 or ${NODE_MAJOR_REQUIRED} 未満の場合)"
  echo ""
  read -r -p "  続行しますか? [Y/n] " reply
  case "$reply" in
    [nN]*) echo "中止しました。"; exit 0 ;;
  esac
fi

export DEBIAN_FRONTEND=noninteractive

# ── 1. APT パッケージ ─────────────────────────────────────────────────────────
step "システムパッケージを更新しています (apt update)"
$SUDO apt-get update -y
success "apt update 完了"

step "基本パッケージをインストールしています"
$SUDO apt-get install -y \
  ca-certificates curl git build-essential \
  python3 python3-venv python3-dev python3-pip \
  ffmpeg
success "基本パッケージ導入完了 (ffmpeg / python venv / build tools)"

# ── 2. Node.js ────────────────────────────────────────────────────────────────
step "Node.js を確認しています"
need_node_install=true
if command -v node &>/dev/null; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge "$NODE_MAJOR_REQUIRED" ]; then
    success "Node.js $(node --version) は要件 (>=${NODE_MAJOR_REQUIRED}) を満たしています"
    need_node_install=false
  else
    warn "Node.js $(node --version) は古いため ${NODE_INSTALL_VERSION}.x を導入します"
  fi
else
  info "Node.js 未インストール。${NODE_INSTALL_VERSION}.x を導入します"
fi

if $need_node_install; then
  info "NodeSource リポジトリを設定中 (setup_${NODE_INSTALL_VERSION}.x)..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_INSTALL_VERSION}.x" | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
  success "Node.js $(node --version) / npm $(npm --version) 導入完了"
fi

# ── 3. アプリ依存セットアップへ引き継ぎ ───────────────────────────────────────
step "アプリ依存のセットアップを開始します (setup.sh)"
info "Python venv / npm パッケージ / ComfyUI / .env を構成します"
echo ""
bash "$SCRIPT_DIR/setup.sh" "${SETUP_ARGS[@]}"

# ── 完了 ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✓ インストール完了！${NC}"
echo ""
echo "  起動方法:"
echo "    ./scripts/start.sh              # 全サービス起動"
echo "    ./scripts/start.sh --no-comfyui # ComfyUI 抜きで起動"
echo ""
echo "  ブラウザで http://localhost:5173 を開いてください。"
echo ""
