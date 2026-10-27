@echo off
cd /d "C:\Users\best\ai-her\dist\xiaoyu"
set NODE_OPTIONS=--use-system-ca
set XIAOYU_HOME=C:\Users\best\AppData\Local\xiaoyu
node scripts\backup-key-escrow.mjs  >> "C:\Users\best\ai-her\dist\xiaoyu\logs\backup-key-escrow.log" 2>&1
