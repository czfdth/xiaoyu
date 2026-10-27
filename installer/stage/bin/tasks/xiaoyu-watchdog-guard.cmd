@echo off
cd /d "C:\Users\best\ai-her\dist\xiaoyu"
set NODE_OPTIONS=--use-system-ca
set XIAOYU_HOME=C:\Users\best\AppData\Local\xiaoyu
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\best\ai-her\dist\xiaoyu\bin\watchdog-guard.ps1" >> "C:\Users\best\ai-her\dist\xiaoyu\logs\watchdog-guard.log" 2>&1
