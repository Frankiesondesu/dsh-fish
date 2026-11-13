@echo off
chcp 65001 >nul
pushd "%~dp0"
echo Starting fish webchat (self-hosted web chat)...
node webchat.mjs
pause
