@echo off
chcp 65001 >nul
pushd "%~dp0"
echo.
echo   她 · 一键重启
echo   ----------------------------------------
echo   1. 全部重启   DSH + QQ + 桥 + 查看器
echo   2. 只重启桥   改完 bridge.mjs 用这个
echo   3. 只重启 DSH 改完插件代码用这个（fork 生效）
echo   4. 只看会关什么，不动手
echo.
set /p c=选一个（1-4，直接回车=全部重启）：
if "%c%"=="2" goto bridge
if "%c%"=="3" goto dsh
if "%c%"=="4" goto check
node restart.mjs
goto end

:bridge
node restart.mjs 桥
goto end

:dsh
node restart.mjs DSH
goto end

:check
node restart.mjs --check

:end
echo.
pause
