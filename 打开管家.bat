@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM 入口文件丢过一次（2026-11-02：gui\server.mjs 不见了，双击就闪退）。
REM 所以这里先自检：缺文件就从仓库补，补不上就停在这儿把话说清楚，
REM 而不是开个窗口瞬间消失。
if not exist "%~dp0gui\server.mjs" (
  echo [自检] gui\server.mjs 不见了，尝试从仓库补回...
  if "%XIAOYU_REPO%"=="" set "XIAOYU_REPO=C:\Users\best\ai-her\dist\xiaoyu"
  if exist "%XIAOYU_REPO%\gui\server.mjs" (
    set "XIAOYU_HOME=%~dp0"
    node "%XIAOYU_REPO%\scripts\repair-install.mjs" --fix
  )
)
if not exist "%~dp0gui\server.mjs" (
  echo.
  echo 启动失败：找不到 gui\server.mjs
  echo 仓库里也没有备份。请重新安装，或手动把这个文件放回：
  echo   %~dp0gui\server.mjs
  echo.
  pause
  exit /b 1
)

REM 用 Edge 的 --app 模式开一个"独立窗口"（没有地址栏/标签页），并等控制台就绪再打开。
REM 找不到 Edge 会自动退回默认浏览器，行为与以前一致。
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0bin\open-console.ps1"
node "%~dp0gui\server.mjs"
pause
