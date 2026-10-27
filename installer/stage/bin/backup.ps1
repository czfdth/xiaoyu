<#
小鱼 · 备份
把她的东西打成一个 zip：state\（记忆/日记/梦/会话状态）、roles\、config.json、companion.json。
默认放在 <数据根>\backups\，保留 14 天。

用法：
  .\backup.ps1
  .\backup.ps1 -Out D:\xiaoyu-backups -KeepDays 30
#>
param(
  [string]$Out,
  [int]$KeepDays = 14,
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
$NODE = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NODE) { Write-Host '❌ 没找到 node' -ForegroundColor Red; exit 1 }

$raw = (& $NODE (Join-Path $ROOT 'src\paths.js') --init --json 2>$null) -join "`n"
if ($LASTEXITCODE -ne 0) { Write-Host '❌ src\paths.js 跑不通' -ForegroundColor Red; exit 1 }
$P = $raw | ConvertFrom-Json

$dest = if ($Out) { [IO.Path]::GetFullPath($Out) } else { Join-Path $P.root 'backups' }
$log = Join-Path $P.dirs.logs 'backup.log'
New-Item -ItemType Directory -Force -Path $dest, $P.dirs.logs | Out-Null

function Log([string]$msg) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  if (-not $Quiet) { Write-Host $line -ForegroundColor DarkGray }
  Add-Content -Path $log -Value $line -Encoding UTF8
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage = Join-Path $env:TEMP ("xiaoyu-backup-$stamp-$PID")
$zip = Join-Path $dest ("xiaoyu-$stamp.zip")

try {
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Copy-Item (Join-Path $P.root 'state') (Join-Path $stage 'state') -Recurse -Force
  # 临时音频/渲染中间产物不进备份
  Remove-Item (Join-Path $stage 'state\tmp') -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path (Join-Path $P.root 'roles')) { Copy-Item (Join-Path $P.root 'roles') (Join-Path $stage 'roles') -Recurse -Force }
  if (Test-Path (Join-Path $P.root 'config.json')) { Copy-Item (Join-Path $P.root 'config.json') (Join-Path $stage 'config.json') -Force }
  if (Test-Path (Join-Path $P.root 'companion.json')) { Copy-Item (Join-Path $P.root 'companion.json') (Join-Path $stage 'companion.json') -Force }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path $zip) { Remove-Item $zip -Force }
  [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)

  $mb = [math]::Round((Get-Item $zip).Length / 1MB, 2)
  Log ("ok: $(Split-Path $zip -Leaf) ($mb MB)")

  $cut = (Get-Date).AddDays(-$KeepDays)
  Get-ChildItem $dest -Filter 'xiaoyu-*.zip' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cut } | ForEach-Object {
    Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    Log ("pruned: $($_.Name)")
  }
} catch {
  Log ("FAILED: $($_.Exception.Message)")
  exit 1
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
