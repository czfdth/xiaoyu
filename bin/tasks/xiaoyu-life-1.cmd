@echo off
cd /d "C:\Users\best\ai-her\dist\xiaoyu"
set NODE_OPTIONS=--use-system-ca
set XIAOYU_HOME=C:\Users\best\AppData\Local\xiaoyu
node scripts\life-wake.mjs  >> "C:\Users\best\ai-her\dist\xiaoyu\logs\life.log" 2>&1
