#!/bin/bash
# usage: ef_c8_orient.sh <job> <tag> — C8 冒頭の向きを Codex で厳密判定(REF476/490 と 0f/14f)
cd /home/kigarashi309/workspace/projects/KyChaPoGaS/repo; J=$1; T=$2; E=outputs/kijun-ef/C6/eval
A=$(curl -s http://localhost:8002/api/jobs/$J | python3 -c "import sys,json;print((json.load(sys.stdin).get('result_asset_ids') or [0])[0])")
P=$(curl -s http://localhost:8002/api/assets/$A | python3 -c "import sys,json;print(json.load(sys.stdin)['file_path'])")
ffmpeg -v error -y -i "$P" -vf "select='eq(n,0)+eq(n,14)',scale=480:272,drawtext=text='$T %{n}':x=8:y=8:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.5,tile=2x1" -fps_mode passthrough -frames:v 1 $E/orient_${T}.jpg
ffmpeg -v error -y -i $E/orient_ref.jpg -i $E/orient_${T}.jpg -filter_complex "vstack=2" $E/orient_${T}_cmp.jpg
cat > $E/orient_${T}_brief.txt <<B
添付は 2 段 × 2 列。上段 = 元アニメ(REF 476f, 490f、真横のプロフィール)、下段 = 生成(0f, 14f)。
下段の人物の体(肩・胴)の向きを厳密に判定: 真横(両肩が奥行き方向に重なり肩幅が見えない)/斜め前(3/4)/正面。根拠(肩のライン・胸の見え方・腕)を一言。上段との角度差(正面側へ何度)。顔が見えるか。最後に「真横として合格/不合格」。画像は生成しない。日本語で簡潔に。
B
timeout 300 ~/.npm-global/bin/codex exec -m gpt-5.6-sol -c model_reasoning_effort=high --skip-git-repo-check --sandbox read-only -i $E/orient_${T}_cmp.jpg - < $E/orient_${T}_brief.txt 2>/dev/null | tail -6
