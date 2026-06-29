$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is not installed or not in PATH."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is not installed or not in PATH."
}

if (-not (Test-Path ".env") -and (Test-Path ".env.example")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example. Review it if VM access is required."
}

Write-Host "Installing dependencies..."
npm install

Write-Host "Starting Sentaurus Agent..."
Write-Host "Backend:  http://10.6.22.1:5175"
Write-Host "Frontend: http://10.6.22.1:5174"
npm run dev
