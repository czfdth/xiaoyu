@echo off
cd /d "C:\Users\best\ai-her\dist\xiaoyu"
set NODE_OPTIONS=--use-system-ca
set XIAOYU_HOME=C:\Users\best\AppData\Local\xiaoyu
node scripts\restore-drill.mjs  >> "C:\Users\best\ai-her\dist\xiaoyu\logs\restore-drill.log" 2>&1
