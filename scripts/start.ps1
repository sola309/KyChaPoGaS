# =============================================================================
# KyChaPoGaS — 全サービス起動スクリプト (Windows PowerShell)
# =============================================================================
# 使い方:
#   .\scripts\start.ps1 [-NoComfyUI] [-NoFrontend]
#
# 起動するサービス:
#   1. Backend   (FastAPI)      — http://localhost:8000
#   2. Frontend  (Vite dev)     — http://localhost:5173
#   3. Terminal  (node-pty WS)  — ws://localhost:8765
#   4. ComfyUI   (任意)         — http://localhost:8188
# =============================================================================

param(
    [switch]$NoComfyUI,
    [switch]$NoFrontend
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
Set-Location $RootDir

function Info    { param($m) Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Success { param($m) Write-Host "[OK]   $m" -ForegroundColor Green }
function Warn    { param($m) Write-Host "[WARN] $m" -ForegroundColor Yellow }

Write-Host "KyChaPoGaS — Starting services`n" -ForegroundColor White

$jobs = @()

# ── Backend ───────────────────────────────────────────────────────────────────
Info "Backend を起動しています (port 8000)..."
$backendDir = Join-Path $RootDir "backend"
if (-not (Test-Path "$backendDir\.venv")) {
    Write-Host "  → setup.ps1 を先に実行してください" -ForegroundColor Red
    exit 1
}
$backendJob = Start-Process -FilePath "powershell" -ArgumentList @(
    "-NoProfile", "-Command",
    "Set-Location '$backendDir'; .\.venv\Scripts\uvicorn.exe main:app --host 0.0.0.0 --port 8000 --reload"
) -WindowStyle Normal -PassThru
$jobs += $backendJob
Success "Backend PID=$($backendJob.Id)"

# ── Terminal server ────────────────────────────────────────────────────────────
Info "Terminal server を起動しています (port 8765)..."
$termDir = Join-Path $RootDir "terminal-server"
$termJob = Start-Process -FilePath "node" -ArgumentList "server.js" `
    -WorkingDirectory $termDir -WindowStyle Normal -PassThru
$jobs += $termJob
Success "Terminal server PID=$($termJob.Id)"

# ── ComfyUI (optional) ────────────────────────────────────────────────────────
if (-not $NoComfyUI) {
    $comfyDir = Join-Path $RootDir "tools\comfyui"
    if (Test-Path "$comfyDir\.venv") {
        Info "ComfyUI を起動しています (port 8188)..."
        $comfyJob = Start-Process -FilePath "powershell" -ArgumentList @(
            "-NoProfile", "-Command",
            "Set-Location '$comfyDir'; .\.venv\Scripts\python.exe main.py --listen 0.0.0.0 --port 8188"
        ) -WindowStyle Normal -PassThru
        $jobs += $comfyJob
        Success "ComfyUI PID=$($comfyJob.Id)"
    } else {
        Warn "ComfyUI 未インストール (setup.ps1 を実行してください)"
    }
}

# ── Frontend ──────────────────────────────────────────────────────────────────
if (-not $NoFrontend) {
    Info "Frontend を起動しています (port 5173)..."
    $frontendDir = Join-Path $RootDir "frontend"
    $frontendJob = Start-Process -FilePath "powershell" -ArgumentList @(
        "-NoProfile", "-Command",
        "Set-Location '$frontendDir'; npm run dev"
    ) -WindowStyle Normal -PassThru
    $jobs += $frontendJob
    Success "Frontend PID=$($frontendJob.Id)"
}

# ── 完了メッセージ ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "全サービス起動完了" -ForegroundColor Green
Write-Host ""
Write-Host "  Backend:  http://localhost:8000"
if (-not $NoFrontend) { Write-Host "  Frontend: http://localhost:5173" }
Write-Host "  Terminal: ws://localhost:8765"
if (-not $NoComfyUI -and (Test-Path "$comfyDir\.venv")) {
    Write-Host "  ComfyUI:  http://localhost:8188"
}
Write-Host ""
Write-Host "各サービスは別ウィンドウで実行中です。" -ForegroundColor DarkGray
Write-Host "停止するには各ウィンドウを閉じるか、以下を実行してください:" -ForegroundColor DarkGray
Write-Host "  Stop-Process -Id $($jobs.Id -join ', ')" -ForegroundColor DarkGray
Write-Host ""
