@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 小鱼 · 停止大脑 ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\xiaoyu.ps1" stop
pause
