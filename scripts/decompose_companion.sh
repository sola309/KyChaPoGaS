#!/usr/bin/env bash
# Decompose each generated pattern → puppet, TIMING every stage (inference_psd /
# build_puppet / rig_compiler) and the per-model total. Sequential (GPU-bound).
set -u
REPO=/home/kigarashi309/workspace/projects/KyChaPoGaS/repo
SEE=$REPO/tools/see-through
PY=$SEE/.venv/bin/python
LOG=/tmp/kvgen/decompose.log
TIMES=/tmp/kvgen/stage_times.csv
: > "$LOG"
echo "model,inference_psd_s,build_puppet_s,rig_compiler_s,total_s" > "$TIMES"

declare -A NAMES=(
  [kyoko_magical]="杏子N1（魔法少女・検証）"
  [kyoko_casual]="杏子N2（カジュアル・検証）"
  [kyoko_sailor]="杏子N3（セーラー・検証）"
  [kyoko_dress]="杏子N4（ワンピ・検証）"
)
ORDER=(kyoko_magical kyoko_casual kyoko_sailor kyoko_dress)

echo "BATCH START $(date +%H:%M:%S)" | tee -a "$LOG"
for stem in "${ORDER[@]}"; do
  img=/tmp/kvgen/$stem.png
  name=${NAMES[$stem]}
  echo "==== $stem ($name) start $(date +%H:%M:%S) ====" | tee -a "$LOG"
  [ -f "$img" ] || { echo "  MISSING $img" | tee -a "$LOG"; continue; }
  cp "$img" "$SEE/input/$stem.png"
  t_model0=$(date +%s.%N)

  t0=$(date +%s.%N)
  if ! ( cd "$SEE" && "$PY" inference/scripts/inference_psd.py --srcp "input/$stem.png" --save_to_psd ) >>"$LOG" 2>&1; then
    echo "  FAIL inference_psd" | tee -a "$LOG"; continue; fi
  t_inf=$(echo "$(date +%s.%N) - $t0" | bc)

  psd=$SEE/workspace/layerdiff_output/$stem.psd
  out=$SEE/workspace/layerdiff_output/$stem
  [ -f "$psd" ] || { echo "  FAIL no psd" | tee -a "$LOG"; continue; }

  t0=$(date +%s.%N)
  if ! ( cd "$SEE" && "$PY" "$REPO/scripts/build_puppet.py" "$out" "$psd" "$stem" "$name" ) >>"$LOG" 2>&1; then
    echo "  FAIL build_puppet" | tee -a "$LOG"; continue; fi
  t_build=$(echo "$(date +%s.%N) - $t0" | bc)

  t0=$(date +%s.%N)
  if ! ( cd "$REPO" && "$PY" "$REPO/scripts/rig_compiler.py" "$REPO/backend/data/puppets/$stem" ) >>"$LOG" 2>&1; then
    echo "  FAIL rig_compiler" | tee -a "$LOG"; continue; fi
  t_rig=$(echo "$(date +%s.%N) - $t0" | bc)

  t_total=$(echo "$(date +%s.%N) - $t_model0" | bc)
  layers=$("$PY" -c "import json;print(len(json.load(open('$REPO/backend/data/puppets/$stem/manifest.json'))['layers']))" 2>/dev/null)
  printf "%s,%.1f,%.1f,%.1f,%.1f\n" "$stem" "$t_inf" "$t_build" "$t_rig" "$t_total" >> "$TIMES"
  printf "  OK %s layers=%s  inference=%.1fs build=%.1fs rig=%.1fs TOTAL=%.1fs\n" \
    "$stem" "$layers" "$t_inf" "$t_build" "$t_rig" "$t_total" | tee -a "$LOG"
done

touch "$REPO/backend/data/puppets/recipe_kyoko/manifest.json"   # keep recipe_kyoko default
echo "BATCH DONE $(date +%H:%M:%S)" | tee -a "$LOG"
echo "=== stage_times.csv ===" | tee -a "$LOG"
cat "$TIMES" | tee -a "$LOG"
