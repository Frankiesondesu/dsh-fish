@echo off
chcp 65001 >nul
pushd "%~dp0"
title Fish Manager
node manager\server.mjs
if errorlevel 1 pause
