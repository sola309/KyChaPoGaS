#!/usr/bin/env bash
# First-time backend setup (Linux / macOS)
set -e
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
echo "Setup complete. Run: .venv/bin/uvicorn main:app --reload"
