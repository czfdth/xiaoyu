<#
小鱼 · 看门狗
每 20 秒看一眼：大脑（bridge）还在不在？管家面板还在不在？掉了就拉起来。

它**只管自己的两个进程**：
  · 不启动/不结束 SnowLuma（项目不变量 L6）
  · 不管 GPT-SoVITS / ComfyUI（那两个允许常驻，崩了不影响她回消息）

用法：
  .\watchdog.ps1                 前台跑（Ctrl+C 停）
  .\watchdog.ps1 -WithGui        顺带看住 8765 面板
  .\watchdog.ps1 -WithEngines    顺带看住声音（GPT-SoVITS 9880；不碰 SnowLuma）
  .\watchdog.ps1 -Once           只检查/修复一次就退出（排错用）
  .\watchdog.ps1 -CheckOnly      只报告，不动手
  .\watchdog.ps1 -IntervalSeconds 30
#>
param(
  [int]$IntervalSeconds = 20,
  [switch]$WithGui,
  [switch]$WithEngines,
  [switch]$Once,
  [switch]$CheckOnly,
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
function Get-GpuMode {
  try {
    $file = Join-Path $P.dirs.state 'gpu-mode.txt'
    $m = (Get-Content $file -Raw -ErrorAction SilentlyContinue).Trim()
    if ($m) { return $m }
  } catch { }
  return 'idle'
}
$ROOT = Split-Path -Parent $PSScriptRoot
$NODE = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NODE) { Write-Host '❌ 没找到 node' -ForegroundColor Red; exit 1 }

$raw = (& $NODE (Join-Path $ROOT 'src\paths.js') --init --json 2>$null) -join "`n"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
  Write-Host '❌ src\paths.js 跑不通' -ForegroundColor Red
  exit 1
}
$P = $raw | ConvertFrom-Json
$LOG = Join-Path $P.dirs.logs 'watchdog.log'
$LOCK = Join-Path $P.dirs.state 'watchdog.lock'
New-Item -ItemType Directory -Force -Path $P.dirs.logs | Out-Null

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  if (-not $Quiet) { Write-Host $line -ForegroundColor DarkGray }
  try {
    if ((Test-Path $LOG) -and ((Get-Item $LOG).Length -gt 1MB)) {
      Move-Item $LOG "$LOG.old" -Force -ErrorAction SilentlyContinue
    }
    Add-Content -Path $LOG -Value $line -Encoding UTF8
  } catch { }
}

