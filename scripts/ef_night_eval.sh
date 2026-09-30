#!/bin/bash
# usage: ef_night_eval.sh <job>...  → sheet + camera metrics, appends to outputs/kijun-ef/C36/night_results.md
cd "$(dirname "$0")/.."
REF=backend/data/assets/32/ref_C36_exact_2288_2397.mp4
for j in "$@"; do
  backend/.venv/bin/python scripts/ef_cmp_sheet.py $j >/dev/null 2>&1
  out=$(backend/.venv/bin/python scripts/ef_camera_diff.py $j --ref=$REF 2>&1 | tail -3)
  note=$(sqlite3 backend/data/kychapogas.db "select json_extract(params,'$.note') from job where id=$j")
  seed=$(sqlite3 backend/data/kychapogas.db "select json_extract(gen_params_json,'$.seed') from asset where file_path like '%h3r_$j.mp4' limit 1")
  printf '\n## job %s (seed %s)\n%s\n```\n%s\n```\n' "$j" "$seed" "$note" "$out" >> outputs/kijun-ef/C36/night_results.md
done
