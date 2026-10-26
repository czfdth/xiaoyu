<#
小鱼 · 从备份恢复
把 backup.ps1 生成的 zip 解回来（state / roles / config.json / companion.json）。

用法：
  .\restore.ps1 -From C:\...\backups\xiaoyu-20261026-045000.zip
  .\restore.ps1 -From ... -Force        # 大脑正在跑也恢复（会先备份当前 state）
  .\restore.ps1 -From ... -NoStart      # 只恢复，不起大脑

默认拒绝在 3100 还在监听时恢复——边跑边覆盖 state 会出双状态。
#>
param(
  [Parameter(Mandatory = $true)][string]$From,
  [switch]$Force,
  [switch]$NoStart
)

$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
$NODE = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NODE) { Write-Host '❌ 没找到 node' -ForegroundColor Red; exit 1 }

$zip = [IO.Path]::GetFullPath($From)
if (-not (Test-Path $zip)) { Write-Host "❌ 找不到 $zip" -ForegroundColor Red; exit 1 }

$raw = (& $NODE (Join-Path $ROOT 'src\paths.js') --init --json 2>$null) -join "`n"
$P = $raw | ConvertFrom-Json
$bridgeUp = [bool](Get-NetTCPConnection -LocalPort $P.ports.bridge -State Listen -ErrorAction SilentlyContinue)
if ($bridgeUp -and -not $Force) {
  Write-Host "❌ 大脑还在跑（$($P.ports.bridge)）。先 bin\xiaoyu.ps1 stop，或加 -Force。" -ForegroundColor Red
  exit 1
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage = Join-Path $env:TEMP ("xiaoyu-restore-$stamp-$PID")
try {
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  if (-not ((Test-Path (Join-Path $stage 'state')) -or (Test-Path (Join-Path $stage 'config.json')))) {
    throw '这个 zip 里没有 state 或 config.json，不像是小鱼的备份'
  }

  # 先备份当前的，恢复失败还能回去
  if (Test-Path (Join-Path $P.root 'state')) {
    Copy-Item (Join-Path $P.root 'state') (Join-Path $P.root "state.before-restore-$stamp") -Recurse -Force
  }
  if (Test-Path (Join-Path $P.root 'config.json')) {
    Copy-Item (Join-Path $P.root 'config.json') (Join-Path $P.root "config.json.before-restore-$stamp") -Force
  }

  foreach ($name in 'state', 'roles') {
    $src = Join-Path $stage $name
    if (-not (Test-Path $src)) { continue }
    $target = Join-Path $P.root $name
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    Copy-Item $src $target -Recurse -Force
  }
  foreach ($file in 'config.json', 'companion.json') {
    $src = Join-Path $stage $file
    if (Test-Path $src) { Copy-Item $src (Join-Path $P.root $file) -Force }
  }

  Write-Host "✅ 已恢复：$(Split-Path $zip -Leaf)" -ForegroundColor Green
  Write-Host "   旧 state 备份在 state.before-restore-$stamp" -ForegroundColor DarkGray

  if (-not $NoStart) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ROOT 'bin\xiaoyu.ps1') restart
  }
} catch {
  Write-Host "❌ 恢复失败：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