function Test-Port($p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

function Test-Alive($procId) {
  try { return [bool](Get-Process -Id $procId -ErrorAction Stop) } catch { return $false }
}

# ── 单实例：两个看门狗会互相打架 ───────────────────────────────────────────
$existing = $null
if (Test-Path $LOCK) {
  $rawLock = (Get-Content $LOCK -Raw -ErrorAction SilentlyContinue).Trim()
  if ($rawLock -match '^\d+$' -and (Test-Alive ([int]$rawLock))) {
    Write-Host "看门狗已经在跑（PID $rawLock），不重复启动。" -ForegroundColor Yellow
    exit 0
  }
}
Set-Content -Path $LOCK -Value "$PID" -Encoding ASCII
try {
  Log "看门狗启动（PID $PID，间隔 ${IntervalSeconds}s，WithGui=$WithGui，CheckOnly=$CheckOnly）"

  function Ensure-Bridge {
    if (Test-Port $P.ports.bridge) { return $false }
    if ($CheckOnly) { Log '大脑不在（3100 没监听）——CheckOnly，不动'; return $false }
    Log '大脑不在，拉起来'
    Start-Process -FilePath $NODE -ArgumentList 'src/bridge.js' -WorkingDirectory $P.codeRoot -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $P.dirs.logs 'bridge.out.log') `
      -RedirectStandardError (Join-Path $P.dirs.logs 'bridge.err.log') | Out-Null
    return $true
  }

  function Ensure-Gui {
    if ($CheckOnly) {
      if (-not (Test-Port $P.ports.gui)) { Log '面板不在（8765 没监听）——CheckOnly，不动' }
      return $false
    }
    if (Test-Port $P.ports.gui) { return $false }
    Log '面板不在，拉起来'
    Start-Process -FilePath $NODE -ArgumentList 'gui/server.mjs' -WorkingDirectory $P.codeRoot -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $P.dirs.logs 'console.out.log') `
      -RedirectStandardError (Join-Path $P.dirs.logs 'console.err.log') | Out-Null
    return $true
  }

  function Ensure-Engines {
    if ((Get-GpuMode) -eq 'draw') { return $false }
    if (-not $WithEngines) { return $false }
    if (Test-Port $P.ports.tts) {
      $script:engineLaunchedAt = $null
      $script:engineFailStreak = 0
      $script:engineBackoffUntil = [datetime]::MinValue
      return $false
    }
    if ($script:engineBackoffUntil -and (Get-Date) -lt $script:engineBackoffUntil) { return $false }
    # 预热期：GPT-SoVITS 在 CPU 上加载权重要几十秒，这段时间端口没监听是正常的。
    # 不等它就会每 7 秒重新加载一次权重——内存被吃光正是之前整机 OOM / Edge 崩溃的根源。
    $grace = 90
    if ($script:engineLaunchedAt) {
      $age = ((Get-Date) - $script:engineLaunchedAt).TotalSeconds
      if ($age -lt $grace) { return $false }
      $script:engineFailStreak = [int]$script:engineFailStreak + 1
      if ($script:engineFailStreak -ge 3) {
        $wait = [Math]::Min(600, 60 * [Math]::Pow(2, $script:engineFailStreak - 3))
        $script:engineBackoffUntil = (Get-Date).AddSeconds($wait)
        Log ("声音连续 {0} 次没起来，先停手 {1} 分钟（看 logs\tts.err.log）" -f $script:engineFailStreak, [int]($wait / 60))
        return $false
      }
    }
    $g = $P.engines.gptSovits
    if (-not $g.home -or -not $g.python) {
      if (-not $CheckOnly) { Log '声音不在，但没找到 GPT-SoVITS（跳过）' }
      return $false
    }
    if ($CheckOnly) { Log '声音不在（9880 没监听）——CheckOnly，不动'; return $false }
    Log '声音不在，拉起来'
    Start-Process -FilePath $g.python `
      -ArgumentList 'api_v2.py', '-c', 'GPT_SoVITS/configs/tts_infer.yaml', '-a', '127.0.0.1', '-p', "$($P.ports.tts)" `
      -WorkingDirectory $g.home -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $P.dirs.logs 'tts.out.log') `
      -RedirectStandardError (Join-Path $P.dirs.logs 'tts.err.log') | Out-Null
    $script:engineLaunchedAt = Get-Date
    return $true
  }

  if ($Once) {
    $a = Ensure-Bridge
    $b = if ($WithGui) { Ensure-Gui } else { $false }
    $c = Ensure-Engines
    if (-not $a -and -not $b -and -not $c) { Log '检查完成：都活着' }
    exit 0
  }

  $missingStreak = 0
  while ($true) {
    $acted = $false
    if (Ensure-Bridge) { $acted = $true }
    if ($WithGui -and (Ensure-Gui)) { $acted = $true }
    if ($WithEngines -and (Ensure-Engines)) { $acted = $true }
    if ($acted) {
      Start-Sleep -Seconds 5
      continue
    }
    # 连续多次「刚拉起又没了」说明不是偶发崩溃，记一条醒目的
    if (-not (Test-Port $P.ports.bridge)) {
      $missingStreak += 1
      if ($missingStreak -eq 3) { Log '⚠️ 大脑连续 3 次检查都不在（看 logs\bridge.err.log）' }
    } else {
      $missingStreak = 0
    }
    Start-Sleep -Seconds $IntervalSeconds
  }
} finally {
  try {
    if ((Test-Path $LOCK) -and ((Get-Content $LOCK -Raw).Trim() -eq "$PID")) { Remove-Item $LOCK -Force }
  } catch { }
}
