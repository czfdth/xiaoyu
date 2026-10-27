@echo off
cd /d "C:\Users\best\ai-her\dist\xiaoyu"
set NODE_OPTIONS=--use-system-ca
set XIAOYU_HOME=C:\Users\best\AppData\Local\xiaoyu
node scripts\reset-session.mjs  >> "C:\Users\best\ai-her\dist\xiaoyu\logs\reset.log" 2>&1
