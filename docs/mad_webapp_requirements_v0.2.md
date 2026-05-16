# MAD動画制作Webアプリ 要件定義書 v0.2

> v0.1 → v0.2 変更点：
> - 8.13「AI映像理解エンジン」を新設
> - 8.14「再現動画制作支援」を新設
> - 19「最終的な目標像」にAI自動化ビジョンを追記
> - ソフトウェア名を **KyChaPoGaS**（キチャポガス）に決定

---

## ソフトウェア名

| 項目 | 内容 |
|------|------|
| **正式名称** | KyChaPoGaS |
| **読み方** | キチャポガス |
| **フルネーム（隠し）** | **Ky**oko **Cha**n [to] **Po**cky **Ga**me **S**hitai |
| **日本語原文** | 杏子ちゃんとポッキーゲームしたい |
| **元ネタキャラクター** | 佐倉杏子（魔法少女まどか☆マギカ） |
| **サブタイトル** | A MAD Video Creation Studio |

> "KyChaPoGaS" は頭字語として「杏子ちゃんとポッキーゲームしたい」を暗示しつつ、語呂よく呼べる造語。

---

## 1. 概要

本アプリは、MAD動画・AMV・音ハメ動画・キャラクターPV・モーショングラフィクス動画などを制作するためのローカルサーバー型Web動画制作アプリである。

一般公開型SaaSではなく、Tailscaleなどのプライベートネットワーク上で、Windowsサーバーまたは DGX Sparkを制作サーバーとして運用し、MacBookなどのクライアント端末からWebブラウザで操作することを想定する。

動画編集機能に加え、ComfyUIや各種画像生成・動画生成・アップスケール・背景除去・音声解析・レンダリングツールと連携し、将来的にはローカルLLMが動画制作・モーショングラフィクスを自然言語指示で操作できる構成を目指す。

本アプリの中核概念は、単なる動画編集ソフトではなく、以下を統合した「AI-Native Motion Timeline」である。

- タイムライン編集
- モーショングラフィクス制作
- AI生成素材管理
- ジョブキュー管理
- GPU/VRAM管理
- LLMによる編集操作
- 非破壊編集
- 生成履歴管理
- ローカル制作サーバー運用
- **AI映像理解・映像分析**
- **再現動画制作支援**

---

## 2. 目的

### 2.1 主目的

- Webブラウザから MAD動画制作を行える環境を構築する。
- 重い動画処理・AI生成処理・レンダリング処理はローカルサーバー側で実行する。
- MacBookなどのクライアント端末には重い処理を任せず、操作・プレビュー・管理に集中させる。
- ComfyUIを中心としたAI生成ツールと連携し、生成素材を動画制作に直接組み込めるようにする。
- 将来的にローカルLLMが、タイムライン編集・モーション付与・素材生成・レンダリングをAPI経由で操作できるようにする。
- **AI（ローカルLLMやClaudeなど）が映像を理解し、音ハメ・緩急・演出意図などを把握できる仕組みを持つ。**
- **将来的に動画制作の一部または全体をAIが自律的に実行できる環境を目指す。**

### 2.2 副目的

- After EffectsやAviUtl/AviUtl2のような操作感を参考にしつつ、AI生成時代に適した新しい動画制作概念を取り入れる。
- 生成AIで作成した画像・動画・音声・中間素材の履歴を管理し、再生成・修正を容易にする。
- VRAMの使用量を可視化・制御し、AI生成・レンダリングの失敗を減らす。
- 将来的に複数AIツール・複数CLIツール・複数レンダーエンジンへ拡張できる設計にする。
- **参照動画（元ネタ・参考作品）の演出・構成・タイミングを解析し、再現または応用制作を支援する。**

---

## 3. 想定利用環境

### 3.1 クライアント

- MacBook
- iPad
- iPhone
- Windows PC
- その他Webブラウザが利用できる端末

主な操作端末はMacBookを想定する。

### 3.2 サーバー

以下のいずれか1台をメイン制作サーバーとして運用する。

- Windowsサーバー
- DGX Sparkサーバー

初期段階では単一サーバー運用を前提とする。  
将来的には複数Worker化できる拡張余地を残す。

### 3.3 ネットワーク

- Tailscale経由でクライアントからサーバーへ接続する。
- 原則としてインターネットに一般公開しない。
- LANまたはTailscale内のプライベートWebアプリとして運用する。

---

## 4. 想定する動画制作対象

### 4.1 主対象

- MAD動画
- AMV
- 音ハメ動画
- キャラクターPV
- AI生成素材を使った短尺・中尺動画
- モーショングラフィクス動画
- 画像生成・動画生成を組み合わせた編集動画
- **参照映像の演出を再現・応用した再現動画**

### 4.2 動画長

- 基本想定は10分以内
- MVPでは1〜5分程度を主対象
- 将来的に10分程度まで安定して扱えることを目指す

### 4.3 出力解像度等

MVPでは以下を想定する。

- 1920x1080
- 30fps
- H.264 MP4

将来的には以下に対応する。

- 60fps
- 4K
- 縦動画
- 正方形動画
- WebM
- ProResなど中間形式

---

## 5. スコープ

### 5.1 初期スコープ

初期段階では以下を実装対象とする。

- Webブラウザによる操作UI
- プロジェクト作成・保存・読み込み
- 素材インポート
- 素材ライブラリ管理
- タイムライン編集
- 複数レイヤー
- クリップ配置・移動・分割・トリミング
- 音声波形表示
- 簡易プレビュー
- FFmpegによる最終レンダリング
- ComfyUI連携
- AI生成結果の素材ライブラリ登録
- ジョブキュー
- GPU/VRAM監視
- LLM操作を見越したCommand API設計
- 非破壊編集データ保存
- **映像分析の基盤設計（音ハメ・シーン分析・緩急分析の土台）**

### 5.2 初期スコープ外

以下は初期段階では必須としない。

- 完全なAfter Effects互換
- 完全なAviUtl互換
- ブラウザ単体での本格動画レンダリング
- 複数人同時共有編集
- YouTube/Niconico/Xへの直接投稿
- 著作権管理機能
- 公開サービス化
- スマホ向け完全編集UI
- 全AI動画生成ツールへの同時対応
- データベース型本格エディタの完全実装
- 高度な3D編集機能
- **完全自律AI動画制作（将来目標）**

