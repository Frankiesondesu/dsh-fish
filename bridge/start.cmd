@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 启动 QQ -> 她 的桥...
node bridge.mjs
pause
