# KyChaPoGaS エージェント操作ガイド

MAD映像制作アプリをツール経由で操作するための手順書。対象: LLMエージェント(ローカル可)。

## 原則

1. 最初に `get_llm_state` で現状把握(タイムライン/アセット/解析/ジョブ/GPU)
2. 生成は全て非同期ジョブ: `create_generation_job` → 返った job_id を `get_job_status` でポーリング(重い動画系は数分〜)
3. job_type ごとのパラメータは `get_job_catalog` で確認(暗記不要)
4. 生成結果は result_asset_ids のアセットになる。`get_assets` で一覧
5. 破壊的操作(delete系)はユーザー確認なしに行わない

## 標準パイプライン

### P1: 素材づくり(画像)
```
generate_image {prompt(danbooruタグ), model: waiNSFWIllustrious_v170}
→ cutout {asset_id}   # キャラを透過PNG化
```

### P2: 3Dモデル化
```
generate_3d {mode: object, image_asset_id: <cutout結果>}       # キャラ・小物
generate_3d {mode: relief, image_asset_id: <背景一枚絵>}        # シーン起伏(3Dフォト)
# orbit を付けると透過webm(そのままタイムラインに置ける)も同時生成
```

### P3: 3Dカメラワーク動画(最重要・高精度)
「カメラは3Dで決め、絵はAIが描く」:
```
generate_video_3dcam {
  scene: {                        # 複数体の配置(単体なら model_asset_id でも可)
    objects: [
      {model_asset_id: 225, pos: [0,0,0],    rot: [0,15,0],  scale: 1.0},
      {model_asset_id: 300, pos: [0.9,0,-0.5], rot: [0,-30,0], scale: 0.85}
    ],
    camera: [                     # キーフレーム(at: 0..1)
      {at: 0, az: -0.5, el: 0.15, dist: 2.6, fov: 38, target: [0.4,0.5,0]},
      {at: 1, az: 0.55, el: 0.28, dist: 1.9, fov: 44, roll: 4,
       target: [0.45,0.55,-0.25], ease: "inOut"}
    ]
  },
  control_style: "depth",         # 幾何優先。線画寄りにしたい時は "edge"
  ref_image_asset_id: <キャラ原画>, # 画風・色はこれで決まる
  prompt: "anime style, ...",     # 内容説明(英語)
  length: 81                      # 4n+1。81=約5秒
}
```
座標系: 各オブジェクトは高さ1に正規化・足元がy=0。distはシーン半径の倍率。
azは方位角(ラジアン, 0=正面)、elは仰角。targetは注視点(シーン座標)。

### P4: 音楽
```
generate_audio {prompt: <英語caption>, lyrics: <構造タグ付き歌詞>, duration_sec, bpm, key}
# caption にBPM/キー/テンポ語を入れない。歌詞の()は背景コーラスとして歌われる
# 歌詞の譜割りは POST /api/music/lyrics/check (mora linter) で事前検査可能
```

### P5: タイムライン編集
```
analyze_audio {asset_id}          # まずBPM/ビート検出
add_track → add_clip → auto_cut_to_beats / scatter_beat_effects / set_transition
get_beat_match_score              # 音ハメ品質の確認
render_final                      # 書き出し
```

## MADビルダー(mad-kit)

shotlist.json で宣言的に組む別経路(API: /api/mad/*)。テンプレート17種+
`scene3d`(3Dモデル直載せ: objects/camera キーフレームは P3 と同形式)。
LLM編集は POST /api/mad/{pid}/instruct。

## 品質のコツ

- 3Dオブジェクト化は**切り抜き済み透過画像**から。背景付きだと形状が濁る
- Fun Control の ref_image は**構図が近い原画**ほどキャラ再現が良い
- 動画が破綻したら seed を変えて再投入(ガチャ)。vlm_review で自動チェック可
- 81フレーム超の長尺は分割生成してタイムラインで連結
- 生成中(especially heavy lane)にバックエンドを再起動しない

## 既知の挙動(3dcam)

- **背景ゴースト**: コントロール深度の背景が真っ黒(ジオメトリなし)だと、ref_imageが
  巨大な半透明像として背景に浮くことがある。対策: ①sceneにrelief GLBを背景として
  配置する ②negative_promptに "character in background, ghost image" ③ref画像は
  無地背景の切り抜きを使う
- 複数体シーンで同じGLBを使っても、深度は色を持たないためAIが各キャラを
  別解釈で描き分けることがある(promptで人数・髪色などを明示して制御)