---

## 6. 基本アーキテクチャ

### 6.1 全体構成

```text
Client Device
  └─ Web Browser
      ├─ Project UI
      ├─ Timeline UI
      ├─ Asset Library UI
      ├─ Preview Player
      ├─ AI Generation Panel
      ├─ Job Queue Panel
      ├─ GPU/VRAM Monitor
      ├─ LLM Chat Operation UI
      └─ Video Analysis Panel        ← NEW

Local Production Server
  ├─ Web App Server
  ├─ Project API
  ├─ Timeline Engine
  ├─ Command API
  ├─ Asset Manager
  ├─ Render Queue
  ├─ Job Scheduler
  ├─ GPU/VRAM Manager
  ├─ AI Tool Connector
  │    ├─ ComfyUI Connector
  │    ├─ Image Generation Connector
  │    ├─ Video Generation Connector
  │    ├─ Upscale Connector
  │    ├─ Background Removal Connector
  │    └─ External CLI Connector
  ├─ Motion Graphics Engine
  ├─ Video Analysis Engine            ← NEW
  │    ├─ Beat/Rhythm Analyzer
  │    ├─ Scene Change Detector
  │    ├─ Motion Intensity Analyzer
  │    ├─ Visual Appeal Scorer
  │    ├─ Pacing Analyzer
  │    └─ Reproduction Planner       ← NEW
  ├─ Render Engine
  │    ├─ FFmpeg
  │    ├─ Remotion
  │    ├─ Blender
  │    └─ Other CLI Tools
  └─ Storage
       ├─ projects
       ├─ assets
       ├─ generated
       ├─ cache
       ├─ proxies
       ├─ exports
       └─ analysis                   ← NEW
```

### 6.2 基本方針

- クライアントはUIと軽量プレビューに集中させる。
- 本格的な動画処理・AI生成・レンダリングはサーバー側で実行する。
- すべての編集操作はCommand APIを通じて実行する。
- 人間のUI操作とLLMの操作は同じCommand APIを利用する。
- AIツールは直接アプリ本体に組み込まず、Connector経由で扱う。
- レンダリングやAI生成はすべてJobとして扱い、キュー管理する。
- GPU/VRAMはJob Schedulerが管理する。
- **映像分析結果はAI・LLMが読み取れる構造化データとして保存する。**
- **映像理解データをCommand APIから取得できるようにし、LLMが映像制作判断に利用できる設計にする。**

---

## 7. 中核コンセプト

### 7.1 Human + LLM Shared Editing Model

人間がUIで行う操作も、LLMがAPI経由で行う操作も、同一の内部コマンドとして扱う。

例：

```json
{
  "command": "add_clip",
  "track_id": "video_01",
  "asset_id": "asset_001",
  "start_time": 12.5,
  "duration": 3.0
}
```

これにより以下を実現する。

- Undo/Redo
- 操作履歴管理
- LLMによる編集提案
- 編集プランの作成
- 自動編集
- 自然言語による再編集
- 操作再現性

### 7.2 AI Tool Connector

AIツールはアプリ本体から直接依存しない。  
共通インターフェースを通じて呼び出す。

対象例：

- ComfyUI
- 画像生成ツール
- 動画生成ツール
- アップスケーラー
- 背景除去ツール
- 音声解析ツール
- 外部CLI
- Pythonスクリプト
- 将来のローカルAIツール

### 7.3 Job-Based Processing

重い処理はすべてJobとして扱う。

Job例：

- render_preview
- render_final
- generate_image
- generate_video
- upscale_video
- remove_background
- extract_audio_waveform
- create_proxy
- analyze_beats
- transcode_asset
- analyze_video_scene        ← NEW
- analyze_video_pacing       ← NEW
- analyze_reproduction_plan  ← NEW

### 7.4 AI-Native Asset Management

AI生成素材は、単なるファイルではなく、生成条件・履歴・使用workflowを持つAssetとして管理する。

管理対象：

- 元素材
- 生成画像
- 生成動画
- プロンプト
- ネガティブプロンプト
- seed
- 使用モデル
- 使用LoRA
- ComfyUI workflow
- 生成日時
- 採用/没/候補ステータス
- タイムライン上での使用状況
- 再生成可否

### 7.5 AI映像理解モデル（NEW）

AIや LLMが映像の「意味」「演出」「魅力」を理解できるよう、映像分析データを構造化して管理する。

映像理解データの用途：

- LLMへのコンテキスト提供（「この映像の緩急はこうなっている」）
- 音ハメ位置の推定・提案
- カット割りの自動提案
- 再現動画制作の設計支援
- 将来的な完全自動編集への基盤

分析結果はすべてJobとして非同期実行し、結果をProject内に保存する。

---

## 8. 機能要件

## 8.1 プロジェクト管理

### 必須

- 新規プロジェクトを作成できる。
- プロジェクト名を設定できる。
- プロジェクトの保存先をサーバー上に作成できる。
- プロジェクトを開ける。
- プロジェクトを複製できる。
- プロジェクトの基本設定を保存できる。

基本設定：

- 解像度
- fps
- 音声サンプルレート
- 動画長
- 出力形式
- 作業用プロキシ設定
- レンダリング品質設定

### 将来対応

- プロジェクトテンプレート
- プロジェクトアーカイブ
- プロジェクト間素材共有
- Git風バージョン管理

---

## 8.2 素材管理

### 必須

以下の素材を登録できる。

- 動画
- 画像
- 音声
- AI生成画像
- AI生成動画
- 中間レンダー
- プロキシ動画
- キャッシュ

各素材には以下のメタデータを持たせる。

- asset_id
- ファイルパス
- ファイル種別
- 解像度
- 長さ
- fps
- コーデック
- 作成日時
- 登録日時
- 生成元情報
- タグ
- 使用状況
- サムネイル
- プレビュー用ファイル

### 必須操作

- 素材をアップロード/登録できる。
- 素材を一覧表示できる。
- 素材をプレビューできる。
- 素材にタグをつけられる。
- 素材をタイムラインに配置できる。
- 使用中素材と未使用素材を判別できる。
- キャッシュ削除対象を判別できる。

### 将来対応

