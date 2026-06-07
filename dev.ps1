# KyChaPoGaS dev server launcher
# Usage: .\dev.ps1

$backendJob = Start-Job -ScriptBlock {
    Set-Location "$using:PSScriptRoot\backend"
    if (-not (Test-Path ".venv")) {
        python -m venv .venv
        .\.venv\Scripts\pip install -r requirements.txt
    }
    .\.venv\Scripts\uvicorn main:app --reload --host 0.0.0.0 --port 8002
}

$frontendJob = Start-Job -ScriptBlock {
    Set-Location "$using:PSScriptRoot\frontend"
    npm run dev
}

Write-Host "Backend  -> http://localhost:8002"
Write-Host "Frontend -> http://localhost:5173"
Write-Host "Press Ctrl+C to stop."

try {
    Wait-Job $backendJob, $frontendJob
} finally {
    Stop-Job $backendJob, $frontendJob
    Remove-Job $backendJob, $frontendJob
}
