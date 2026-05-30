# First-time backend setup
Set-Location $PSScriptRoot
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
Write-Host "Setup complete. Run: .\.venv\Scripts\uvicorn main:app --reload"