- 類似素材検索
- 画像内容検索
- LLMによる素材説明生成
- 自動タグ付け
- 素材の「お気に入り」管理
- 没素材管理

---

## 8.3 タイムライン編集

### 必須

- 複数トラックを作成できる。
- 複数レイヤーを扱える。
- クリップをタイムラインに配置できる。
- クリップを移動できる。
- クリップを分割できる。
- クリップをトリミングできる。
- クリップを削除できる。
- クリップの表示順を変更できる。
- クリップの開始時間・終了時間・長さを数値指定できる。
- タイムラインをズームイン/ズームアウトできる。
- 再生ヘッドを移動できる。
- スナップ機能を利用できる。
- Undo/Redoができる。

### レイヤー方針

- 仕様上はレイヤー数を無制限に近い形で扱う。
- 実際のプレビューでは、処理負荷に応じて自動的にプロキシ化・キャッシュ化・プリレンダーを行う。
- 最終レンダー時にフル品質で合成する。

### 将来対応

- ネスト/プリコンポーズ
- タイムライン内タイムライン
- データベース型本格エディタ
- 複数タイムライン
- シーン管理

---

## 8.4 音声・音ハメ支援

### 必須

- 音声波形を表示できる。
- 音声クリップをタイムラインに配置できる。
- 音声と映像クリップを同期させるUIを提供する。
- マーカーを設置できる。
- フレーム単位または小数秒単位で位置調整できる。

### 将来対応

- BPM解析
- ビート検出
- 拍ごとの自動マーカー生成
- 音ハメ補助
- 音声ピークに合わせた自動カット
- 歌詞プロット解析
- 音声認識による字幕生成

---

## 8.5 プレビュー

### 必須

以下のプレビュー段階を持つ。

1. Draft Preview
   - 低解像度
   - 軽量
   - 即時確認用

2. Cached Preview
   - 重い区間を事前レンダー
   - 再生が安定化

3. Final Render Preview
   - 最終出力に近い確認

### 必須機能

- タイムラインの現在位置を再生できる。
- 指定範囲をプレビューできる。
- 低解像度プロキシを利用できる。
- 重いエフェクト区間をキャッシュできる。
- プレビュー生成をJobとして登録できる。

---

## 8.6 レンダリング

### 必須

- FFmpegを使って最終動画を書き出せる。
- MP4/H.264で書き出せる。
- 解像度・fps・ビットレートを指定できる。
- レンダリングをJobとしてキューに登録できる。
- 進捗を表示できる。
- 失敗時にエラーを表示できる。
- 失敗Jobを再実行できる。
- 書き出し済み動画をダウンロードまたはサーバー上で確認できる。

### 将来対応

- 4K書き出し
- 60fps書き出し
- ProResなど中間形式
- WebM
- 連番動画
- 分割レンダー
- レンダーキャッシュ再利用
- Remotionレンダー
- Blenderレンダー
- 外部CLIレンダー

---

## 8.7 モーショングラフィクス

### 基本方針

モーショングラフィクスは、完全自由編集だけでなく、テンプレート + パラメータ方式を重視する。

これにより、LLMが自然言語指示からモーションを適用しやすくする。

### 必須テンプレート候補

- punch_zoom
- camera_shake
- white_flash
- fade_in
- fade_out
- slide_in
- slide_out
- scale_bounce
- lyric_caption
- title_text
- speed_lines
- glitch
- manga_panel
- beat_sync_cut

### テンプレート例

```json
{
  "template": "punch_zoom",
  "target_clip_id": "clip_001",
  "start_time": 32.0,
  "duration": 0.4,
  "intensity": 0.8,
  "shake": 0.3,
  "flash": true
}
```

### 将来対応

- Remotion/Reactコンポーネントによる演出テンプレート
- カスタムテンプレート作成
- テンプレートのシェア化
- LLMによるモーション自動生成
- キーフレーム自動生成
- 図形アニメーション
- テキストアニメーション
- UI風演出
- レトロ画面風演出
- キャラクター紹介演出

---

## 8.8 キーフレーム

### 必須

以下のプロパティにキーフレームを設定できる。

- position_x
- position_y
- scale
- rotation
- opacity
- crop
- volume

### 将来対応

- easing
- bezier easing
- motion blur
- camera control
- 3D-like transform
- nested composition parameter
- expression-like control

---

## 8.9 AI生成連携

### 必須

ComfyUI連携を最初の主要AI連携対象とする。

必須機能：

- ComfyUI workflowを登録できる。
- workflowにパラメータを渡して実行できる。
- 生成Jobをキューに登録できる。
- 生成進捗を確認できる。
- 生成結果を自動で素材ライブラリに登録できる。
- 生成に使用したworkflow・prompt・seed・model・LoRAなどを保存できる。
- 生成失敗時のエラーを記録できる。
- 失敗Jobを再実行できる。

### AI Tool Connector共通インターフェース

```text
submit_job()
check_status()
cancel_job()
collect_outputs()
estimate_vram()
register_assets()
get_logs()
```

### 将来対応

- 複数ComfyUIインスタンス対応
- 動画生成CLI対応
- 画像生成CLI対応
- アップスケール専用ツール対応
- 背景除去ツール対応
- ControlNet系入力管理
- LoRA管理
- プロンプトテンプレート
- 生成結果比較UI
- 再生成ボタン
- 部分修正/inpaint
- image-to-video
- video-to-video
- frame interpolation

---

## 8.10 ジョブキュー

### 必須

すべての重い処理をJobとして管理する。

Jobの種類：

- generate_image
- generate_video
- upscale_image
- upscale_video
- remove_background
- render_preview
- render_final
- create_proxy
- transcode_asset
- analyze_audio
- extract_waveform
- cache_timeline_range
- analyze_video_scene        ← NEW
- analyze_video_pacing       ← NEW
- analyze_reproduction_plan  ← NEW

Jobステータス：

- pending
- running
- completed
- failed
- canceled
- paused

必須機能：

- Job一覧表示
- Job詳細表示
- Jobログ表示
- Job進捗表示
- Jobキャンセル
- Job再実行
- 優先度設定
- 実行中JobのGPU使用状況表示
- 失敗理由の表示

---

## 8.11 GPU/VRAM管理

