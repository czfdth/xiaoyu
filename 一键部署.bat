@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo === 小鱼 · 一键部署 ===
echo 安装 + 接 QQ + 配对，一路走完。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\deploy.ps1" %*
echo.
pause
