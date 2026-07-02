# mad-kit の LLM操作・モバイル対応 設計メモ

目標: 「スマホから一言指示 → 軽量ローカルLLMがショットリストを編集 → サーバーでレンダー → スマホで確認」のループ。

## なぜ軽量LLMで通るのか(構成最適化の原則)

1. **編集面をJSONひとつに集約**: 作品 = shotlist.json。コード編集は不要。
   LLMがすべきことは「shotの追加/削除/params変更」だけ。
2. **語彙を列挙型に**: template名・enter名・ambient種・パターン名はすべて有限リスト
   (tools/mad-kit/README.md の表)。自由記述はテキスト内容と座標のみ。
3. **検証が教師になる**: `build.py check` は「unknown template 'X'. Use one of: ...」のように
   修正方法を含むエラーを返す → 小型モデルでもリトライで収束する。
4. **コンテキストを小さく**: LLMに渡すのは README(テンプレ表) + 対象shotのJSONのみ。
   全コード(~1500行)は見せない。

## Phase S0: タイムライン統合(2026-07-02 実装済み)

`tools/mad-kit/import_to_app.py` により、shotlist はアプリの**本物のプロジェクト**になる:

- プロジェクト(60fps/1920x1080) + 「MAD Shots」videoトラック + 「Music」audioトラック
- **1ショット = 1クリップ**。各クリップはショット単体プロキシ動画(640x360@30, offsetレンダー)を
  アセットとして持つ → 既存タイムラインUIでスクラブ/再生/ビートグリッド表示がそのまま効く
- `backend/data/mad/<project_id>.json` が clip_id ⇄ shot_id の対応表
  (UI上のクリップ選択から shotlist の該当エントリへ round-trip できる)

これで「タイムラインでコミュニケーションする」土台が完成:
**UIでクリップを選ぶ → 対応するshotが特定できる → 指示はそのshotのparams差分になる → 該当ショットだけ数十秒で再プロキシ → クリップの絵が更新される**(全体再レンダー不要)。

## Phase P1+P2: ショットエディタ + AI指示(2026-07-02 実装済み)

- **ショットエディタ**: mg_shotクリップをダブルクリック → mad-kitシーンを**ライブDOM**でiframe表示
  (フル解像度・rAF再生・ループ範囲つきトランスポート)。`mad-kit-live.js` がpostMessageブリッジ
  (seek/play/pause/pick/drag/shotlist差し替え)。オブジェクトはクリック選択(data-mkタグ)・
  ドラッグ移動(x/y書き戻し)。paramsの直接編集+ライブ反映も可
- **AI指示**: `POST /api/mad/{pid}/instruct` — 選択オブジェクトのパス+shot JSONをローカルLLMに渡し、
  検証(check)通過時のみ保存。エディタのチャット欄から利用
- **ショット単位再レンダー**: `mad_reproxy_shot` ジョブ(数十秒)がプロキシ動画を差し替え
- clipに `kind`('mg_shot')と `attrs_json`({shot_id})を追加(マイグレーション済み)

## Phase S1: バックエンドAPI(実装対象)

```text
GET  /api/mad/projects                     # shotlistを持つプロジェクト一覧
GET  /api/mad/{proj}/shotlist              # JSON取得
PUT  /api/mad/{proj}/shotlist              # 保存(保存前に check を実行、エラーは400で返す)
GET  /api/mad/templates                    # テンプレ表(READMEの機械可読版)
POST /api/mad/{proj}/render {quality: "qa"|"final"}   # Jobとして登録(既存job queue)
GET  /api/mad/{proj}/preview.mp4           # 最新レンダー結果
```

- render は既存の job_runner に `render_mad` ジョブとして載せる(進捗・失敗理由・再実行が既存UIで見える)

## Phase S2: MCPツール(mcp_server.py に追加)

小型LLM向けに「1指示=1ツール」の平坦なスキーマで:

```text
mad_list_templates()                      → テンプレ表
mad_get_shotlist(project)                 → 現在のshotlist
mad_update_shot(project, shot_id, patch)  → paramsを部分更新(check通過時のみ保存)
mad_add_shot(project, after_id, shot)     → shot挿入
mad_render(project, quality)              → レンダーjob起動、job_id返却
```

## Phase S3: モバイルUI(PWA内の新パネル「MAD Director」)

- ショットをカード一覧表示(サムネ+テンプレ名+尺)。タップで params フォーム
- 上部にチャット欄: ローカルLLM(Nemotron-nano)が上記MCPツールで編集を実行
- 「QAレンダー」ボタン → job進捗 → 完了したらインライン再生(既存のPWA+safe-area対応を流用)
- Tailscale経由 http://100.92.208.57:8002/ でそのまま動く(新規ポート不要)

## 実装順の提案

1. S1 API + render job 化(0.5日相当) — スマホのブラウザから叩けば即操作可能になる
2. S2 MCP化(0.5日) — チャット指示が通る
3. S3 専用UI(1-2日) — 体験の磨き込み