### 必須

- GPUリストを取得できる。
- 各GPUのVRAM使用量を表示できる。
- 各GPUの使用率を表示できる。
- 実行中プロセスを表示できる。
- Jobごとに必要VRAM推定値を設定できる。
- 実行前に空きVRAMを確認する。
- VRAM不足を予測される場合はJobを待機させる。
- OOM発生時にJob失敗として記録する。
- Jobごとの最大VRAM使用量を記録する。
- 次回以降の推定VRAMに実測値を反映できる。

### VRAM管理方針

- VRAM使用量は完全には予測できないため、推定値 + 安全係数で管理する。
- 各Jobには推定VRAMを持たせる。
- Job Schedulerは空きVRAMと安全係数を見て実行可否を判断する。

例：

```json
{
  "job_type": "generate_video",
  "estimated_vram_gb": 18,
  "safety_factor": 1.3,
  "required_vram_gb": 23.4
}
```

### 将来対応

- GPU別Job割当
- ComfyUI専用GPU
- レンダー専用GPU
- 自動プロセス停止
- 優先度別スケジューリング
- 温度・電力監視
- 長時間Jobの一時停止
- 複数GPU分散

---

## 8.12 LLM操作対応

### 基本方針

将来的なローカルLLM対応を見越して、アプリの主要操作はすべて構造化APIとして提供する。

LLMがブラウザUIを直接操作するのではなく、Command API・OpenAPI・MCPなどを通じて編集操作を行う。

### 必須設計

- すべての編集操作をCommandとして表現する。
- Command履歴を保存する。
- LLMがプロジェクト状態を取得できるAPIを用意する。
- LLMが素材一覧を取得できるAPIを用意する。
- LLMがタイムライン状態を取得できるAPIを用意する。
- LLMがJob状況を取得できるAPIを用意する。
- LLMがGPU/VRAM状況を取得できるAPIを用意する。
- LLMがモーションテンプレート一覧を取得できるAPIを用意する。
- **LLMが映像分析結果を取得できるAPIを用意する。** ← NEW
- **LLMが音ハメ候補位置・緩急曲線・シーン分析を読み取れる設計にする。** ← NEW
- LLMが編集案をプランとして作成できる設計にする。

### LLM操作例

```json
{
  "command": "apply_motion_template",
  "template": "camera_shake",
  "target_clip_id": "clip_001",
  "start_time": 10.0,
  "duration": 0.5,
  "params": {
    "intensity": 0.7
  }
}
```

```json
{
  "command": "generate_video_from_image",
  "source_asset_id": "asset_001",
  "workflow_id": "comfy_i2v_001",
  "duration": 5.0,
  "params": {
    "motion_strength": 0.6,
    "seed": 12345
  }
}
```

```json
{
  "command": "get_video_analysis",
  "asset_id": "asset_001",
  "analysis_type": "beat_sync_points"
}
```

### LLM操作モード

1. 提案モード
   - LLMは編集案のみ作成する。
   - 実際のタイムラインには反映しない。

2. プレビュープランモード
   - LLMは別プランに編集を適用する。
   - ユーザーが確認できる。

3. 確定適用モード
   - ユーザー承認後にmain timelineへ反映する。

### LLMに許可する操作

- 素材一覧取得
- タイムライン読み取り
- クリップ追加
- クリップ移動
- クリップ分割
- クリップ削除
- エフェクト追加
- キーフレーム追加
- モーションテンプレート適用
- AI生成Job作成
- プレビューJob作成
- レンダーJob作成
- 編集プラン作成
- 編集プラン比較
- **映像分析Job作成** ← NEW
- **映像分析結果取得** ← NEW

### LLMに直接許可しない操作

- 任意シェルコマンド実行
- 生ファイル削除
- モデルファイル削除
- サーバー停止
- Tailscale設定変更
- 外部通信
- システム設定変更
- 未登録CLIの実行

---

## 8.13 AI映像理解エンジン（NEW）

### 概要

AIおよびLLM（ローカルLLM・Claude等）が映像の「内容」「演出」「魅力のポイント」を理解できるよう、映像分析データを構造化して保存・提供する機能。

この機能により、将来的にLLMが映像制作の意思決定を自律的に行える基盤を作る。

### 必須分析機能

#### 8.13.1 音ハメ分析（Beat Sync Analysis）

音楽と映像の同期ポイントを検出・提案する。

分析項目：
- BPM検出
- ビート位置（秒・フレーム単位）
- 強拍・弱拍の判定
- 音のピーク位置
- 推奨カット挿入位置
- 現在のタイムラインとのズレ評価

出力例：
```json
{
  "analysis_type": "beat_sync",
  "asset_id": "audio_001",
  "bpm": 128.0,
  "beats": [
    { "time": 0.469, "strength": "strong", "recommended_cut": true },
    { "time": 0.938, "strength": "weak",   "recommended_cut": false }
  ],
  "recommended_cut_points": [0.469, 1.406, 2.344]
}
```

#### 8.13.2 緩急分析（Pacing Analysis）

映像全体の緩急・テンポ・エネルギーカーブを分析する。

分析項目：
- カット頻度（単位時間あたりのカット数）
- 映像の動き量（モーション強度）
- 輝度変化量（フラッシュ・暗転検出）
- 音量エネルギー曲線
- 総合エネルギー曲線（緩急グラフ）
- 盛り上がり区間・落ち着き区間の推定
- 緩急バランス評価スコア

出力例：
```json
{
  "analysis_type": "pacing",
  "timeline_id": "timeline_main",
  "energy_curve": [
    { "time": 0.0,  "energy": 0.3, "category": "intro" },
    { "time": 10.0, "energy": 0.7, "category": "build" },
    { "time": 30.0, "energy": 1.0, "category": "climax" },
    { "time": 45.0, "energy": 0.4, "category": "calm" }
  ],
  "cut_density_per_10s": [2, 3, 8, 5, 2],
  "pacing_score": 0.78,
  "notes": "サビ前のビルドアップが急すぎる可能性があります"
}
```

#### 8.13.3 シーン分析（Scene Analysis）

映像の各シーンを自動検出・分類する。

