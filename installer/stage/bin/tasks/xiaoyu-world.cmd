@echo off
cd /d "C:\Users\best\ai-her\dist\xiaoyu"
set NODE_OPTIONS=--use-system-ca
set XIAOYU_HOME=C:\Users\best\AppData\Local\xiaoyu
node scripts\world-digest.mjs  >> "C:\Users\best\ai-her\dist\xiaoyu\logs\world.log" 2>&1
