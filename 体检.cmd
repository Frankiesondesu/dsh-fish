@echo off
chcp 65001 >nul
pushd "%~dp0"
node launch.mjs --check
pause
