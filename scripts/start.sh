#!/usr/bin/env bash
# =============================================================================
# KyChaPoGaS — 全サービス起動スクリプト (Linux / macOS)
# =============================================================================
# 使い方:
#   ./scripts/start.sh [--no-comfyui] [--no-frontend]
#
# 起動するサービス:
#   1. Backend   (FastAPI)      — http://localhost:8000
#   2. Frontend  (Vite dev)     — http://localhost:5173
#   3. Terminal  (node-pty WS)  — ws://localhost:8765
#   4. ComfyUI   (任意)         — http://localhost:8188
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC}   $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }

START_COMFYUI=true
START_FRONTEND=true

for arg in "$@"; do
  case $arg in
    --no-comfyui)  START_COMFYUI=false ;;
    --no-frontend) START_FRONTEND=false ;;
  esac
done

echo -e "${BOLD}KyChaPoGaS — Starting services${NC}"
echo ""

# ── Backend ───────────────────────────────────────────────────────────────────
info "Backend を起動しています (port 8000)..."
cd "$ROOT_DIR/backend"
if [ ! -d ".venv" ]; then
  echo "  → setup.sh を先に実行してください"
  exit 1
fi
source .venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!
deactivate
cd "$ROOT_DIR"
success "Backend PID=$BACKEND_PID"

# ── Terminal server ────────────────────────────────────────────────────────────
info "Terminal server を起動しています (port 8765)..."
cd "$ROOT_DIR/terminal-server"
node server.js &
TERMINAL_PID=$!
cd "$ROOT_DIR"
success "Terminal server PID=$TERMINAL_PID"

# ── ComfyUI (optional) ────────────────────────────────────────────────────────
COMFY_PID=""
if $START_COMFYUI; then
  COMFY_DIR="$ROOT_DIR/tools/comfyui"
  if [ -d "$COMFY_DIR/.venv" ]; then
    info "ComfyUI を起動しています (port 8188)..."
    cd "$COMFY_DIR"
    source .venv/bin/activate
    python main.py --listen 0.0.0.0 --port 8188 &
    COMFY_PID=$!
    deactivate
    cd "$ROOT_DIR"
    success "ComfyUI PID=$COMFY_PID"
  else
    warn "ComfyUI 未インストール (setup.sh を実行してください)"
  fi
fi

# ── Frontend ──────────────────────────────────────────────────────────────────
FRONTEND_PID=""
if $START_FRONTEND; then
  info "Frontend を起動しています (port 5173)..."
  cd "$ROOT_DIR/frontend"
  npm run dev &
  FRONTEND_PID=$!
  cd "$ROOT_DIR"
  success "Frontend PID=$FRONTEND_PID"
fi

# ── 待機 & クリーンアップ ─────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}全サービス起動完了${NC}"
echo ""
echo "  Backend:  http://localhost:8000"
[ -n "$FRONTEND_PID" ] && echo "  Frontend: http://localhost:5173"
echo "  Terminal: ws://localhost:8765"
[ -n "$COMFY_PID"    ] && echo "  ComfyUI:  http://localhost:8188"
echo ""
echo "  Ctrl+C で全サービスを停止します"
echo ""

trap 'echo ""; info "サービスを停止しています..."; kill $BACKEND_PID $TERMINAL_PID $FRONTEND_PID $COMFY_PID 2>/dev/null; exit 0' INT TERM

wait
