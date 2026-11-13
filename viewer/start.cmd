@echo off
chcp 65001 >nul
pushd "%~dp0"
rem 2026-11-12: ASCII only. An unquoted ">" in echo becomes a redirect and creates
rem a junk file named after the URL tail, so the arrow is written as "at".
echo Viewer at http://127.0.0.1:7788
start "" http://127.0.0.1:7788
node viewer.mjs
pause
