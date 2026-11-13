@echo off
rem tunnel gate: password gate for viewer/manager behind natfrp tunnels
rem frp local ports: viewer=7790 manager=7791 (NEVER tunnel 7788/7789 directly)
cd /d "%~dp0"
start "tunnel-gate" /min node tunnel-gate.mjs
