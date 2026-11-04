@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 她 · 查看器  ->  http://127.0.0.1:7788
start "" http://127.0.0.1:7788
node viewer.mjs
pause
