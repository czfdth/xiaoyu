<#
小鱼 · 定时行为（她自己的日子）
把 scripts\tasks.manifest.json 里的任务注册成 Windows 计划任务：
  · 每条生成一个 bin\tasks\<name>.cmd（cd 到程序目录、写 logs\<log>）
  · 计划任务只调这个 .cmd —— 换目录/重装后重跑一次就行

用法：
  .\tasks.ps1 -List       看当前状态
  .\tasks.ps1 -Install    生成 wrapper + 注册/更新任务（已存在则保留原触发器）
  .\tasks.ps1 -Remove     注销入口（不删日志/state）
#>
param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$List
)

$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $ROOT 'scripts\tasks.manifest.json'
$wrapperDir = Join-Path $ROOT 'bin\tasks'
$logDir = Join-Path $ROOT 'logs'

# 数据目录可能和程序目录不是同一个（安装版都在 %LOCALAPPDATA%\xiaoyu；开发机是代码在仓库、
# 数据在 LocalAppData）。不显式给 XIAOYU_HOME 的话，src/paths.js 会把**程序目录**当数据目录，
# 计划任务就会在那个空目录里跑 —— 表面正常、日志全空。线上真踩过：语义索引写进了仓库的空 state。
$DataHome = $env:XIAOYU_HOME
if (-not $DataHome) {
  $installed = Join-Path $env:LOCALAPPDATA 'xiaoyu'
  if ((Test-Path (Join-Path $installed 'config.json')) -and ($installed -ne $ROOT)) { $DataHome = $installed }
}
if (-not $DataHome) { $DataHome = $ROOT }

if (-not (Test-Path $manifestPath)) { Write-Host "❌ 缺少 $manifestPath" -ForegroundColor Red; exit 1 }
$manifest = (Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).tasks
if ($Install) { New-Item -ItemType Directory -Force -Path $wrapperDir, $logDir | Out-Null }

function Write-Wrapper($t) {
  $argsText = ''
  if ($t.args -eq '{yesterday}') { $argsText = '%YDAY%' } elseif ($t.args) { $argsText = $t.args }
  $lines = @(
    '@echo off',
    "cd /d `"$ROOT`"",
    'set NODE_OPTIONS=--use-system-ca'
  )
  if ($DataHome -ne $ROOT) { $lines += "set XIAOYU_HOME=$DataHome" }
  if ($t.args -eq '{yesterday}') {
    $lines += 'for /f %%i in (''powershell -NoProfile -Command "(Get-Date).AddDays(-1).ToString(''yyyy-MM-dd'')"'' ) do set YDAY=%%i'
  }
  if ($t.ps) {
    $rel = ($t.ps -replace '/', '\')
    $lines += "powershell -NoProfile -ExecutionPolicy Bypass -File `"$ROOT\$rel`" >> `"$logDir\$($t.log)`" 2>&1"
  } else {
    $lines += "node scripts\$($t.script) $argsText >> `"$logDir\$($t.log)`" 2>&1"
  }
  $path = Join-Path $wrapperDir "$($t.name).cmd"
  [IO.File]::WriteAllLines($path, $lines, (New-Object Text.UTF8Encoding($false)))
  return $path
}

function New-Trigger($t) {
  if ($t.mode -eq 'daily') {
    return New-ScheduledTaskTrigger -Daily -At $t.time
  }
  $minutes = if ($t.everyMinutes) { [int]$t.everyMinutes } else { [int]$t.everyHours * 60 }
  return New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes $minutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
}

if ($List -or (-not $Install -and -not $Remove)) {
  $rows = foreach ($t in $manifest) {
    $task = Get-ScheduledTask -TaskName $t.name -ErrorAction SilentlyContinue
    $info = if ($task) { Get-ScheduledTaskInfo -TaskName $t.name -ErrorAction SilentlyContinue } else { $null }
    [pscustomobject]@{
      Task    = $t.name
      State   = if ($task) { $task.State } else { 'missing' }
      Wrapper = Test-Path (Join-Path $wrapperDir "$($t.name).cmd")
      Last    = if ($info) { $info.LastTaskResult } else { '' }
    }
  }
  $rows | Format-Table -AutoSize
  exit 0
}

if ($Remove) {
  foreach ($t in $manifest) {
    Unregister-ScheduledTask -TaskName $t.name -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $wrapperDir "$($t.name).cmd") -Force -ErrorAction SilentlyContinue
    Write-Host "  - $($t.name)"
  }
  Write-Host '已注销（日志与 state 保留）' -ForegroundColor Yellow
  exit 0
}

if ($Install) {
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

  # 静默执行器：任务直接跑 cmd.exe /c 时，每分钟都会在桌面闪一个黑框。
  # 用 wscript 调 SW_HIDE 起 .cmd，任务照跑，桌面不闪。
  $hiddenVbs = Join-Path $wrapperDir '_hidden.vbs'
  if (-not (Test-Path $hiddenVbs)) {
    $srcVbs = Join-Path $PSScriptRoot '_hidden.vbs'
    if (Test-Path $srcVbs) {
      Copy-Item $srcVbs $hiddenVbs -Force
    } else {
      Write-Host "  ⚠️ 缺少 _hidden.vbs，计划任务会每分钟弹黑框" -ForegroundColor Yellow
    }
  }

  foreach ($t in $manifest) {
    $wrapper = Write-Wrapper $t
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$hiddenVbs`" `"$wrapper`""
    $existing = Get-ScheduledTask -TaskName $t.name -ErrorAction SilentlyContinue
    if ($existing) {
      Set-ScheduledTask -TaskName $t.name -Action $action | Out-Null
      Write-Host "  ↻ $($t.name)（保留原触发器）"
    } else {
      Register-ScheduledTask -TaskName $t.name -Action $action -Trigger (New-Trigger $t) `
        -Principal $principal -Description "小鱼 · $($t.name)" | Out-Null
      Write-Host "  + $($t.name)"
    }
    Enable-ScheduledTask -TaskName $t.name | Out-Null

    # 错过的任务开机补跑；用电池也跑（她要过日子，不能因为拔了电源就停）
    # 用 XML 改：直接改 CIM Settings 再 Set-ScheduledTask 在部分机器上会崩。
    try {
      $xml = Export-ScheduledTask -TaskName $t.name
      $xml = $xml -replace '<StartWhenAvailable>false</StartWhenAvailable>', '<StartWhenAvailable>true</StartWhenAvailable>' `
        -replace '<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>', '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>' `
        -replace '<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>', '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'
      # 大多数任务的 XML 里根本没有 StartWhenAvailable 节点（默认就是 false），
      # 只做替换改不到它，必须补一个。
      if ($xml -notmatch '<StartWhenAvailable>') {
        $xml = $xml -replace '<Settings>', "<Settings>`r`n    <StartWhenAvailable>true</StartWhenAvailable>"
      }
      Register-ScheduledTask -TaskName $t.name -Xml $xml -Force | Out-Null
    } catch {
      Write-Host "  ⚠️ $($t.name) 设置没改成：$($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
  Write-Host ''
  Write-Host "✅ 已注册 $(@($manifest).Count) 个任务；日志在 $logDir" -ForegroundColor Green
}
