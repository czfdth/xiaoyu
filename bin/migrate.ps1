<#
小鱼 · 迁移：把现有 qq-bridge 的数据搬到这份包
用法：
  .\migrate.ps1 -From C:\Users\你\...\qq-bridge -DryRun     # 先看计划
  .\migrate.ps1 -From C:\Users\你\...\qq-bridge             # 真迁

它只搬「她的东西」，不碰代码：
  config.json、state\、roles\

参数：
  -From <dir>   旧 qq-bridge 根目录（必须有 src\bridge.js 和 config.json）
  -DryRun       只打印计划，什么都不改
  -NoStop       不停旧 bridge（默认会停，避免两个实例同时抢消息）
  -NoDsh        不改 DSH 里的 MCP 注册
  -NoStart      迁完不启动新的 bridge/面板
  -Force        目标 state\ 非空也继续（会先备份）
#>
param(
  [Parameter(Mandatory = $true)][string]$From,
  [switch]$DryRun,
  [switch]$NoStop,
  [switch]$NoDsh,
  [switch]$NoStart,
  [switch]$Force
)

$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
$NODE = (Get-Command node -ErrorAction SilentlyContinue).Source
$STAMP = Get-Date -Format 'yyyyMMdd-HHmmss'
$SRC = [IO.Path]::GetFullPath($From).TrimEnd('\')
$DST = [IO.Path]::GetFullPath($ROOT).TrimEnd('\')

function Step($n, $t) { Write-Host ''; Write-Host "[$n] $t" -ForegroundColor Cyan }
function Test-Port($p) { return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }

Write-Host ''
Write-Host '=== 小鱼 · 迁移 ===' -ForegroundColor Cyan
Write-Host "  从: $SRC"
Write-Host "  到: $DST"
if ($DryRun) { Write-Host '  （DryRun：只打印计划）' -ForegroundColor DarkGray }

# ── 0. 检查 ────────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $SRC 'src\bridge.js'))) { Write-Host "❌ $SRC 不像 qq-bridge（缺 src\bridge.js）" -ForegroundColor Red; exit 1 }
if (-not (Test-Path (Join-Path $SRC 'config.json'))) { Write-Host "❌ $SRC 没有 config.json" -ForegroundColor Red; exit 1 }
if ($SRC -eq $DST) { Write-Host '❌ 源和目标是同一个目录' -ForegroundColor Red; exit 1 }
if (-not $NODE) { Write-Host '❌ 没找到 node' -ForegroundColor Red; exit 1 }

$srcState = Join-Path $SRC 'state'
$dstState = Join-Path $DST 'state'
$srcFiles = @(Get-ChildItem $srcState -Recurse -File -ErrorAction SilentlyContinue)
$dstFiles = @(Get-ChildItem $dstState -Recurse -File -ErrorAction SilentlyContinue)
Write-Host ("  旧 state: {0} 个文件；新 state: {1} 个文件" -f $srcFiles.Count, $dstFiles.Count)

if ($dstFiles.Count -gt 0 -and -not $Force -and -not $DryRun) {
  Write-Host ''
  Write-Host '⚠️ 目标 state 里已经有数据。直接迁会覆盖她的记忆。' -ForegroundColor Yellow
  Write-Host '   想覆盖就先备份再迁：重跑并加 -Force（会先复制一份 state.bak-<时间>）。' -ForegroundColor Yellow
  exit 1
}

Step '1/6' '停旧大脑'
$oldPids = @()
$lock = Join-Path $srcState 'bridge.lock'
if (Test-Path $lock) {
  $rawLock = (Get-Content $lock -Raw -ErrorAction SilentlyContinue).Trim()
  if ($rawLock -match '^\d+$') { $oldPids += [int]$rawLock }
}
$srcRe = [regex]::Escape($SRC)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'src[\\/]bridge\.js' -and $_.CommandLine -match $srcRe } |
  ForEach-Object { $oldPids += $_.ProcessId }
$oldPids = $oldPids | Sort-Object -Unique

if ($NoStop) {
  Write-Host '  （-NoStop：不动旧进程）'
} elseif (-not $oldPids) {
  Write-Host '  没发现旧 bridge 在跑'
} elseif ($DryRun) {
  Write-Host ("  会停这些 PID: " + ($oldPids -join ', '))
} else {
  foreach ($id in $oldPids) {
    Write-Host "  kill PID $id"
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

Step '2/6' '备份现有数据'
if ($DryRun) {
  Write-Host "  会备份到 $DST\state.bak-$STAMP 和 config.json.bak-$STAMP"
} else {
  if (Test-Path $dstState) {
    Copy-Item $dstState "$DST\state.bak-$STAMP" -Recurse -Force
    Write-Host "  state → state.bak-$STAMP" -ForegroundColor DarkGray
  }
  if (Test-Path (Join-Path $DST 'config.json')) {
    Copy-Item (Join-Path $DST 'config.json') "$DST\config.json.bak-$STAMP" -Force
    Write-Host "  config.json → config.json.bak-$STAMP" -ForegroundColor DarkGray
  }
}

Step '3/6' '搬 config / state / roles'
if ($DryRun) {
  Write-Host "  会复制 config.json、state\（$($srcFiles.Count) 个文件）、roles\"
} else {
  Copy-Item (Join-Path $SRC 'config.json') (Join-Path $DST 'config.json') -Force
  robocopy $srcState $dstState /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if (Test-Path (Join-Path $SRC 'roles')) {
    robocopy (Join-Path $SRC 'roles') (Join-Path $DST 'roles') /E /NFL /NDL /NJH /NJS /NP | Out-Null
  }
  Write-Host '  完成' -ForegroundColor Green
}

Step '4/6' '把 DSH 的工具指向新目录'
if ($NoDsh) {
  Write-Host '  （-NoDsh：跳过）'
} elseif ($DryRun) {
  Write-Host "  会运行 node $DST\scripts\setup-dsh.mjs --profile auto"
} else {
  $out = & $NODE (Join-Path $DST 'scripts\setup-dsh.mjs') --profile auto 2>&1
  $code = $LASTEXITCODE
  $out | Select-Object -Last 6 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
  if ($code -ne 0) { Write-Host '  ⚠️ 注册失败（迁移本身已完成，可稍后手动重跑 setup-dsh）' -ForegroundColor Yellow }
  else { Write-Host '  ✅ 已指向新目录（DSH 重启后生效）' -ForegroundColor Green }
}

Step '5/6' '起新的大脑'
if ($NoStart -or $DryRun) {
  Write-Host '  （跳过）'
} else {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DST 'bin\xiaoyu.ps1') restart
  if (-not (Test-Port 8765)) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DST 'bin\xiaoyu.ps1') gui
  }
}

