# Starts Waymark on Windows: http://localhost:8723 (set $env:PORT for another port), and opens it in the browser.
# Needs uv: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
# Run it with:  powershell -ExecutionPolicy Bypass -File run.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host "run.ps1: uv is missing. Install it once:" -ForegroundColor Yellow
    Write-Host '  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
    exit 1
}
if (-not (Test-Path "frontend\dist\index.html")) {
    if (Test-Path "frontend\src") {
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Write-Host "run.ps1: the UI isn't built and npm is missing (install Node.js)."; exit 1 }
        Push-Location frontend; npm install --silent; npm run build --silent; Pop-Location
    } else {
        Write-Host "run.ps1: the UI is missing (frontend\dist). Unpack the package again."; exit 1
    }
}
$port = if ($env:PORT) { $env:PORT } else { "8723" }
$busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($busy) { Write-Host "run.ps1: something is already listening on port $port. Is Waymark already running?"; exit 1 }

$url = "http://localhost:$port"
Start-Job -ScriptBlock {
    param($u)
    for ($i = 0; $i -lt 120; $i++) {
        try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 "$u/api/meta" | Out-Null; Start-Process $u; break } catch { Start-Sleep -Milliseconds 500 }
    }
} -ArgumentList $url | Out-Null
Write-Host "run.ps1: Waymark on $url (Ctrl+C stops it). Your data is in $env:APPDATA\Waymark"
Set-Location backend
uv run --frozen --no-dev uvicorn app.main:app --host 127.0.0.1 --port $port
