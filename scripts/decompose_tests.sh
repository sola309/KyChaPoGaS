#!/usr/bin/env bash
# Drive See-Through decompose → build_puppet → rig_compiler for each outfit test image.
# Sequential (decompose is GPU-bound). Logs per-step; continues on per-item failure.
set -u
REPO=/home/kigarashi309/workspace/projects/KyChaPoGaS/repo
SEE=$REPO/tools/see-through
PY=$SEE/.venv/bin/python
LOG=/tmp/kvtest/decompose.log
: > "$LOG"

declare -A NAMES=(
  [kyoko_school]="杏子A（制服・検証）"
  [kyoko_casual]="杏子B（カジュアル・検証）"
  [kyoko_sundress]="杏子C（サンドレス・検証）"
  [kyoko_coat]="杏子D（コート・検証）"
)
ORDER=(kyoko_school kyoko_casual kyoko_sundress kyoko_coat)

echo "BATCH START $(date +%H:%M:%S)" | tee -a "$LOG"
for stem in "${ORDER[@]}"; do
  img=/tmp/kvtest/$stem.png
  name=${NAMES[$stem]}
  echo "==== $stem ($name) start $(date +%H:%M:%S) ====" | tee -a "$LOG"
  if [ ! -f "$img" ]; then echo "  MISSING $img" | tee -a "$LOG"; continue; fi
  cp "$img" "$SEE/input/$stem.png"

  # 1) layer decomposition → PSD (GPU, ~6.6 min)
  if ! ( cd "$SEE" && "$PY" inference/scripts/inference_psd.py --srcp "input/$stem.png" --save_to_psd ) >>"$LOG" 2>&1; then
    echo "  FAIL inference_psd $stem" | tee -a "$LOG"; continue
  fi
  psd=$SEE/workspace/layerdiff_output/$stem.psd
  out=$SEE/workspace/layerdiff_output/$stem
  if [ ! -f "$psd" ]; then echo "  FAIL no psd $stem" | tee -a "$LOG"; continue; fi

  # 2) PSD → puppet manifest
  if ! ( cd "$SEE" && "$PY" "$REPO/scripts/build_puppet.py" "$out" "$psd" "$stem" "$name" ) >>"$LOG" 2>&1; then
    echo "  FAIL build_puppet $stem" | tee -a "$LOG"; continue
  fi

  # 3) Rig Compiler v2
  if ! ( cd "$REPO" && "$PY" "$REPO/scripts/rig_compiler.py" "$REPO/backend/data/puppets/$stem" ) >>"$LOG" 2>&1; then
    echo "  FAIL rig_compiler $stem" | tee -a "$LOG"; continue
  fi

  layers=$("$PY" -c "import json;print(len(json.load(open('$REPO/backend/data/puppets/$stem/manifest.json'))['layers']))" 2>/dev/null)
  echo "  OK $stem  layers=$layers  $(date +%H:%M:%S)" | tee -a "$LOG"
done

# keep recipe_kyoko as the stable default (newest among non-「旧」)
touch "$REPO/backend/data/puppets/recipe_kyoko/manifest.json"
echo "BATCH DONE $(date +%H:%M:%S)" | tee -a "$LOG"
