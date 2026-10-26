@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 小鱼 · 启动 ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\start-all.ps1"
echo.
echo 窗口可以关掉（服务在后台跑）。看状态：双击「查看状态.bat」
pause
