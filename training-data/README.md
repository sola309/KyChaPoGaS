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

## 学習後

生成された **LoRA アダプタ**を `tools/irodori-tts/`（こちらもGit管理外）に置き、
TTSサーバへリクエスト時に指定すれば、その声で喋らせられます
（Irodori-TTS-Server は per-request の動的LoRAロードに対応）。

## 参考（推論用の参照音声は別）

「声を真似させる」だけの**参照音声**（ゼロショット・クローン用）は学習不要で、
`tools/irodori-tts/voices/<name>.wav` に置き、リクエストの `voice` に名前を渡します。
（現在は仮で `kyoko_ref.wav` を使用中）
