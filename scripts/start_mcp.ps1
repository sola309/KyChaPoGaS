# =============================================================================
# KyChaPoGaS — MCP Server 起動スクリプト (Windows PowerShell)
# =============================================================================
# 使い方:
#   .\scripts\start_mcp.ps1 [-ProjectId 1]
#
# Claude Code の MCP 設定例 (.claude/settings.json):
#   {
#     "mcpServers": {
#       "kychapogas": {
#         "command": "powershell",
#         "args": ["-File", "p:/AniPAFE2026/scripts/start_mcp.ps1", "-ProjectId", "1"]
#       }
#     }
#   }
# =============================================================================

param(
    [int]$ProjectId = 1
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
$BackendDir = Join-Path $RootDir "backend"

$VenvPython = Join-Path $BackendDir ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    Write-Error "仮想環境が見つかりません: $VenvPython"
    Write-Error "先に .\scripts\setup.ps1 を実行してください。"
    exit 1
}

$env:PYTHONPATH = $BackendDir
$McpScript = Join-Path $BackendDir "mcp_server.py"

Write-Host "KyChaPoGaS MCP Server 起動中 (project_id=$ProjectId)..." -ForegroundColor Cyan
& $VenvPython $McpScript --project-id $ProjectId
