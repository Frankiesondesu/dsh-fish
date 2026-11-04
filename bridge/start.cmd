@echo off
chcp 65001 >nul
pushd "%~dp0"
echo 启动 QQ -> 她 的桥...
node bridge.mjs
pause
