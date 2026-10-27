@echo off
cd /d "C:\Users\best\ai-her\dist\xiaoyu"
set NODE_OPTIONS=--use-system-ca
set XIAOYU_HOME=C:\Users\best\AppData\Local\xiaoyu
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).AddDays(-1).ToString('yyyy-MM-dd')"' ) do set YDAY=%%i
node scripts\extract-memory.mjs %YDAY% >> "C:\Users\best\ai-her\dist\xiaoyu\logs\memory-extract.log" 2>&1
