@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM 用 Edge 的 --app 模式开一个"独立窗口"（没有地址栏/标签页），并等控制台就绪再打开。
REM 找不到 Edge 会自动退回默认浏览器，行为与以前一致。
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0bin\open-console.ps1"
node "%~dp0gui\server.mjs"
