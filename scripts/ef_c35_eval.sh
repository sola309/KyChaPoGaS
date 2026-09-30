#!/bin/bash
# usage: ef_c35_eval.sh <job>...  → sheet + camera metrics + speed vs C35 ref #4173
cd "$(dirname "$0")/.."
REF=backend/data/assets/32/ref_C35_exact_2135_2287.mp4
for j in "$@"; do
  backend/.venv/bin/python scripts/ef_cmp_sheet.py $j >/dev/null 2>&1
  out=$(backend/.venv/bin/python scripts/ef_camera_diff.py $j --ref=$REF 2>/dev/null | tail -1)
  seed=$(sqlite3 backend/data/kychapogas.db "select json_extract(gen_params_json,'\$.seed') from asset where file_path like '%h3r_$j.mp4' limit 1")
  G=$(sqlite3 backend/data/kychapogas.db "select file_path from asset where file_path like '%h3r_$j.mp4' limit 1")
  sl=$(backend/.venv/bin/python scripts/ef_time_align.py "$G" $REF 2>/dev/null | sed -E 's/.*slope=([0-9.]+).*/\1/')
  printf '%s (seed %s) speed=%s\n' "$out" "$seed" "$sl" | tee -a outputs/kijun-ef/C35/t1_results.md
done