分析項目：
- シーンチェンジ検出
- 各シーンの代表フレーム
- 各シーンの推定内容タグ（キャラクター・背景・アクション・テキスト等）
- カメラ動き推定（パン・ティルト・ズーム・固定）
- シーン内の動き量
- 顔検出・キャラクター推定（将来）

出力例：
```json
{
  "analysis_type": "scene",
  "asset_id": "video_001",
  "scenes": [
    {
      "scene_id": "scene_001",
      "start_time": 0.0,
      "end_time": 3.2,
      "thumbnail_path": "analysis/thumbs/scene_001.jpg",
      "tags": ["character", "closeup", "action"],
      "motion_intensity": 0.8,
      "camera_motion": "zoom_in"
    }
  ]
}
```

#### 8.13.4 映像魅力度分析（Visual Appeal Analysis）

映像クリップ・シーンの「MAD/AMV素材としての魅力度」を推定する。

分析項目：
- モーション強度スコア（動きが派手か）
- 構図スコア（フレーミングの良さ）
- 輝度・色彩スコア（映える色か）
- キャラクター存在確率
- エフェクト密度
- 総合魅力スコア

用途：
- 素材ライブラリでのソート・フィルタ
- LLMへの素材推薦根拠の提供
- 自動カット選択の支援

#### 8.13.5 LLM向け映像サマリー生成（Video Summary for LLM）

映像分析結果を自然言語サマリーに変換し、LLMが理解しやすい形式で提供する。

出力例：
```json
{
  "analysis_type": "llm_summary",
  "asset_id": "video_001",
  "summary": "3分12秒のアクションシーンを中心とした映像。BPM128の楽曲に合わせて30秒付近でクライマックスを迎える構成。カット頻度は平均8cut/10sで高テンポ。サビ区間（1:00〜1:30）では音ハメ密度が高く、その前後で緩急のコントラストが明確。",
  "key_moments": [
    { "time": 30.0, "description": "クライマックス開始、カット密度最大" },
    { "time": 60.0, "description": "サビ区間開始、音ハメ候補多数" }
  ],
  "recommended_actions": [
    "1:00〜1:30のビート位置にカット点を合わせることを推奨",
    "0:30付近にホワイトフラッシュを追加すると盛り上がりを強調できる"
  ]
}
```

### 分析Jobとしての実行

すべての分析は非同期Jobとして実行される。

```json
{
  "job_type": "analyze_video_scene",
  "asset_id": "video_001",
  "params": {
    "detect_scene_changes": true,
    "estimate_motion": true,
    "generate_thumbnails": true
  }
}
```

### 将来対応

- ローカルVLM（Vision Language Model）による映像内容説明
- キャラクター同定・追跡
- 感情曲線推定
- 視線誘導分析
- 字幕・テキスト認識
- 楽曲セクション自動分類（イントロ・Aメロ・サビ等）
- 複数動画の横断比較分析
- 制作スタイル分類（カオス系・綺麗系・エフェクト系など）

---

## 8.14 再現動画制作支援（NEW）

### 概要

既存の参照動画（お手本MAD・AMV・アニメシーン等）を解析し、そのカット割り・演出・タイミング・緩急を再現または応用した動画制作を支援する機能。

「あの動画のカット感を真似したい」「この演出構成を自分の素材で再現したい」というニーズに応える。

### 対象ユースケース

- 参考MADのカット割りパターンを自分の素材に当てはめる
- アニメシーンの動きのタイミングを再現した映像を作る
- 既存動画の緩急構成をテンプレートとして別の曲・素材に適用する
- 「このMADのような演出にしたい」と指示するとLLMが編集プランを作成する

### 必須機能

#### 8.14.1 参照動画登録

- 参照用動画をプロジェクトに登録できる。
- 参照動画は「制作対象外」としてライブラリ管理される。
- 参照動画は分析Jobのみ実行可能。

#### 8.14.2 参照動画分析

参照動画に対して以下の分析を実行できる。

- シーン分析（カット割りパターン抽出）
- 緩急分析（エネルギーカーブ抽出）
- 音ハメ分析（楽曲とのタイミング関係抽出）
- モーション分析（カメラ動き・エフェクトパターン抽出）

#### 8.14.3 再現プラン生成

参照動画の分析結果を元に、自分の素材を使った再現プランを生成できる。

出力例：
```json
{
  "plan_type": "reproduction",
  "reference_asset_id": "ref_video_001",
  "source_assets": ["asset_001", "asset_002", "asset_003"],
  "timeline_plan": [
    {
      "time": 0.0,
      "duration": 1.2,
      "suggested_asset": "asset_001",
      "reason": "参照動画のイントロに相当。固定ショット推奨。",
      "motion_template": null
    },
    {
      "time": 1.2,
      "duration": 0.4,
      "suggested_asset": "asset_002",
      "reason": "最初の強拍に合わせたクイックカット",
      "motion_template": "punch_zoom"
    }
  ],
  "notes": "参照動画はBPM138。素材の選定時は動きの激しいシーンをビート位置に当てることを推奨。"
}
```

#### 8.14.4 LLMによる再現指示対応

LLMに対して以下のような自然言語指示を送ると、再現プランを生成できる設計にする。

指示例：
- 「この参照動画のカット割りを使って、自分の素材で同じテンポの動画を作って」
- 「このシーンの緩急パターンを、別の楽曲に当てはめたプランを作って」
- 「参照動画の1分〜1分30秒の演出構成を抽出して」

### 将来対応

- 参照動画と制作中動画のタイムライン比較表示
- 再現度スコア（どれだけ参照に近いかの評価）
- スタイル転送（参照の演出スタイルだけ抽出して別素材に適用）
- 複数参照動画の混合プラン生成
- LLMによる自動タイムライン構築（ユーザー確認後適用）
- ローカルVLMを使った詳細なシーン内容マッチング

---

## 9. データ設計

## 9.1 Project

```json
{
  "project_id": "project_001",
  "name": "sample_mad_project",
  "created_at": "2026-01-01T00:00:00",
  "updated_at": "2026-01-01T00:00:00",
  "settings": {
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "sample_rate": 48000,
    "duration": 180,
    "default_export_format": "mp4"
  }
}
```

## 9.2 Asset

