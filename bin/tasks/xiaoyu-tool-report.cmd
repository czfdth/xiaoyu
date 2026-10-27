@echo off
cd /d "C:\Users\best\ai-her\dist\xiaoyu"
set NODE_OPTIONS=--use-system-ca
set XIAOYU_HOME=C:\Users\best\AppData\Local\xiaoyu
node scripts\report-tool-usage.mjs  >> "C:\Users\best\ai-her\dist\xiaoyu\logs\tool-usage.log" 2>&1
