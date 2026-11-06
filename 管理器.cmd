@echo off
chcp 65001 >nul
pushd "%~dp0"
title 她 · 管理器
node manager\server.mjs
if errorlevel 1 pause
