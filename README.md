# KyChaPoGaS

**A MAD Video Creation Studio**（キチャポガス）

ブラウザから操作する、ローカルサーバー型の AI 統合 MAD/AMV 動画制作スタジオです。
重い処理（AI 生成・映像分析・レンダリング）はサーバー側 GPU で実行し、クライアント
（MacBook 等）はブラウザで操作・プレビューに専念します。Tailscale などのプライベート
ネットワーク内での運用を想定しています。

> 詳細な要件定義は [docs/mad_webapp_requirements_v0.2.md](docs/mad_webapp_requirements_v0.2.md) を参照してください。

---

## ✨ 主な機能

- **タイムライン編集** — 複数トラック、クリップ配置・移動・分割・トリミング、音声波形表示
- **AI 生成連携** — ComfyUI 経由の画像生成 / image-to-video / 音声生成
- **映像分析** — BPM・ビート検出（音ハメ支援）、シーン検出、モーション強度解析
- **ジョブキュー** — 重い処理を非同期 Job として管理・進捗表示・再実行
- **GPU / VRAM 監視** — 実行前の空き VRAM チェックと Job ゲーティング（DGX Spark GB10 のユニファイドメモリにも対応）
- **LLM 操作** — Command API / MCP 経由で Claude などがタイムラインを操作（準備中）
- **組み込みターミナル** — ブラウザ内で PTY ターミナルを利用

---

## 🚀 クイックスタート（新規 PC / DGX Spark / Ubuntu）

GitHub から clone した直後の状態から、**3 ステップ**で起動できます。

```bash
# 1) 一括インストール（ffmpeg・Node.js・Python venv・npm パッケージ・ComfyUI まで）
./scripts/install.sh

# 2) API キーを設定（LLM チャットを使う場合）
nano backend/.env        # ANTHROPIC_API_KEY を記入

# 3) 全サービス起動
./scripts/start.sh
```

ブラウザで **http://localhost:5173** を開けば UI が表示されます。

> **まず軽く試したい場合**は ComfyUI（数 GB）を省略できます:
> ```bash
> ./scripts/install.sh --no-comfyui
> ./scripts/start.sh   --no-comfyui
> ```

### `install.sh` が行うこと

| 段階 | 内容 |
|------|------|
| システム依存 (apt) | `ffmpeg`, `git`, `curl`, `build-essential`, `python3-venv/-dev/-pip` |
| Node.js | 未導入 or v20 未満なら NodeSource から **Node.js 22 (LTS)** を導入 |
| アプリ依存 | `setup.sh` を呼び出し、下記をまとめて構成 |

`setup.sh` の内容: バックエンド Python venv + 依存、フロントエンド `npm install`、
ターミナルサーバー `npm install`、ComfyUI のクローン + venv、`backend/.env` の生成。

> `install.sh` は Ubuntu/Debian 系（apt）専用です。macOS など他環境では、
> Python 3.11+ / Node.js 20+ / ffmpeg / git を手動で入れてから `./scripts/setup.sh` を実行してください。

---

## 🧩 構成（アーキテクチャ）

```text
Client (ブラウザ)
  └─ Frontend (React + Vite)         :5173
        │  /api  → プロキシ →  Backend
        │  /ws/terminal → プロキシ →  Terminal server
        ▼
Local Production Server
  ├─ Backend  (FastAPI + SQLite)     :8002   REST API / Job Runner / GPU 監視
  ├─ Terminal (node-pty WebSocket)   :8765   組み込みターミナル
  └─ ComfyUI  (任意)                 :8188   AI 生成エンジン (Connector)
```

| サービス | ポート | 技術 |
|----------|--------|------|
| Frontend (Vite dev) | **5173** | React 19, TypeScript, Vite 8, Tailwind 4, Zustand |
| Backend (FastAPI) | **8002** | FastAPI, SQLModel/SQLite, librosa, PySceneDetect, nvidia-ml-py |
| Terminal server | **8765** | Node.js, node-pty, ws |
| ComfyUI | **8188** | （`tools/comfyui/` にクローン。AI画像/動画生成） |
| ACE-Step (音楽生成) | **7867** | （`tools/ace-step/` にクローン。ボーカル付き楽曲生成） |

> フロントの `/api` リクエストは Vite が **8002** のバックエンドへプロキシします
> （[frontend/vite.config.ts](frontend/vite.config.ts)）。バックエンドのポートを変える場合は
> vite.config.ts と起動スクリプトの両方を合わせてください。

---

## 📁 ディレクトリ構成

```text
repo/
  backend/            FastAPI バックエンド
    app/
      routers/        API エンドポイント (projects, assets, clips, jobs, generation, llm, analysis, system)
      services/       Job runner, ComfyUI 連携, FFmpeg レンダー, 音声/映像分析, GPU 監視
      models/         SQLModel データモデル
      db/             SQLite 初期化
    mcp_server.py     MCP サーバー (Claude Code 連携)
    requirements.txt
    .env.example      → コピーして .env を作成
  frontend/           React + Vite UI
    src/
      components/     Timeline, Preview, RightPanel, Terminal, etc.
      store/          Zustand ストア
      api/client.ts   API クライアント
  terminal-server/    node-pty WebSocket ターミナルサーバー
  scripts/            install.sh / setup.sh / start.sh / install_models.py（と .ps1 版）
  tools/              ComfyUI などの外部ツール置き場（git 管理外）
  docs/               要件定義・MCP 設定手順
```

---

## ⚙️ 設定

### `backend/.env`

