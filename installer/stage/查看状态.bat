@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 小鱼 · 状态 ===
node "%~dp0bin\status.mjs"
echo.
pause
