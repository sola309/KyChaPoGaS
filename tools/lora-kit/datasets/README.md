# LoRAデータセット・スロット(廻天用に事前作成)

各フォルダの `raw/` に画像を置くだけで学習準備完了。`meta.json` にトリガーワードと基本タグが
設定済みなので、prepare.py は `--name` だけで動く:

```bash
PY=repo/tools/lora-trainer/.venv/bin/python
$PY repo/tools/lora-kit/prepare.py --name madoka_wr          # meta.jsonの設定を自動使用
$PY repo/tools/lora-kit/prepare.py --name shichouka --augment # 少数素材は水増し推奨
$PY repo/tools/lora-kit/train.py   --name madoka_wr
```

| スロット | トリガー | 用途 |
|---|---|---|
| madoka_wr | mdk_wr | 新衣装まどか |
| homura_wr | hmr_wr | 新魔法少女衣装ほむら |
| homura_devil | hmr_devil | 悪魔ほむら |
| sayaka_wr | syk_wr | 包帯さやか |
| mami_wr | mami_wr | 廻天マミ |
| kyoko_wr | kyk_wr | 廻天杏子(衣装差分) |
| shichouka | shchk | 新キャラ・紫丁香 |
| selma_therese | selma_t | 新キャラ・セルマ・テレーゼ |

## 素材集めのコツ(リサーチ準拠)

- **質>量**: ブレ/文字被り/小さすぎる切り抜きは除外。15〜30枚が理想、新キャラは5枚からでも可(--augment併用)
- **ソースを混ぜる**: PVスクショ+KV+(公開後)場面写真+ファンアート — 画風ではなく「同一性」を学習させる
- **新キャラ(タグ無し)**: 不変の特徴(髪色・目色など、全画像に共通するタグ)はprepare.pyが自動でキャプションから
  削除し、トリガーワードに吸収させる。少数素材では network dim を 8 に下げる(train.py --dim 8)
- 公開前はPV/KVのスクショで試作→公開後に高画質素材で再学習して差し替え
