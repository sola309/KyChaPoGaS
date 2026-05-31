# KyChaPoGaS MCP Server 設定手順

## MCP サーバーについて

`backend/mcp_server.py` を使うと、Claude Code から KyChaPoGaS の全ツール
（タイムライン操作・分析トリガー・AI生成ジョブ）を MCP ツールとして直接呼べます。

## 1. pip インストール

```powershell
cd backend
.\.venv\Scripts\pip install mcp
```

## 2. Claude Code の MCP 設定

プロジェクトルート（`p:/AniPAFE2026/`）に `.claude/settings.json` を作成し、以下を記入してください。

```json
{
  "mcpServers": {
    "kychapogas": {
      "command": "p:/AniPAFE2026/backend/.venv/Scripts/python.exe",
      "args": [
        "p:/AniPAFE2026/backend/mcp_server.py",
        "--project-id",
        "1"
      ],
      "env": {
        "PYTHONPATH": "p:/AniPAFE2026/backend"
      }
    }
  }
}
```

> `--project-id` は編集したいプロジェクトの ID に変更してください（デフォルト: 1）。

## 3. 確認

Claude Code を再起動し、チャットで以下のように入力すると MCP ツールが使えます。

```
kychapogas の get_llm_state でプロジェクトの状態を確認して
```

## 利用可能なツール一覧

| ツール名 | 説明 |
|---|---|
| `get_project_state` | タイムライン・クリップ一覧 |
| `get_llm_state` | 状態一括取得（タイムライン + 解析 + GPU + ジョブ） |
| `get_assets` | アセット一覧（タイプフィルタ可） |
| `get_analysis_summary` | BPM・シーン数・モーション強度サマリー |
| `add_track` | トラック追加 |
| `delete_track` | トラック削除 |
| `add_clip` | クリップ追加 |
| `move_clip` | クリップ移動 |
| `delete_clip` | クリップ削除 |
| `split_clip` | クリップ分割 |
| `create_generation_job` | AI生成ジョブ投入（画像/動画/音声） |
| `trigger_analysis` | 音声/映像分析開始 |

## HTTP API から使う場合

FastAPI が起動している状態であれば、以下の REST エンドポイントでも同等の操作ができます。

```
GET  http://localhost:8000/api/llm/state/{project_id}   # 一括状態取得
GET  http://localhost:8000/api/llm/tools                # ツール定義一覧
POST http://localhost:8000/api/llm/chat                 # チャット (Claude tool use)
```
