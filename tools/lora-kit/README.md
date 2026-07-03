# lora-kit — キャラ/衣装LoRA学習システム

新衣装・新キャラ(例: 廻天の新衣装まどか/ほむら、紫丁香、セルマ)を画像生成で安定して出すための
LoRA学習パイプライン。DGX Spark(aarch64/GB10)で動作。

## パイプライン

```text
1. 素材収集   datasets/<name>/raw/ に画像を置く(15〜40枚目安)
2. タグ付け   prepare.py — WD14タガーで danbooruタグ自動付与 + トリガーワード挿入
3. 学習      train.py   — kohya sd-scripts (SDXL LoRA, Illustrious系向け既定値)
4. 検証      grid.py    — 強度スイープ(0.4〜1.0)のグリッド画像をComfyUIで生成
5. 配備      → tools/comfyui/models/loras/ へ。generation APIの loras パラメータで使用
```

## 使い方

```bash
PY=repo/tools/lora-trainer/.venv/bin/python   # install.sh lora で作成
# 1) datasets/<name>/raw/ に画像を置いてから:
$PY repo/tools/lora-kit/prepare.py --name madoka_wr --trigger "madoka_wr" \
    --base-tags "1girl, kaname madoka"
# 2) 学習(約20-60分/1200step @GB10)
$PY repo/tools/lora-kit/train.py --name madoka_wr
# 3) 検証グリッド
repo/backend/.venv/bin/python repo/tools/lora-kit/grid.py --lora madoka_wr \
    --prompt "1girl, kaname madoka, new magical girl outfit"
```

## 学習既定値(Illustrious系キャラ/衣装LoRA)

| 項目 | 値 | 根拠 |
|---|---|---|
| network dim / alpha | 16 / 8 | キャラ・衣装は16で十分。過学習を防ぐ |
| 学習率 | UNet 1e-4 / TE 5e-5 | SDXL標準ベースライン |
| optimizer | AdamW(+cosine) | bitsandbytes非依存(aarch64安全)。VRAM128GBで8bit不要 |
| resolution / bucket | 1024 + aspect bucket | |
| batch / steps | 2 / 1200〜1600 | 15-40枚データセット向け |
| キャプション | WD14タグ + 先頭トリガーワード | keep_tokens=1 |

## ベースモデル対応表(2026-07時点のリサーチ)

| モデル | 系統 | LoRA学習 | 所感 |
|---|---|---|---|
| **WAI-illustrious v17(現行)** | Illustrious/SDXL | ◎ kohya | 現行運用。キャラタグ知識が豊富 |
| **NoobAI-XL** | Illustrious派生 | ◎ kohya | 作風の幅・構図が改善。Illustrious LoRAと互換性高 |
| Animagine XL 4.0 | SDXL(独自再訓練) | ○ kohya | クリーンだがキャラタグ知識が薄い(LoRA前提) |
| FLUX.2 / Qwen-Image / Z-Image | 次世代 | △ ai-toolkit | 高品質だがアニメキャラ運用のエコシステムは未成熟。将来枠 |

新モデルの導線は `scripts/models.example.json` に追加済み(`install_models.py`でDL)。

## 廻天プロジェクトでの想定運用

- 公開前: PV/KVのスクリーンショットから新衣装データセットを作成(15枚程度から試行)
- 公開後: 円盤/配信画質で再学習して差し替え
- 命名: `<char>_wr`(例: madoka_wr, homura_wr_devil, shichouka)

## Krea 2 評価トラック(2026-07 追加)

- 推論: ComfyUI 0.27 ネイティブ対応。LoRA Lab のベースモデルで `krea2_turbo`(8step) / `krea2_raw`(28step) を選択。
  danbooruタグ非対応 — **自然文プロンプト**で書く。SDXL系LoRAは効かない(公式LoRA例: loras/krea2/)。
- 学習: musubi-tuner(`scripts/setup_musubi.sh` 参照)。networks.lora_krea2 / dim32 / krea2_shift。
  学習には raw **bf16**(24.5GB)+ TE bf16(8.3GB)が別途必要(スクリプト内にDLコマンド)。
- 位置づけ: 本命は Illustrious系(タグ制御・キャラ再現の実績)。Krea 2 は画質/自然文理解の評価枠。
