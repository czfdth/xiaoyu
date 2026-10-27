@echo off
cd /d "C:\Users\best\ai-her\dist\xiaoyu"
set NODE_OPTIONS=--use-system-ca
set XIAOYU_HOME=C:\Users\best\AppData\Local\xiaoyu
node scripts\memoir-wake.mjs  >> "C:\Users\best\ai-her\dist\xiaoyu\logs\memoir.log" 2>&1
