<#
小鱼 · 看门狗的看门狗
每 5 分钟跑一次（计划任务 xiaoyu-watchdog-guard）：
  · state\watchdog.lock 里的 PID 还活着 → 什么都不做
  · 不在了 / 锁是陈旧的 → 重新拉起 watchdog（-WithGui -WithEngines）

它只负责“把看门狗拉回来”，不直接碰 bridge/面板/引擎 —— 那些仍由 watchdog 管，
避免两套逻辑抢同一个进程。

用法：
  .\watchdog-guard.ps1          # 检查并修复一次
  .\watchdog-guard.ps1 -Check   # 只看状态
#>
param([switch]$Check)

$ROOT = Split-Path -Parent $PSScriptRoot
$NODE = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NODE) { exit 1 }

$raw = (& $NODE (Join-Path $ROOT 'src\paths.js') --init --json 2>$null) -join "`n"
if ($LASTEXITCODE -ne 0) { exit 1 }
$P = $raw | ConvertFrom-Json

$lock = Join-Path $P.dirs.state 'watchdog.lock'
$log = Join-Path $P.dirs.logs 'watchdog-guard.log'
New-Item -ItemType Directory -Force -Path $P.dirs.logs | Out-Null

function Log([string]$msg) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  Add-Content -Path $log -Value $line -Encoding UTF8
}

$wid = 0
if (Test-Path $lock) {
  $rawLock = (Get-Content $lock -Raw -ErrorAction SilentlyContinue).Trim()
  if ($rawLock -match '^\d+$') { $wid = [int]$rawLock }
}
$alive = $false
if ($wid -gt 0) { try { $alive = [bool](Get-Process -Id $wid -ErrorAction Stop) } catch { $alive = $false } }

if ($Check) {
  Write-Host ("watchdog PID={0} alive={1}" -f $wid, $alive)
  exit 0
}
if ($alive) { exit 0 }

Remove-Item $lock -Force -ErrorAction SilentlyContinue
Log ("看门狗不在（旧 PID {0}），重新拉起" -f $wid)
Start-Process -FilePath 'powershell' `
  -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $ROOT 'bin\watchdog.ps1'), '-WithGui', '-WithEngines', '-Quiet' `
  -WorkingDirectory $ROOT -WindowStyle Hidden | Out-Null
