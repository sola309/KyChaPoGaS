#!/usr/bin/env bash
# =============================================================================
# KyChaPoGaS — 全サービス起動スクリプト (Linux / macOS)
# =============================================================================
# 使い方:
#   ./scripts/start.sh [--prod] [--no-comfyui] [--no-frontend] [--no-music]
#     --prod : フロントをビルドしてバックエンド(8002)から単一ポート配信（リモート推奨）
#
# 起動するサービス:
#   1. Backend   (FastAPI)      — http://localhost:8002
#   2. Frontend  (Vite dev)     — http://localhost:5173
#   3. Terminal  (node-pty WS)  — ws://localhost:8765
#   4. ComfyUI   (任意)         — http://localhost:8188
#   5. ACE-Step  (音楽生成/任意) — http://localhost:7867
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
START_MUSIC=true
PROD=false

for arg in "$@"; do
  case $arg in
    --no-comfyui)  START_COMFYUI=false ;;
    --no-frontend) START_FRONTEND=false ;;
    --no-music)    START_MUSIC=false ;;
    # Production mode: build the frontend and serve it from the backend on a
    # single port (8002). No Vite dev server, no --reload (avoids SSE-reload hang).
    # Recommended for remote (Tailscale) access — bundled UI loads fast.
    --prod)        PROD=true; START_FRONTEND=false ;;
  esac
done

echo -e "${BOLD}KyChaPoGaS — Starting services${NC}"
echo ""

# ── Frontend build (prod) ──────────────────────────────────────────────────────
if $PROD; then
  info "フロントエンドをビルドしています (本番配信用)..."
  cd "$ROOT_DIR/frontend"
  npm run build >/dev/null 2>&1 && success "フロントエンド ビルド完了" || warn "ビルドに失敗しました"
  cd "$ROOT_DIR"
fi

# ── Backend ───────────────────────────────────────────────────────────────────
info "Backend を起動しています (port 8002)..."
cd "$ROOT_DIR/backend"
if [ ! -d ".venv" ]; then
  echo "  → setup.sh を先に実行してください"
  exit 1
fi
source .venv/bin/activate
if $PROD; then
  uvicorn main:app --host 0.0.0.0 --port 8002 &
else
  uvicorn main:app --host 0.0.0.0 --port 8002 --reload &
fi
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

# ── ACE-Step 音楽生成 (optional) ──────────────────────────────────────────────
MUSIC_PID=""
if $START_MUSIC; then
  ACESTEP_DIR="$ROOT_DIR/tools/ace-step"
  if [ -d "$ACESTEP_DIR" ]; then
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
    if command -v uv &>/dev/null; then
      info "音楽生成 (ACE-Step OpenAI互換API) を起動しています (port 7867)..."
      cd "$ACESTEP_DIR"
      # OpenAI Chat-Completions 互換アダプタ。既定ポート 8002 は backend と衝突するため 7867 に。
      OPENROUTER_PORT=7867 uv run acestep-openrouter --host 0.0.0.0 --port 7867 &
      MUSIC_PID=$!
      cd "$ROOT_DIR"
      success "ACE-Step PID=$MUSIC_PID"
    else
      warn "uv が見つからないため ACE-Step を起動できません"
    fi
  else
    warn "ACE-Step 未インストール (./scripts/setup_acestep.sh を実行してください)"
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
if $PROD; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1)"
  echo -e "  ${BOLD}アプリ:   http://localhost:8002${NC}  (バンドル配信・単一ポート)"
  [ -n "$TS_IP" ] && echo -e "  ${BOLD}リモート: http://$TS_IP:8002${NC}  (Tailscale)"
else
  echo "  Backend:  http://localhost:8002"
  [ -n "$FRONTEND_PID" ] && echo "  Frontend: http://localhost:5173  (開発: Vite/HMR)"
fi
echo "  Terminal: ws://localhost:8765"
[ -n "$COMFY_PID"    ] && echo "  ComfyUI:  http://localhost:8188"
[ -n "$MUSIC_PID"    ] && echo "  Music:    http://localhost:7867 (ACE-Step)"
echo ""
echo "  Ctrl+C で全サービスを停止します"
echo ""

trap 'echo ""; info "サービスを停止しています..."; kill $BACKEND_PID $TERMINAL_PID $FRONTEND_PID $COMFY_PID $MUSIC_PID 2>/dev/null; exit 0' INT TERM

wait
