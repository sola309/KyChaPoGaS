#!/usr/bin/env bash
# KyChaPoGaS dev server launcher (Linux / macOS)
# Usage: ./dev.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$SCRIPT_DIR/backend/.venv" ]; then
  echo "Running first-time setup..."
  bash "$SCRIPT_DIR/backend/setup.sh"
fi

echo "Backend  -> http://0.0.0.0:8000"
echo "Frontend -> http://localhost:5173"

trap 'kill %1 %2 2>/dev/null' EXIT

cd "$SCRIPT_DIR/backend"
.venv/bin/uvicorn main:app --reload --host 0.0.0.0 --port 8000 &

cd "$SCRIPT_DIR/frontend"
npm run dev &

wait
