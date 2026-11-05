@echo off
chcp 65001 >nul
pushd "%~dp0"
node restart.mjs --menu
pause