`install.sh` / `setup.sh` 実行時に `.env.example` からコピーされます。主な項目:

| 変数 | 説明 | 既定値 |
|------|------|--------|
| `HOST` / `PORT` | バックエンドの待受 | `0.0.0.0` / `8002` |
| `ANTHROPIC_API_KEY` | LLM チャット（Claude）に必要 | （空） |
| `LLM_MODEL` | 使用モデル | `claude-sonnet-4-6` |
| `COMFYUI_URL` | ComfyUI のURL | `http://localhost:8188` |
| `CIVITAI_TOKEN` | Civitai モデルDLに必要なAPIトークン | （空） |
| `ACESTEP_API_URL` | 音楽生成(ACE-Step)サービスURL | `http://localhost:7867` |
| `TERMINAL_PORT` / `TERMINAL_HOST` | ターミナルサーバー | `8765` / `127.0.0.1` |

> **Civitai トークンの貼り方**: [civitai.com/user/account](https://civitai.com/user/account) → "API Keys" で発行し、
> `backend/.env` の `CIVITAI_TOKEN=` の後ろに貼り付けてください（`.env` は gitignore 済み）。
> `python scripts/install_models.py` が Civitai のダウンロードに自動で使います。

> `.env` は `.gitignore` 済みです。API キーは絶対にコミットしないでください。

### AI モデルのダウンロード（任意）

ComfyUI 用のモデル（画像/動画生成）は別途ダウンロードが必要です。

```bash
# scripts/models.local.json（gitignore）で使いたいモデルを enabled: true に編集してから
python scripts/install_models.py
```

- 定義例は [tools/models.example.json](tools/models.example.json) を参照。
- **Civitai** のモデル（例: WAI Illustrious SDXL v17.0）は `backend/.env` の `CIVITAI_TOKEN` が必要です。
- **Wan2.2 動画モデル**（Fun-InP / native FLF2V + Lightning LoRA、アニメI2V用・約90GB）は専用スクリプトで取得:
  ```bash
  ./scripts/download_wan22.sh
  ```
- **音楽生成 (ACE-Step)** のモデル重みは初回起動時に自動ダウンロードされるため、手動DLは不要です。

---

## 🖥️ 起動・停止

```bash
./scripts/start.sh                  # Backend + Frontend + Terminal (+ ComfyUI)
./scripts/start.sh --no-comfyui     # ComfyUI を起動しない
./scripts/start.sh --no-frontend    # フロントを起動しない（API のみ）
# Ctrl+C で全停止
```

開発中にバックエンドだけ手早く回したい場合は [dev.sh](dev.sh)（Backend + Frontend のみ）も使えます。

各サービスを個別に起動する場合:

```bash
# Backend
cd backend && .venv/bin/uvicorn main:app --reload --host 0.0.0.0 --port 8002
# Frontend
cd frontend && npm run dev
# Terminal server
cd terminal-server && node server.js
```

---

## 🤖 LLM / MCP 連携

Claude Code から KyChaPoGaS のツール（タイムライン操作・分析・AI 生成）を MCP 経由で
直接呼び出せます。設定手順は [docs/mcp_setup.md](docs/mcp_setup.md) を参照してください。

HTTP からも同等の操作が可能です:

```text
GET  http://localhost:8002/api/llm/state/{project_id}   # 状態一括取得
GET  http://localhost:8002/api/llm/tools                # ツール定義一覧
POST http://localhost:8002/api/llm/chat                 # チャット (Claude tool use)
```

---

## 🛠️ 開発フェーズ進捗

要件定義の「初期開発フェーズ案」に沿って実装が進んでいます（git log 準拠）。

- [x] Phase 1–2: 基盤（FastAPI / React）+ タイムライン
- [x] Phase 3: Job エンジン + FFmpeg レンダー
- [x] Phase 4: ComfyUI Connector + workflow builder
- [x] Phase 5: GPU/VRAM 監視 + Job VRAM ゲーティング
- [x] Phase 6: 映像分析基盤（BPM/beat, scene detect, motion intensity）
- [x] Phase 7: LLM 拡張準備 + MCP 対応
- [ ] 今後: LLM 自律編集 / 再現動画制作支援 / ローカル VLM

---

## 🧯 トラブルシュート

| 症状 | 対処 |
|------|------|
| `install.sh` が「apt 専用」と出て止まる | Ubuntu/Debian 以外の環境。手動で依存を入れて `setup.sh` を実行 |
| フロントは出るが API が 502 / 繋がらない | バックエンド（:8002）が起動しているか確認。ポートは vite.config.ts と一致が必要 |
| `setup.sh` が「node が見つかりません」 | 先に `./scripts/install.sh` を実行 |
| レンダリングが失敗する | `ffmpeg` が入っているか確認（`ffmpeg -version`） |
| GPU 情報が出ない | `nvidia-smi` が動くか確認。NVIDIA ドライバ + `nvidia-ml-py` が必要 |
| GPU の VRAM が 0 / 「Not Supported」 | DGX Spark (GB10) などユニファイドメモリ機では正常。VRAM 値はシステムRAM プール (`/proc/meminfo`) から取得し、UI に **UMA** バッジが付きます。OS 用予約は `UNIFIED_MEMORY_RESERVE_MB`（既定 4096）で調整可能 |
| ComfyUI 生成が動かない | `tools/comfyui/` のセットアップとモデルのダウンロードを確認 |

---

## 📝 ライセンス / 用途

`sola309` アカウントの私用開発プロジェクトです。一般公開 SaaS ではなく、
プライベートネットワーク内でのローカル運用を前提としています。
