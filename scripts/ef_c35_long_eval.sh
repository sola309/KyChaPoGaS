#!/bin/bash
# usage: ef_c35_long_eval.sh <job>...  → metrics vs the 192f extended C35 reference (#4244)
cd "$(dirname "$0")/.."
REF=backend/data/assets/32/ref_C35_long_2135_2326.mp4
for j in "$@"; do
  G=$(sqlite3 backend/data/kychapogas.db "select file_path from asset where file_path like '%h3r_$j.mp4' limit 1")
  ffmpeg -v error -y -i $REF -i "$G" -filter_complex "[0:v]select='not(mod(n,24))',scale=336:192,tile=9x1[a];[1:v]select='not(mod(n,24))',scale=336:192,tile=9x1[b];[a][b]vstack" -frames:v 1 outputs/kijun-ef/C35/cmp_$j.jpg
  out=$(backend/.venv/bin/python scripts/ef_camera_diff.py $j --ref=$REF 2>/dev/null | tail -1)
  seed=$(sqlite3 backend/data/kychapogas.db "select json_extract(gen_params_json,'\$.seed') from asset where file_path like '%h3r_$j.mp4' limit 1")
  sl=$(backend/.venv/bin/python scripts/ef_time_align.py "$G" $REF 2>/dev/null | sed -E 's/.*slope=([0-9.]+).*/\1/')
  printf '%s (seed %s) speed=%s [long192]\n' "$out" "$seed" "$sl" | tee -a outputs/kijun-ef/C35/t1_results.md
done