```json
{
  "asset_id": "asset_001",
  "type": "video",
  "path": "assets/video/source_001.mp4",
  "thumbnail_path": "assets/thumbs/source_001.jpg",
  "duration": 12.5,
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "codec": "h264",
  "tags": ["character", "source"],
  "created_by": "import",
  "generation_metadata": null,
  "analysis_ids": ["analysis_001", "analysis_002"]
}
```

## 9.3 AI Generated Asset

```json
{
  "asset_id": "asset_101",
  "type": "generated_video",
  "path": "generated/video/gen_101.mp4",
  "duration": 5.0,
  "width": 1280,
  "height": 720,
  "fps": 24,
  "created_by": "comfyui",
  "generation_metadata": {
    "workflow_id": "i2v_workflow_001",
    "prompt": "character running through bright city",
    "negative_prompt": "low quality, blurry",
    "seed": 12345,
    "model": "model_name",
    "loras": ["lora_001"],
    "source_assets": ["asset_001"],
    "job_id": "job_001"
  },
  "analysis_ids": []
}
```

## 9.4 Video Analysis Result（NEW）

```json
{
  "analysis_id": "analysis_001",
  "asset_id": "asset_001",
  "analysis_type": "beat_sync",
  "job_id": "job_analysis_001",
  "created_at": "2026-01-01T00:00:00",
  "result": {
    "bpm": 128.0,
    "beats": [
      { "time": 0.469, "strength": "strong", "recommended_cut": true }
    ],
    "recommended_cut_points": [0.469, 1.406, 2.344]
  }
}
```

## 9.5 Reproduction Plan（NEW）

```json
{
  "plan_id": "plan_001",
  "project_id": "project_001",
  "plan_type": "reproduction",
  "reference_asset_id": "ref_video_001",
  "created_at": "2026-01-01T00:00:00",
  "created_by": "llm",
  "status": "draft",
  "timeline_plan": [
    {
      "time": 0.0,
      "duration": 1.2,
      "suggested_asset_id": "asset_001",
      "reason": "イントロ区間、固定ショット推奨",
      "motion_template": null
    }
  ],
  "notes": "参照動画BPM138、音ハメ密度高"
}
```

## 9.6 Timeline

```json
{
  "timeline_id": "timeline_main",
  "duration": 180,
  "tracks": [
    {
      "track_id": "video_01",
      "type": "video",
      "clips": ["clip_001", "clip_002"]
    },
    {
      "track_id": "audio_01",
      "type": "audio",
      "clips": ["clip_003"]
    }
  ]
}
```

## 9.7 Clip

```json
{
  "clip_id": "clip_001",
  "asset_id": "asset_001",
  "track_id": "video_01",
  "start_time": 10.0,
  "duration": 3.5,
  "source_in": 1.0,
  "source_out": 4.5,
  "layer_index": 1,
  "enabled": true,
  "effects": ["effect_001"],
  "keyframes": ["keyframe_001"]
}
```

## 9.8 Effect

```json
{
  "effect_id": "effect_001",
  "type": "transform",
  "target_clip_id": "clip_001",
  "params": {
    "scale": 1.0,
    "rotation": 0,
    "opacity": 1.0,
    "position_x": 0,
    "position_y": 0
  }
}
```

## 9.9 Keyframe

```json
{
  "keyframe_id": "keyframe_001",
  "target_id": "clip_001",
  "property": "scale",
  "frames": [
    { "time": 0.0, "value": 1.0,  "easing": "linear" },
    { "time": 0.5, "value": 1.35, "easing": "easeOutBack" },
    { "time": 1.0, "value": 1.0,  "easing": "easeInOut" }
  ]
}
```

## 9.10 Job

```json
{
  "job_id": "job_001",
  "type": "generate_video",
  "status": "pending",
  "priority": 5,
  "created_at": "2026-01-01T00:00:00",
  "started_at": null,
  "completed_at": null,
  "estimated_vram_gb": 18,
  "required_vram_gb": 23.4,
  "assigned_gpu": null,
  "params": {
    "workflow_id": "i2v_workflow_001",
    "source_asset_id": "asset_001",
    "duration": 5.0
  },
  "outputs": []
}
```

---

## 10. API設計方針

### 10.1 基本方針

- REST APIを基本とする。
- リアルタイム進捗にはWebSocketを利用する。
- 将来的にOpenAPI定義を出力する。
- 将来的にMCP Serverとして LLM向けtoolsを公開する。
- すべての編集操作はCommand APIを通じる。

### 10.2 APIカテゴリ

```text
/projects
/assets
/timelines
/clips
/effects
/keyframes
/commands
/jobs
/gpu
/ai-tools
/render
/llm
/analysis        ← NEW
/reproduction    ← NEW
```

### 10.3 Command API例

```http
POST /commands
```

```json
{
  "project_id": "project_001",
  "command": "add_clip",
  "params": {
    "track_id": "video_01",
    "asset_id": "asset_001",
    "start_time": 12.5,
    "duration": 3.0
  }
}
```

### 10.4 Job API例

```http
POST /jobs
```

```json
{
  "project_id": "project_001",
  "type": "render_preview",
  "params": {
    "timeline_id": "timeline_main",
    "start_time": 10.0,
    "end_time": 20.0,
    "quality": "draft"
  }
}
```

### 10.5 Analysis API例（NEW）

```http
POST /analysis/jobs
```

```json
{
  "project_id": "project_001",
  "asset_id": "video_001",
  "analysis_types": ["beat_sync", "scene", "pacing", "llm_summary"]
}
```

```http
GET /analysis/{asset_id}/llm_summary
```

```json
{
  "summary": "3分12秒のアクションシーン中心の映像...",
  "key_moments": [...],
  "recommended_actions": [...]
}
```

---

## 11. UI要件

## 11.1 主要画面

### Project Dashboard

- プロジェクト一覧
- 新規作成
- 最近開いたプロジェクト
- サーバー状態
- GPU状態

### Editor

- タイムライン
- プレビュー
- 素材ライブラリ
- プロパティパネル
- エフェクトパネル
- AI生成パネル
- Jobキュー
- GPU/VRAM表示
- LLM操作チャット
- **映像分析パネル** ← NEW

### Asset Library

- 素材一覧
- サムネイル表示
- タグ検索
- 種類別フィルタ
- 使用中/未使用表示
- 生成履歴表示
- **魅力度スコア表示** ← NEW
- **分析結果表示** ← NEW

