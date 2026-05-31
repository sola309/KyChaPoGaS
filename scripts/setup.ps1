# =============================================================================
# KyChaPoGaS — セットアップスクリプト (Windows PowerShell)
# =============================================================================
# 使い方 (管理者権限不要):
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned   # 初回のみ
#   .\scripts\setup.ps1
#
# 実行内容:
#   1. 必須ツールの確認 (Python, Node.js, git, ffmpeg)
#   2. Python 仮想環境 + バックエンド依存関係インストール
#   3. フロントエンド npm install
#   4. ターミナルサーバー npm install
#   5. ComfyUI をクローン + 仮想環境構築
#   6. .env ファイルの生成 (未存在の場合)
# =============================================================================

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
Set-Location $RootDir

function Info    { param($msg) Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Success { param($msg) Write-Host "[OK]   $msg" -ForegroundColor Green }
function Warn    { param($msg) Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Step    { param($msg) Write-Host "`n▶ $msg" -ForegroundColor White }
function Err     { param($msg) Write-Host "[ERR]  $msg" -ForegroundColor Red; exit 1 }

Write-Host @"

  KyChaPoGaS — A MAD Video Creation Studio
  Setup Script (Windows)

"@ -ForegroundColor Magenta

# ── 1. 必須ツール確認 ──────────────────────────────────────────────────────────
Step "必須ツールを確認しています"

function Check-Command {
    param($name, $minVersion = $null)
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) { Err "$name が見つかりません。インストールしてください。" }
    Success "$name が見つかりました: $($cmd.Source)"
}

Check-Command "python"
$pyVer = python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
$pyMaj, $pyMin = $pyVer.Split('.')
if ([int]$pyMaj -lt 3 -or ([int]$pyMaj -eq 3 -and [int]$pyMin -lt 11)) {
    Err "Python 3.11 以上が必要です (現在: $pyVer)"
}
Success "Python $pyVer"

Check-Command "node"
Check-Command "npm"
Check-Command "git"

if (Get-Command "ffmpeg" -ErrorAction SilentlyContinue) {
    Success "ffmpeg が見つかりました"
} else {
    Warn "ffmpeg が見つかりません。レンダリング機能に必要です。後でインストールしてください。"
    Warn "推奨: winget install ffmpeg"
}

# ── 2. バックエンド ────────────────────────────────────────────────────────────
Step "バックエンド Python 環境をセットアップしています"

$BackendDir = Join-Path $RootDir "backend"
Set-Location $BackendDir

if (-not (Test-Path ".venv")) {
    Info "仮想環境を作成中..."
    python -m venv .venv
}
Info "依存関係をインストール中..."
& ".venv\Scripts\pip.exe" install --quiet --upgrade pip
& ".venv\Scripts\pip.exe" install --quiet -r requirements.txt
Success "バックエンド依存関係インストール完了"
Set-Location $RootDir

# ── 3. フロントエンド ──────────────────────────────────────────────────────────
Step "フロントエンド npm パッケージをインストールしています"
Set-Location (Join-Path $RootDir "frontend")
npm install --silent
Success "フロントエンド依存関係インストール完了"
Set-Location $RootDir

# ── 4. ターミナルサーバー ──────────────────────────────────────────────────────
Step "ターミナルサーバー npm パッケージをインストールしています"
Set-Location (Join-Path $RootDir "terminal-server")
npm install --silent
Success "ターミナルサーバー依存関係インストール完了"
Set-Location $RootDir

# ── 5. ComfyUI ────────────────────────────────────────────────────────────────
Step "ComfyUI をセットアップしています"

$ComfyDir  = Join-Path $RootDir "tools\comfyui"
$ComfyRepo = "https://github.com/comfyanonymous/ComfyUI.git"

$ToolsDir = Join-Path $RootDir "tools"
if (-not (Test-Path $ToolsDir)) { New-Item -ItemType Directory -Path $ToolsDir | Out-Null }

if (Test-Path (Join-Path $ComfyDir ".git")) {
    Info "ComfyUI は既にインストール済みです。更新しています..."
    Set-Location $ComfyDir
    git pull --ff-only 2>$null
    if (-not $?) { Warn "git pull に失敗しました。手動で更新してください。" }
    Set-Location $RootDir
} else {
    Info "ComfyUI をクローン中... (初回は数分かかります)"
    git clone --depth 1 $ComfyRepo $ComfyDir
    Success "ComfyUI クローン完了"
}

# ComfyUI の Python 仮想環境
Info "ComfyUI の Python 環境を構築中..."
Set-Location $ComfyDir
if (-not (Test-Path ".venv")) {
    python -m venv .venv
}
& ".venv\Scripts\pip.exe" install --quiet --upgrade pip
& ".venv\Scripts\pip.exe" install --quiet -r requirements.txt
Success "ComfyUI 依存関係インストール完了"
Set-Location $RootDir

# ComfyUI のモデルディレクトリ作成
$modelDirs = @(
    "tools\comfyui\models\checkpoints",
    "tools\comfyui\models\loras",
    "tools\comfyui\models\vae",
    "tools\comfyui\models\video_models",
    "tools\comfyui\models\clip",
    "tools\comfyui\models\unet",
    "tools\comfyui\input",
    "tools\comfyui\output"
)
foreach ($d in $modelDirs) {
    $fullPath = Join-Path $RootDir $d
    if (-not (Test-Path $fullPath)) {
        New-Item -ItemType Directory -Path $fullPath | Out-Null
    }
}
Success "ComfyUI モデルディレクトリ作成完了"

# ── 6. .env ファイル ──────────────────────────────────────────────────────────
Step ".env ファイルを確認しています"

$EnvFile    = Join-Path $RootDir "backend\.env"
$EnvExample = Join-Path $RootDir "backend\.env.example"
if (-not (Test-Path $EnvFile)) {
    Copy-Item $EnvExample $EnvFile
    Warn ".env を作成しました。ANTHROPIC_API_KEY などを設定してください: $EnvFile"
} else {
    Success ".env は既に存在します"
}

$ModelsLocal   = Join-Path $RootDir "scripts\models.local.json"
$ModelsExample = Join-Path $RootDir "tools\models.example.json"
if (-not (Test-Path $ModelsLocal)) {
    Copy-Item $ModelsExample $ModelsLocal
    Info "models.local.json を作成しました。DL したいモデルを enabled: true にしてください"
}

# ── 完了 ──────────────────────────────────────────────────────────────────────
Write-Host "`n✓ セットアップ完了！" -ForegroundColor Green
Write-Host @"

  次のステップ:
  1. backend\.env を編集して ANTHROPIC_API_KEY を設定
  2. scripts\models.local.json で DL したいモデルを enabled: true に変更
  3. python scripts\install_models.py  でモデルをダウンロード
  4. .\scripts\start.ps1              でサービスを起動

"@
