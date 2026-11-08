@echo off
chcp 65001 >nul
title Fish Phone Call
pushd "%~dp0"
set "OHW=%~dp0..\ohwhale-deploy"
"%OHW%\.venv\Scripts\python.exe" -u "%OHW%\scripts\start_fish_call.py" %*
popd
echo.
pause
