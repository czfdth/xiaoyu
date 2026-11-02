@echo off
chcp 936 >nul
cd /d "%~dp0"

REM 入口文件丢过一次（2026-11-02），这里先自检，缺了就从仓库补
if not exist "%~dp0gui\server.mjs" (
  echo [自检] gui\server.mjs 不见了，正在从仓库补回...
  if "%XIAOYU_REPO%"=="" set "XIAOYU_REPO=C:\Users\best\ai-her\dist\xiaoyu"
  if exist "%XIAOYU_REPO%\scripts\repair-install.mjs" (
    set "XIAOYU_HOME=%~dp0"
    node "%XIAOYU_REPO%\scripts\repair-install.mjs" --fix
  )
)
if not exist "%~dp0gui\server.mjs" (
  echo 启动失败：找不到 gui\server.mjs，请重新安装。
  pause
  exit /b 1
)

start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0bin\open-console.ps1"
node "%~dp0gui\server.mjs"
pause