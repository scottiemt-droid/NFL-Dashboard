@echo off
rem Starts the local board server (if not already running) and opens the board.
rem If Node is installed, rebuilds the scheme file first when it is missing or older than 6 days.
where node >nul 2>nul
if not errorlevel 1 node "%~dp0tools\build-schemes.js" --if-stale
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://localhost:8078/ -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 start "NFL Board server" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
timeout /t 2 /nobreak >nul
start "" http://localhost:8078/
