@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-dev.ps1"
if errorlevel 1 (
  echo.
  echo Sentaurus Agent failed to start. Press any key to close.
  pause >nul
)