### AI Generation Panel

- workflow選択
- prompt入力
- negative prompt入力
- seed指定
- 入力素材指定
- 生成設定
- VRAM推定
- Job登録
- 生成結果表示

### Video Analysis Panel（NEW）

- 分析対象素材選択
- 分析種類選択（音ハメ・緩急・シーン・LLMサマリー）
- 分析Jobの実行・進捗表示
- 分析結果の可視化（エネルギーカーブ、ビート位置、シーン一覧）
- LLM向けサマリー表示
- タイムラインへの分析結果反映ボタン（推奨カット点をマーカーとして挿入など）

### Reproduction Panel（NEW）

- 参照動画の登録・選択
- 参照動画分析の実行
- 再現プランの生成（LLM連携）
- 生成プランのプレビュー
- プランをタイムラインに適用（ユーザー確認後）

### Job Queue Panel

- 実行待ち
- 実行中
- 完了
- 失敗
- キャンセル
- ログ表示
- 再実行

### GPU Monitor

- GPUリスト
- VRAM使用量
- 使用率
- 温度
- 実行中Job
- 実行中プロセス

---

## 12. 非機能要件

## 12.1 パフォーマンス

- 10分以内の動画プロジェクトを扱える。
- 1080p/30fpsの最終書き出しが安定して実行できる。
- プレビューはプロキシ・キャッシュを利用して軽量化する。
- 重い区間は自動的にプリレンダーできる。

## 12.2 信頼性

- Job失敗時に原因を記録する。
- 失敗Jobを再実行できる。
- プロジェクトデータは自動保存する。
- 操作履歴を保存する。
- レンダリング中にUIが重くてもJobは継続する。
- サーバー再起動後にJob状態を復元できることが望ましい。

## 12.3 拡張性

- AIツールはConnectorとして追加できる。
- レンダーエンジンは差し替え可能にする。
- 外部CLIを安全に登録できる。
- LLM操作APIを拡張できる。
- 将来的に複数Workerへ拡張できる。
- **映像分析エンジンは差し替え・追加可能にする。** ← NEW

## 12.4 セキュリティ

- 原則Tailscale内のみで利用する。
- 一般公開を前提としない。
- LLMに任意シェル実行権限を与えない。
- 登録済みツールのみ実行可能にする。
- path traversalを防止する。
- プロジェクトディレクトリ外のファイル操作を禁止する。
- 危険操作はユーザー確認を必要とする。

## 12.5 保守性

- Project・Asset・Timeline・Job・Command・Analysisを明確に分離する。
- API仕様をドキュメント化する。
- 各Connectorは独立モジュールとして管理する。
- ログを保存する。
- エラーをUIに表示する。

---

## 13. 技術選定候補

### 13.1 フロントエンド

候補：

- React
- TypeScript
- Vite
- Tailwind CSS
- Zustand または Redux
- Canvas/WebGL/WebGPU
- wavesurfer.jsなどの波形表示ライブラリ

### 13.2 バックエンド

候補：

- Python FastAPI
- Node.js
- SQLite
- PostgreSQL
- Redis
- Celery/RQ
- WebSocket

初期はPython FastAPI + SQLite + ローカルJob Queueでシンプルに始める。

### 13.3 レンダリング

候補：

- FFmpeg
- Remotion
- Blender
- 外部CLI

### 13.4 AI連携

候補：

- ComfyUI
- 画像生成CLI
- 動画生成CLI
- アップスケーラー
- 背景除去ツール
- ローカルLLM
- MCP Server

### 13.5 映像分析（NEW）

候補：

- librosa（音楽・BPM解析）
- PySceneDetect（シーン検出）
- OpenCV（映像処理・モーション解析）
- ffmpeg-python（フレーム抽出）
- ローカルVLM（映像内容説明）
- Whisper（音声認識・字幕生成）

### 13.6 GPU管理

候補：

- NVIDIA NVML
- nvidia-smi
- Pythonバインディング
- 独自GPU Scheduler

---

## 14. MVP要件

### 14.1 MVPの目的

最初のMVPでは、AI連携付きWebビデオ編集アプリとして最低限成立した状態を目指す。

### 14.2 MVP必須機能

- Tailscale内Webアクセス
- プロジェクト作成
- 素材登録
- 動画/画像/音声素材の一覧表示
- 素材プレビュー
- タイムライン配置
- 複数トラック
- クリップ移動
- クリップ分割
- クリップトリミング
- 音声波形表示
- Draft Preview
- FFmpegによるMP4書き出し
- ComfyUI workflow実行
- 生成結果の素材登録
- Jobキュー表示
- Job再実行
- GPU/VRAM表示
- Command履歴保存
- JSON形式でのプロジェクト保存
- **映像分析APIの基盤実装（BPM解析・シーン検出の土台）** ← NEW

### 14.3 MVPで後回しにする機能

- 高度なキーフレームエディタ
- 完全なモーショングラフィクスエディタ
- 複数Worker
- 4K
- 60fps
- 共有編集
- スマホ編集最適化
- MCP実装
- LLMによる完全自動編集
- ビートエディタ
- **完全な映像理解・再現動画自動生成** ← NEW（将来実装）

---

## 15. 将来拡張

### 15.1 LLM編集アシスタント

- 自然言語でタイムラインを編集
- 「このサビでズームインを入れて」などの指示に対応
- 自動音ハメ
- 自動に合わせ割り
- 自動エフェクト提案
- 編集プラン作成
- ユーザー承認後に反映

### 15.2 MCP対応

- 動画編集APIをMCP toolsとして公開
- ローカルLLMエージェントが操作可能にする
- Project状態取得
- Asset検索
- Timeline編集
- Job実行
- Render実行
- **映像分析結果取得** ← NEW

### 15.3 高度なAI連携

- image-to-video
- video-to-video
- character consistency workflow
- LoRA管理
- ControlNet管理
- pose control
- depth control
- inpainting
- outpainting
- frame interpolation
- lip sync
- motion transfer

### 15.4 高度なモーショングラフィクス

- Remotionコンポーネントテンプレート
- テキストアニメーション
- 図形アニメーション
- カメラ制御
- 3D風演出
- パーティクル
- グリッチ
- 漫画風演出
- レトロ画面風演出
- UI風演出

