# 小鱼 · 打包脚本
#
# 做两件事：
#   1. 把"程序文件"铺进 installer\stage（不含 state / logs / backups / config）
#   2. 生成 out\小鱼安装程序-<版本>.exe（需要 Inno Setup 6）；没有 iscc 就退回便携 zip
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File installer\build.ps1
#   powershell -ExecutionPolicy Bypass -File installer\build.ps1 -NoInstaller   # 只出 zip
param(
  [switch]$NoInstaller,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Stage = Join-Path $PSScriptRoot 'stage'
$Out = Join-Path $Root 'out'

$pkg = Get-Content (Join-Path $Root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
Write-Host "小鱼 打包 v$version" -ForegroundColor Cyan

# ── 1. 准备程序文件 ─────────────────────────────────────────────────────
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $Stage -Force | Out-Null

if (-not $SkipBuild) {
  Write-Host '构建控制台前端…'
  & npm --prefix (Join-Path $Root 'gui') run build | Out-Host
  if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
}

$include = @('src', 'scripts', 'bin', 'roles', 'gui\dist', 'gui\server', 'gui\shared', 'presets', 'docs')
foreach ($dir in $include) {
  $from = Join-Path $Root $dir
  if (-not (Test-Path $from)) { continue }
  $to = Join-Path $Stage $dir
  New-Item -ItemType Directory -Path (Split-Path $to -Parent) -Force | Out-Null
  Copy-Item $from $to -Recurse -Force
}

foreach ($file in @('package.json', 'install.ps1', 'README.md', 'LICENSE', 'gui\server.mjs', 'gui\package.json', 'gui\package-lock.json')) {
  $from = Join-Path $Root $file
  if (Test-Path $from) { Copy-Item $from (Join-Path $Stage $file) -Force }
}
Get-ChildItem $Root -Filter '*.bat' -File | ForEach-Object { Copy-Item $_.FullName (Join-Path $Stage $_.Name) -Force }

# 生产依赖：她的桥接要用 sdk / mcp / zod 这些
Write-Host '安装生产依赖到 stage…'
Push-Location $Stage
try {
  & npm install --omit=dev --no-audit --no-fund | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'npm install 失败（stage 里的依赖没装好）' }

  # 控制台自己的依赖（fastify / @fastify/static）在 gui/package.json 里，
  # 不装它们，装完之后「打开管家」会因为找不到 fastify 直接起不来。
  if (Test-Path (Join-Path $Stage 'gui\package.json')) {
    Write-Host '安装控制台依赖（gui）…'
    & npm --prefix (Join-Path $Stage 'gui') install --omit=dev --no-audit --no-fund | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'gui 依赖安装失败' }
  }
} finally {
  Pop-Location
}

$size = [math]::Round(((Get-ChildItem $Stage -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host "stage 就绪：$size MB" -ForegroundColor Green

# ── 2. 安装程序 ─────────────────────────────────────────────────────────
New-Item -ItemType Directory -Path $Out -Force | Out-Null
$cmd = Get-Command iscc -ErrorAction SilentlyContinue
$iscc = if ($cmd) { $cmd.Source } else { $null }
if (-not $iscc) {
  foreach ($candidate in @(
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
  )) { if (Test-Path $candidate) { $iscc = $candidate; break } }
}

if ($iscc -and -not $NoInstaller) {
  Write-Host "用 Inno Setup 打包：$iscc"
  & $iscc "/DAppVersion=$version" (Join-Path $PSScriptRoot 'xiaoyu.iss')
  if ($LASTEXITCODE -ne 0) { throw 'Inno Setup 编译失败' }
  Write-Host "安装程序已生成：$Out" -ForegroundColor Green
} else {
  if (-not $NoInstaller) { Write-Warning '没找到 iscc（Inno Setup 6），改为生成便携 zip' }
  $zip = Join-Path $Out "xiaoyu-$version-portable.zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  & 7z a -tzip -mx=7 $zip "$Stage\*" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'zip 打包失败' }
  Write-Host "便携包已生成：$zip" -ForegroundColor Green
  Write-Host '用户解压后运行 install.ps1 即可安装（同样装到 %LOCALAPPDATA%\xiaoyu）'
}