Step '6/6' '验收'
$okPort = Test-Port 3100
$okState = (Test-Path (Join-Path $dstState 'sessions.json')) -or ((Get-ChildItem $dstState -File -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
Write-Host ("  大脑 3100: {0}" -f ($(if ($okPort) { '✅ 在听' } else { '❌ 没起来' })))
Write-Host ("  state: {0}" -f ($(if ($okState) { '✅ 有数据' } else { '⚠️ 还是空的' })))
Write-Host ("  config: {0}" -f ($(if (Test-Path (Join-Path $DST 'config.json')) { '✅' } else { '❌' })))

$rollback = Join-Path $DST "logs\migrate-$STAMP.txt"
if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path (Split-Path $rollback) | Out-Null
  @"
小鱼迁移记录 $STAMP
从: $SRC
到: $DST

要回滚：
  1) 停新的： powershell -File "$DST\bin\xiaoyu.ps1" stop
  2) 起旧的： cd "$SRC"; node src/bridge.js
  3) 把 DSH 的工具指回旧目录： cd "$SRC"; node scripts/setup-dsh.mjs
  4) 重启 DSH

旧目录没有被动过（只读了 config/state/roles）。
"@ | Set-Content -Path $rollback -Encoding UTF8
  Write-Host "  回滚说明：$rollback" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '完成。' -ForegroundColor Green
if (-not $NoDsh -and -not $DryRun) { Write-Host '如果 DSH 里还没看到新工具：重启一次 DSH。' -ForegroundColor Yellow }
Write-Host ''
