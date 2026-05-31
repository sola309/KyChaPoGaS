#!/usr/bin/env bash
# =============================================================================
# KyChaPoGaS — MCP Server 起動スクリプト (Linux / macOS)
# =============================================================================
# 使い方:
#   ./scripts/start_mcp.sh [--project-id 1]
#
# Claude Code の MCP 設定例 (.claude/settings.json):
#   {
#     "mcpServers": {
#       "kychapogas": {
#         "command": "bash",
#         "args": ["p:/AniPAFE2026/scripts/start_mcp.sh", "--project-id", "1"]
#       }
#     }
#   }
# =============================================================================

set -euo pipefail

PROJECT_ID=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-id) PROJECT_ID="$2"; shift 2;;
    *) echo "Unknown argument: $1" >&2; exit 1;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$ROOT_DIR/backend"

VENV_PYTHON="$BACKEND_DIR/.venv/bin/python"
if [[ ! -f "$VENV_PYTHON" ]]; then
  echo "仮想環境が見つかりません: $VENV_PYTHON" >&2
  echo "先に ./scripts/setup.sh を実行してください。" >&2
  exit 1
fi

export PYTHONPATH="$BACKEND_DIR"
echo "KyChaPoGaS MCP Server 起動中 (project_id=$PROJECT_ID)..." >&2
exec "$VENV_PYTHON" "$BACKEND_DIR/mcp_server.py" --project-id "$PROJECT_ID"
