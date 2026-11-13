@echo off
chcp 65001 >nul
pushd "%~dp0"
title Fish Manager
rem 2026-11-12: stop the old manager holding 7789 first, otherwise EADDRINUSE.
rem Double-click this after editing manager/**; no need to kill it in Task Manager.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7789 " ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)
node manager\server.mjs
if errorlevel 1 pause
