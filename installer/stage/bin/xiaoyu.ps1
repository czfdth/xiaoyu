<#
小鱼管家（命令行版）
所有路径/端口来自 src\paths.js —— 这个脚本里没有写死的盘符。

用法：
  .\xiaoyu.ps1 status      看状态（服务 + 她 + 产出）
  .\xiaoyu.ps1 start       启动全部（= start-all.ps1）
  .\xiaoyu.ps1 stop        停止大脑（bridge）；-All 连 QQ 网关一起停
  .\xiaoyu.ps1 restart     重启大脑
  .\xiaoyu.ps1 log         看最近日志
  .\xiaoyu.ps1 me          看她的日记 / 回忆录 / 梦
  .\xiaoyu.ps1 gui         打开管家面板（没起就顺手起）
  .\xiaoyu.ps1 watchdog     前台跑看门狗（大脑/面板掉了自动拉起）
  .\xiaoyu.ps1 paths       看路径与引擎探测结果
#>
param(
  [string]$cmd = 'status',
  [switch]$All,
  [switch]$WithGui
)

$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
$NODE = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NODE) { Write-Host '❌ 没找到 node（先装 Node.js 22+）' -ForegroundColor Red; exit 1 }

$raw = (& $NODE (Join-Path $ROOT 'src\paths.js') --init --json 2>$null) -join "`n"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
  Write-Host '❌ src\paths.js 跑不通，先单独跑一下看错误' -ForegroundColor Red
  exit 1
}
$P = $raw | ConvertFrom-Json

function Test-Port($p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

function Get-BridgePids {
  $pids = @()
  $lock = Join-Path $P.dirs.state 'bridge.lock'
  if (Test-Path $lock) {
    $rawLock = (Get-Content $lock -Raw).Trim()
    if ($rawLock -match '^\d+$') { $pids += [int]$rawLock }
  }
  $rootRe = [regex]::Escape($P.root)
  Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'src[\\/]bridge\.js' -and $_.CommandLine -match $rootRe } |
    ForEach-Object { $pids += $_.ProcessId }
  return $pids | Sort-Object -Unique
}

switch ($cmd) {
  'status' { & $NODE (Join-Path $ROOT 'bin\status.mjs') }

  'start' {
    $sa = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $ROOT 'bin\start-all.ps1'))
    if ($WithGui) { $sa += '-WithGui' }
    & powershell @sa
  }

  'restart' {
    foreach ($id in Get-BridgePids) {
      Write-Host "  kill PID $id"
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    Start-Process -FilePath $NODE -ArgumentList 'src/bridge.js' -WorkingDirectory $P.root -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $P.dirs.logs 'bridge.out.log') `
      -RedirectStandardError (Join-Path $P.dirs.logs 'bridge.err.log') | Out-Null
    Start-Sleep -Seconds 6
    if (Test-Port $P.ports.bridge) { Write-Host '✅ 大脑已重启' -ForegroundColor Green }
    else { Write-Host "❌ 没起来，看 $(Join-Path $P.dirs.logs 'bridge.out.log')" -ForegroundColor Red }
  }

  'stop' {
    foreach ($id in Get-BridgePids) {
      Write-Host "  kill PID $id"
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
    if ($All) {
      # 程序化关闭 SnowLuma 只在用户显式 -All 时做（项目不变量 L6：默认只探测、不启停）
      Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'SnowLuma' } |
        ForEach-Object { Write-Host "  kill SnowLuma PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Write-Host '已停止大脑与 QQ 网关' -ForegroundColor Yellow
    } else {
      Write-Host '已停止大脑（QQ 网关还在跑；要一起停加 -All）' -ForegroundColor Yellow
    }
    Write-Host '声音/画图未动（它们可以常驻）' -ForegroundColor DarkGray
  }

  'log' {
    $file = Join-Path $P.dirs.state 'bridge.log'
    if (-not (Test-Path $file)) { Write-Host "还没有日志：$file" -ForegroundColor Yellow; break }
    Get-Content $file -Encoding UTF8 -Tail 25 | ForEach-Object { $_.Trim() }
  }

  'me' {
    Write-Host "`n--- 最近日记 ---" -ForegroundColor Cyan
    Get-ChildItem $P.dirs.state -Filter 'diary' -Directory -ErrorAction SilentlyContinue | Out-Null
    $diary = Join-Path $P.dirs.state 'diary'
    Get-ChildItem $diary -Filter '*.md' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending | Select-Object -First 1 |
      ForEach-Object { Get-Content $_.FullName -Encoding UTF8 | Select-Object -First 25 }

    Write-Host "`n--- 回忆录 ---" -ForegroundColor Cyan
    $memoir = Join-Path $P.dirs.state 'memoir'
    Get-ChildItem $memoir -Filter '*.md' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending | Select-Object -First 1 |
      ForEach-Object { "【$($_.Name)】"; Get-Content $_.FullName -Encoding UTF8 | Select-Object -First 15 }

    Write-Host "`n--- 最近的梦 ---" -ForegroundColor Cyan
    Get-Content (Join-Path $P.dirs.state 'dreams.jsonl') -Encoding UTF8 -Tail 1 -ErrorAction SilentlyContinue
  }

  'gui' {
    $port = $P.ports.gui
    if (-not (Test-Port $port)) {
      Write-Host '启动管家面板…'
      Start-Process -FilePath $NODE -ArgumentList 'gui/server.mjs' -WorkingDirectory $ROOT -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $P.dirs.logs 'console.out.log') `
        -RedirectStandardError (Join-Path $P.dirs.logs 'console.err.log') | Out-Null
      for ($i = 0; $i -lt 30; $i++) {
        if (Test-Port $port) { break }
        Start-Sleep -Milliseconds 300
      }
    }
    Start-Process "http://127.0.0.1:$port"
  }

  'watchdog' {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ROOT 'bin\watchdog.ps1') -WithGui
  }

  'paths' { & $NODE (Join-Path $ROOT 'src\paths.js') }

  default { Write-Host '未知命令，试试 status / start / stop / restart / log / me / gui / watchdog / paths' }
}
