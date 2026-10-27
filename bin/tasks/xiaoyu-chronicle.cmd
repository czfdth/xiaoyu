@echo off
cd /d "C:\Users\best\ai-her\dist\xiaoyu"
set NODE_OPTIONS=--use-system-ca
set XIAOYU_HOME=C:\Users\best\AppData\Local\xiaoyu
node scripts\chronicle.mjs  >> "C:\Users\best\ai-her\dist\xiaoyu\logs\chronicle.log" 2>&1
