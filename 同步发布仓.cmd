@echo off
chcp 65001 >nul
title Sync to release
pushd "%~dp0"
node tools-sync-release.mjs %*
popd
echo.
pause
