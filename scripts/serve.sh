#!/usr/bin/env bash
# =============================================================================
# KyChaPoGaS — 常駐ランチャー (daemonized, single-port)
# =============================================================================
# 端末/SSH/親プロセスの終了に依存せず動き続けるよう、各サービスを setsid で
# 新セッションにデタッチして起動します（init 直下で常駐）。
#
# 単一ポート配信: FastAPI(8002) がビルド済みフロントを配信。
# ホット反映:
#   - backend  : uvicorn --reload      → .py 変更で自動反映（再起動不要）
#   - frontend : vite build --watch    → 変更で dist 自動再ビルド（ブラウザ更新で反映）
#
# 使い方:
#   ./scripts/serve.sh start            # 全サービス起動（常駐）
#   ./scripts/serve.sh stop             # 全停止
#   ./scripts/serve.sh restart          # 再起動
#   ./scripts/serve.sh status           # 稼働確認
#   ./scripts/serve.sh start --core     # backend+frontend+terminal のみ（ComfyUI/音楽を除く）
#   ./scripts/serve.sh logs <name>      # ログ表示 (backend/frontend/terminal/comfyui/acestep)
#
# 共同編集の安全運用（埋め込みターミナル＝ホストのシェル対策）:
#   ./scripts/serve.sh restart --admin-ip=100.x.x.x   # そのIP(管理者の端末)だけターミナル可・招待者は不可
#   ./scripts/serve.sh restart --no-terminal          # ターミナルを全員に無効化
#   （詳細: docs/collaborator-invite-tailscale.md）
# =============================================================================

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/.run"; mkdir -p "$RUN"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'; BOLD='\033[1m'

CORE_ONLY=false
NO_TERMINAL=false
ADMIN_IP=""
for a in "$@"; do
  case "$a" in
    --core)         CORE_ONLY=true ;;
    # --no-terminal : 埋め込みターミナルを全員に対して無効化
    --no-terminal)  NO_TERMINAL=true ;;
    # --admin-ip=<TailscaleIP> : そのIP(=管理者の端末)からのみターミナル許可。招待者は不可
    --admin-ip=*)   ADMIN_IP="${a#--admin-ip=}" ;;
  esac
done

port_up() { ss -tln 2>/dev/null | grep -q ":$1[[:space:]]"; }

# spawn <name> <port> <workdir> <cmd...>
# Detaches into a new session so it survives this shell / the harness.
spawn() {
  local name=$1 port=$2 wd=$3; shift 3
  if [ "$port" != "-" ] && port_up "$port"; then
    echo -e "  ${YELLOW}[skip]${NC} $name (port $port は既に使用中)"
    return
  fi
  if [ ! -d "$wd" ]; then
    echo -e "  ${YELLOW}[skip]${NC} $name (ディレクトリ無し: $wd)"
    return
  fi
  setsid bash -c "cd '$wd' && exec \"\$@\"" _ "$@" >"$RUN/$name.log" 2>&1 < /dev/null &
  disown 2>/dev/null || true
  echo -e "  ${GREEN}[start]${NC} $name  → log: .run/$name.log"
}

start() {
  echo -e "${BOLD}KyChaPoGaS を起動しています (常駐)${NC}"

  local TERM_ENV=()
  if $NO_TERMINAL; then
    TERM_ENV=(env KYCHAPOGAS_DISABLE_TERMINAL=1)
    echo -e "  ${YELLOW}[安全]${NC} 埋め込みターミナル無効化 (--no-terminal): 全員シェル不可"
  elif [ -n "$ADMIN_IP" ]; then
    TERM_ENV=(env ADMIN_TERMINAL_IPS="$ADMIN_IP")
    echo -e "  ${YELLOW}[安全]${NC} ターミナルは管理者IP (${ADMIN_IP}) からのみ許可。招待者は不可"
  fi

  spawn backend 8002 "$ROOT/backend" \
    "${TERM_ENV[@]}" "$ROOT/backend/.venv/bin/uvicorn" main:app --host 0.0.0.0 --port 8002 \
    --reload --reload-dir "$ROOT/backend/app" --reload-dir "$ROOT/backend" \
    --timeout-graceful-shutdown 5

  # vite build --watch rebuilds dist/ on every change (FastAPI serves it live).
  # Use vite directly (no tsc gate) so a type error never halts hot rebuilds.
  spawn frontend - "$ROOT/frontend" \
    "$ROOT/frontend/node_modules/.bin/vite" build --watch

  if ! $NO_TERMINAL; then
    spawn terminal 8765 "$ROOT/terminal-server" \
      node server.js
  fi

  if ! $CORE_ONLY; then
    if [ -d "$ROOT/tools/comfyui/.venv" ]; then
      spawn comfyui 8188 "$ROOT/tools/comfyui" \
        "$ROOT/tools/comfyui/.venv/bin/python" main.py --listen 127.0.0.1 --port 8188
    fi
    if [ -d "$ROOT/tools/ace-step" ] && command -v uv >/dev/null 2>&1; then
      spawn acestep 7867 "$ROOT/tools/ace-step" \
        env OPENROUTER_PORT=7867 "$(command -v uv)" run acestep-openrouter --host 0.0.0.0 --port 7867
    fi
  fi

  echo ""
  echo -e "  起動処理を投入しました（モデルロード等で数十秒かかる場合があります）。"
  echo -e "  ${BOLD}アプリ: http://$( (tailscale ip -4 2>/dev/null | head -1) || echo localhost):8002/${NC}"
  echo -e "  状態確認: ./scripts/serve.sh status"
}

stop() {
  echo -e "${BOLD}KyChaPoGaS を停止しています${NC}"
  # Kill by port (reliable across detached sessions)
  for p in 8002 8765 8188 7867; do
    if port_up "$p"; then fuser -k "${p}/tcp" 2>/dev/null && echo -e "  ${RED}[stop]${NC} port $p"; fi
  done
  # vite build --watch has no port — kill by pattern
  pkill -f "$ROOT/frontend.*vite build" 2>/dev/null && echo -e "  ${RED}[stop]${NC} frontend (vite build --watch)" || true
  pkill -f "vite build --watch" 2>/dev/null || true
  sleep 1
  echo "  停止しました。"
}

status() {
  echo -e "${BOLD}KyChaPoGaS サービス状態${NC}"
  chk() { if port_up "$2"; then echo -e "  ${GREEN}●${NC} $1 (:$2)"; else echo -e "  ${RED}○${NC} $1 (:$2) 停止"; fi; }
  chk backend  8002
  chk terminal 8765
  chk comfyui  8188
  chk acestep  7867
  if pgrep -f "vite build --watch" >/dev/null 2>&1; then
    echo -e "  ${GREEN}●${NC} frontend (vite build --watch)"
  else
    echo -e "  ${RED}○${NC} frontend (vite build --watch) 停止"
  fi
  echo -e "  ${CYAN}health${NC}: $(curl -s -m3 http://localhost:8002/api/health 2>/dev/null || echo '応答なし')"
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  logs)    tail -n 80 -f "$RUN/${2:-backend}.log" ;;
  *)       echo "usage: $0 {start|stop|restart|status|logs <name>} [--core]" ;;
esac
