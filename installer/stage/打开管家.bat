@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 1; Start-Process 'http://127.0.0.1:8765'"
node "%~dp0gui\server.mjs"
