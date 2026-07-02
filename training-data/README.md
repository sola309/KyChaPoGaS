# TTS 追加学習データ（Git管理外）

このフォルダ（`training-data/`）は **`.gitignore` 済み**で、GitHubには上がりません。
Irodori-TTS の声の追加学習（LoRA / fine-tune）用の音声素材をここに置きます。

## 置き場所

```
training-data/
└─ irodori-tts/
   └─ <voice-name>/        例: kyoko
      ├─ audio/            学習用の音声クリップ（.wav）をここに
      │   ├─ 0001.wav
      │   ├─ 0002.wav
      │   └─ ...
      └─ metadata.csv      「ファイル名|読み上げテキスト」の対応表
```

`metadata.csv` の例（区切りは `|`）:
```
0001.wav|あたしは佐倉杏子。気軽に呼んでくれていい。
0002.wav|今日はいい天気だね。
```

## 推奨フォーマット（目安）

- **wav / 24kHz / モノラル / 16bit**（Irodori が扱いやすい形式）
- 1クリップ 2〜10 秒程度、無音や雑音は避ける
- 同一話者で、はっきり発話したものを数十〜数百クリップ
- 文字起こしは正確に（読み間違い・言い淀みは含めない）

> 学習スクリプトの正確な入力仕様は本家リポジトリ
> [Aratako/Irodori-TTS](https://github.com/Aratako/Irodori-TTS) の training/ を参照。
> 実際に追加学習を回す段階で、この metadata 形式を学習スクリプトに合わせて変換します。

## 実施済みの学習パイプライン（kyoko）

2026-06 に kyoko 声（51クリップ / 22050Hz / 計2.2分）で LoRA を学習済み。
**文字起こしは付属していなかったため自動生成**した。全工程は再実行可能：

```bash
VENV=tools/irodori-tts/.venv/bin/python           # 動作するtorch 2.10+cu130環境
IM=tools/irodori-tts/irodori-model                # 本家の学習コード
KY=training-data/irodori-tts/kyoko

# 1) 文字起こし（kotoba-whisper）→ dataset.jsonl / transcripts.csv
#    ※ transcripts.csv を見て固有名詞の誤りなどを手直しすると品質が上がる
$VENV training-data/transcribe.py --voice kyoko

# 2) DACVAE潜在＋manifest（datasets/torchcodecを使わずsoundfileでデコード）
$VENV training-data/build_manifest.py --voice kyoko

# 3) LoRA学習（51件向けに調整した設定。step800が最良 val だった）
BASE=$(ls ~/.cache/huggingface/hub/models--Aratako--Irodori-TTS-500M-v3/snapshots/*/model.safetensors|head -1)
$VENV $IM/train.py --config $KY/train_kyoko_lora.yaml \
  --manifest $KY/manifest.jsonl --init-checkpoint "$BASE" \
  --output-dir $KY/lora_out --device cuda

# 4) 最良チェックポイントを安定パスへ（バックエンドはここを参照）
cp -r $KY/lora_out/checkpoint_best_val_loss_* $KY/lora_best
```

**重要な注意**
- この環境の `torchcodec` は torch 2.10 と非互換（`torch_from_blob` undefined）。
  そのため文字起こし・潜在生成は torchcodec を避け、soundfile/librosa で直接デコードしている
  （本家の `prepare_manifest.py --dataset ...` はこの環境では音声デコードに失敗する）。
- 51件は LoRA としては**少なめ**。step800以降は過学習（val 0.888→0.948）。
  品質を上げたい場合は**クリップを増やす**（目安 10〜30分）と効果的。素材を `<voice>/audio/` に足して 1〜4 を再実行。

## バックエンド連携（自動でkyoko声にLoRA適用）

`backend/app/config.py` の `TTS_LORA_VOICE`（既定 `kyoko`）/ `TTS_LORA_ADAPTER`（既定 `…/kyoko/lora_best`）。
`backend/app/services/tts.py` が、リクエストの声が `TTS_LORA_VOICE` と一致したとき
`lora_adapter` を Irodori-TTS-Server に渡す（per-request 動的ロード）。
参照音声は `tools/irodori-tts/voices/kyoko.wav`（学習クリップから採用）。
→ コンパニオンの声は既定で kyoko（LoRA適用）になる。別の声を足すときは voices/ に wav を置き、
　別 LoRA を学習して設定で差し替える。

## 参考（推論用の参照音声は別）

「声を真似させる」だけの**参照音声**（ゼロショット・クローン用）は学習不要で、
`tools/irodori-tts/voices/<name>.wav` に置き、リクエストの `voice` に名前を渡します。