### 15.5 高度な映像理解（NEW）

- ローカルVLM（Vision Language Model）による映像内容記述
- キャラクター同定・追跡
- 感情曲線推定
- 視線誘導分析
- 字幕・テキスト認識
- 楽曲セクション自動分類
- 複数動画の横断比較
- 制作スタイル分類（カオス系・綺麗系・エフェクト系など）
- AI自律編集（ユーザー確認後適用）

### 15.6 高度な再現動画支援（NEW）

- 参照動画と制作中動画のタイムライン比較表示
- 再現度スコア評価
- スタイル転送（演出スタイルのみ抽出して別素材に適用）
- 複数参照動画の混合プラン
- LLMによる自動タイムライン構築
- ローカルVLMによるシーン内容マッチング

### 15.7 複数サーバー対応

- Windows Worker
- DGX Spark Worker
- ComfyUI専用Worker
- Render専用Worker
- GPUごとのJob割当
- Worker死活監視

---

## 16. 重要な設計判断

### 16.1 ブラウザ側本格レンダーは初期目標にしない

ブラウザはUIとプレビューを担当し、本格レンダーはサーバー側で行う。

### 16.2 ComfyUIは中核ではなくConnectorとして扱う

ComfyUIは重要な連携対象だが、アプリ本体の中核にはしない。  
将来的な別AIツール差し替えを考え、AI Tool Connectorの1実装として扱う。

### 16.3 LLMにはUIではなくAPIを操作させる

将来のローカルLLM対応では、ブラウザ画面を直接操作させるのではなく、Command API・OpenAPI・MCP経由で操作させる。

### 16.4 無限レイヤーは内部最適化で実現する

ユーザー体験としては多数レイヤーを扱えるようにしつつ、内部ではプロキシ・キャッシュ・プリレンダー・ネストを利用して負荷を制御する。

### 16.5 生成履歴を必ず残す

AI生成素材は、prompt・seed・model・workflow・入力素材・出力素材を紐づけて保存する。

### 16.6 映像理解データはLLMが読める構造化データとして管理する（NEW）

映像分析結果は人間向けUIだけでなく、LLMが直接読み取れる構造化JSON形式で保存・提供する。  
これにより将来のLLM自律編集の基盤とする。

### 16.7 再現動画は「スタイル転送」として設計する（NEW）

再現動画機能は、参照動画の素材をそのまま使うのではなく、「演出スタイル・タイミング構造」のみを抽出して自分の素材に適用するアプローチを基本とする。

---

## 17. 今後検討事項

- 最初のサーバーをWindowsにするかDGX Sparkにするか。
- バックエンドをPython中心にするかNode.js中心にするか。
- タイムラインUIライブラリを自作するか既存ライブラリを使うか。
- Remotionをどの段階で導入するか。
- ComfyUI workflowの管理をどこまでUI化するか。
- LLM操作をMVPに含めるか設計だけに留めるか。
- 素材保存形式をどこまで標準化するか。
- プレビュー生成をどのレンダーエンジンで行うか。
- モーショングラフィクスの初期テンプレート数。
- GPU Schedulerを自前で実装するか簡易版から始めるか。
- **映像分析ライブラリの選定（librosa・PySceneDetect・OpenCV）。** ← NEW
- **ローカルVLMをいつ導入するか。** ← NEW
- **再現動画機能のMVPスコープをどこまでにするか。** ← NEW

---

## 18. 初期開発フェーズ案

### Phase 1: 基盤

- FastAPIなどでバックエンド作成
- ReactでWeb UI作成
- プロジェクト作成
- 素材登録
- 素材一覧
- サーバー側ファイル管理
- SQLiteなどでメタデータ管理

### Phase 2: タイムライン

- タイムラインUI
- クリップ配置
- クリップ移動
- 分割
- トリミング
- 音声波形
- JSON保存

### Phase 3: レンダー

- FFmpeg連携
- Draft Preview
- Final Render
- Job Queue
- Jobログ
- 失敗時再実行

### Phase 4: AI連携

- ComfyUI Connector
- workflow登録
- prompt実行
- 生成結果取得
- Asset登録
- 生成履歴保存

### Phase 5: GPU管理

- VRAM表示
- GPU使用率表示
- Jobごとの推定VRAM
- VRAM不足時の待機
- 実測VRAM記録

### Phase 6: 映像分析基盤（NEW）

- BPM解析・ビート検出（librosa）
- シーンチェンジ検出（PySceneDetect）
- 緩急分析（モーション強度・カット密度）
- LLM向けサマリー生成
- 分析結果APIの整備
- タイムラインへの分析結果反映UI

### Phase 7: LLM拡張準備

- Command API整理
- OpenAPI出力
- LLM向け状態取得API
- 編集プラン
- MCP対応準備
- **映像分析結果のLLM向けAPI** ← NEW

---

## 19. 最終的な目標像

本アプリの最終的な目標は、ユーザーがWebブラウザ上でMAD動画制作を行いながら、AI生成・動画生成・モーショングラフィクス・レンダリング・素材管理を1つの制作環境内で扱えるようにすることである。

さらに将来的には、ローカルLLMに対して以下のような自然言語指示を行える状態を目指す。

- 「このサビに合わせて0.2秒単位でカットを入れて」
- 「このキャラ画像から5秒の動画を生成してタイムラインに置いて」
- 「AviUtlっぽいカメラ制御をこの区間に入れて」
- 「白フラッシュとズームインは合わせて出して」
- 「この区間だけもっとテンポアップして」
- 「没にある素材も含めて提案としてまとめて」
- 「GPUが空いている状況を見て、今実行できる生成だけ先にやって」

**加えて将来的には：**
- 「この参照MADのカット割りを、自分の素材で再現したプランを作って」
- 「この映像の音ハメが甘い部分を分析して修正案を出して」
- 「このシーンの緩急をもっとメリハリつけて」
- 「AIがこの動画の演出意図を理解した上で、似たスタイルの別曲バージョンを自動生成して」

これにより、従来の動画編集ソフトではなく、AIと人間が同じ制作プロジェクトを共有編集できる、ローカルAI時代の動画制作環境を実現する。
