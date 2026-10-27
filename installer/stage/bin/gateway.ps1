<#
小鱼 · QQ 网关（SnowLuma）
只做三件事：看状态、给指引、用户显式要求时打开已装好的它。

不做：下载、安装、静默启动。
SnowLuma 的 EULA 2.2 / 5.4 明确禁止把它并入第三方安装包、或用自动化脚本部署；
商业使用/公开分发还要作者书面授权（motricseven@foxmail.com）。

用法：
  .\gateway.ps1                看状态（同 -Check）
  .\gateway.ps1 -Json          给脚本读的 JSON
  .\gateway.ps1 -Open          打开已安装的 launcher.bat（登录仍需手动扫码）
#>
param(
  [switch]$Check,
  [switch]$Json,
  [switch]$Open
)

$ROOT = Split-Path -Parent $PSScriptRoot
$cfgPath = Join-Path $ROOT 'config.json'
$cfg = $null
if (Test-Path $cfgPath) {
  try { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
}

$snowHome = ''
if ($cfg -and $cfg.engines -and $cfg.engines.snowluma -and $cfg.engines.snowluma.home) {
  $snowHome = [string]$cfg.engines.snowluma.home
}
if (-not $snowHome) { $snowHome = Join-Path $env:USERPROFILE 'SnowLuma' }

$launcher = Join-Path $snowHome 'launcher.bat'
$installed = Test-Path $launcher

$version = ''
$releasePath = Join-Path $snowHome 'release.json'
if (Test-Path $releasePath) {
  try { $version = [string](Get-Content $releasePath -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
}

$port = 3000
if ($cfg -and $cfg.snowluma -and $cfg.snowluma.httpUrl) {
  try { $port = ([uri][string]$cfg.snowluma.httpUrl).Port } catch { }
}
$running = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)

$downloadUrl = 'https://github.com/FrostNova-Labs/SnowLuma/releases'
if ($cfg -and $cfg.snowluma -and $cfg.snowluma.downloadUrl) { $downloadUrl = [string]$cfg.snowluma.downloadUrl }

$eula = Join-Path $snowHome 'EULA.md'

$state = [pscustomobject]@{
  installed   = $installed
  home        = $snowHome
  launcher    = $launcher
  version     = $version
  running     = $running
  port        = $port
  eula        = $(if (Test-Path $eula) { $eula } else { '' })
  downloadUrl = $downloadUrl
}

if ($Json) { $state | ConvertTo-Json -Compress; exit 0 }

if ($Check -or (-not $Open)) {
  Write-Host ''
  if ($installed) {
    Write-Host "  ✅ SnowLuma 已安装：$snowHome" -ForegroundColor Green
    Write-Host "     版本 $version；当前$(if ($running) { '在跑（' + $port + ' 监听）' } else { '没在跑' })"
    if (-not $running) { Write-Host '     启动：bin\gateway.ps1 -Open（或面板「启动 SnowLuma」）' -ForegroundColor DarkGray }
  } else {
    Write-Host '  ⚠️ 没检测到 SnowLuma（launcher.bat 不存在）' -ForegroundColor Yellow
    Write-Host '     它不能随本程序分发（EULA 2.2 / 5.4）；请自行下载并同意 EULA。'
    Write-Host "     下载地址：$downloadUrl"
    Write-Host '     商业分发需作者书面授权：motricseven@foxmail.com' -ForegroundColor DarkGray
  }
  Write-Host ''
  exit 0
}

if (-not $installed) {
  Write-Host '❌ 没装 SnowLuma，不能启动。' -ForegroundColor Red
  Start-Process $downloadUrl
  exit 1
}

Write-Host '  打开 SnowLuma（登录/扫码需要你自己完成）…' -ForegroundColor Cyan
Start-Process -FilePath $launcher -WorkingDirectory $snowHome
