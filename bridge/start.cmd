@echo off
chcp 65001 >nul
pushd "%~dp0"
rem 2026-11-12: stop the old bridge holding 6199 first, otherwise EADDRINUSE.
rem Only kills the process listening on 6199; other node processes are left alone.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":6199 " ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)
echo Starting QQ bridge...
node bridge.mjs
pause
