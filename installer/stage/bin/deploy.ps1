<#
小鱼 · 一键部署（新用户只需要这一个）
用法：双击包根目录的「一键部署.bat」，或
      powershell -ExecutionPolicy Bypass -File bin\deploy.ps1

它做五件事：
  1. 检查 Node，把程序装到 %LOCALAPPDATA%\xiaoyu（保留已有的 state/config）
  2. 找 SnowLuma：已装就问你要不要打开（登录要你自己扫码，程序不代登）
  3. 等网关上线，自动发现 token 和端口，写进 config.json（不用手抄）
  4. 生成 6 位配对码，起大脑和管家面板
  5. 你用自己的 QQ 私聊她发这 6 位，就完成认主

参数：
  -Dest <dir>       装到别处
  -NoAutostart      不设开机自启
  -NoStart          只准备，不启动大脑/面板（排错用）
  -NoTasks          不注册定时行为（她的日记/回忆录/主动搭话等）
  -DryRun           只打印计划，什么都不改
  -StartGateway     不询问，直接打开已装好的 SnowLuma
#>
param(
  [string]$Dest,
  [switch]$NoAutostart,
  [switch]$NoStart,
  [switch]$NoTasks,
  [switch]$DryRun,
  [switch]$StartGateway,
  [int]$WaitSeconds = 120
)

$ErrorActionPreference = 'Continue'
$PKG = Split-Path -Parent $PSScriptRoot
$NODE = (Get-Command node -ErrorAction SilentlyContinue).Source
$DST = if ($Dest) { [IO.Path]::GetFullPath($Dest) } else { Join-Path $env:LOCALAPPDATA 'xiaoyu' }

function Step($n, $text) {
  Write-Host ''
  Write-Host "[$n] $text" -ForegroundColor Cyan
}
function Test-Port($p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}
function Wait-Port($p, $seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Test-Port $p) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

Write-Host ''
Write-Host '=== 小鱼 · 一键部署 ===' -ForegroundColor Cyan
if ($DryRun) { Write-Host '（DryRun：只打印计划，不安装、不启动）' -ForegroundColor DarkGray }

# ── 0. Node ────────────────────────────────────────────────────────────────
if (-not $NODE) {
  Write-Host '❌ 没找到 Node.js。' -ForegroundColor Red
  Write-Host '   先装 Node.js 22+：https://nodejs.org/zh-cn/download' -ForegroundColor Yellow
  if (-not $DryRun) { Start-Process 'https://nodejs.org/zh-cn/download' }
  exit 1
}
Write-Host "  Node $(& $NODE -v)  $NODE"
$nodeMajor = 0
try { $nodeMajor = [int]((& $NODE -v).TrimStart('v').Split('.')[0]) } catch { $nodeMajor = 0 }
if ($nodeMajor -lt 22) {
  Write-Host "❌ Node 版本太旧（$(& $NODE -v)），需要 22 以上。" -ForegroundColor Red
  Write-Host '   装新版：https://nodejs.org/zh-cn/download' -ForegroundColor Yellow
  exit 1
}

# ── 1. 安装 ────────────────────────────────────────────────────────────────
Step '1/6' "安装到 $DST"
if ($DryRun) {
  Write-Host "  （会调用 install.ps1 -Dest `"$DST`"）"
} else {
  $installArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PKG 'install.ps1'), '-Dest', $DST)
  if ($NoAutostart) { $installArgs += '-NoAutostart' }
  & powershell @installArgs
  if ($LASTEXITCODE -ne 0) { Write-Host '❌ 安装失败' -ForegroundColor Red; exit 1 }
}
$APP = if ($DryRun) { $PKG } else { $DST }

# ── 2. SnowLuma ────────────────────────────────────────────────────────────
Step '2/6' 'QQ 网关（SnowLuma）'
$json = (& $NODE (Join-Path $APP 'src\paths.js') --json 2>$null) -join "`n"
$P = $json | ConvertFrom-Json
$slHome = $P.engines.snowluma.home
$slLauncher = $P.engines.snowluma.launcher

if (Test-Port 3000) {
  Write-Host '  已在运行（3000 监听中）' -ForegroundColor Green
} elseif (-not $slHome) {
  Write-Host '  没找到 SnowLuma。它不随本程序分发（EULA 2.2/5.4），需要你自己下载并同意 EULA：' -ForegroundColor Yellow
  Write-Host '  https://github.com/FrostNova-Labs/SnowLuma/releases' -ForegroundColor Yellow
  if (-not $DryRun) {
    $a = Read-Host '  现在打开下载页吗？（Y/n）'
    if ($a -eq '' -or $a -match '^[Yy]') { Start-Process 'https://github.com/FrostNova-Labs/SnowLuma/releases' }
  }
  Write-Host "  装好并登录后，这里会最多等 $WaitSeconds 秒…"
} else {
  Write-Host "  已安装：$slHome"
  $open = $false
  if ($StartGateway) { $open = $true }
  elseif (-not $DryRun) {
    $answer = Read-Host '  现在打开 SnowLuma 吗？打开后用手机 QQ 扫码登录（Y/n）'
    $open = ($answer -eq '' -or $answer -match '^[Yy]')
  }
  if ($open -and $slLauncher) {
    Write-Host '  正在打开…' -ForegroundColor DarkGray
    Start-Process -FilePath $slLauncher -WorkingDirectory $slHome -WindowStyle Minimized | Out-Null
  } elseif ($open) {
    Write-Host '  没找到启动器，请手动打开 SnowLuma。' -ForegroundColor Yellow
  }
}
if (-not (Test-Port 3000) -and -not $DryRun) {
  Write-Host "  等网关上线（最多 $WaitSeconds 秒，扫码登录后会自动继续）…" -ForegroundColor DarkGray
  if (Wait-Port 3000 $WaitSeconds) { Write-Host '  ✅ 网关已上线' -ForegroundColor Green }
  else { Write-Host '  ⚠️ 网关还没上线，先把 SnowLuma 登录好；面板里可以随时重试。' -ForegroundColor Yellow }
}

# ── 3. 大脑（DSH） ─────────────────────────────────────────────────────────
Step '3/6' '大脑（DSH / DeepSeek Harness）'
if ($DryRun) {
  Write-Host '  （会运行 scripts\dsh-setup.mjs：找 DSH 端口、写 dsh.baseUrl、注册 MCP/preset）'
} else {
  $dshRaw = (& $NODE (Join-Path $APP 'scripts\dsh-setup.mjs') --json 2>$null) -join "`n"
  $dsh = $null
  try { $dsh = $dshRaw | ConvertFrom-Json } catch { }
  if ($dsh -and $dsh.ok) {
    Write-Host ("  ✅ 找到 DSH：{0}（profile {1}）" -f $dsh.baseUrl, $dsh.profile) -ForegroundColor Green
    if ($dsh.configUpdated) { Write-Host "  已把 dsh.baseUrl 写进 config.json" -ForegroundColor DarkGray }
    if ($dsh.registeredNow) {
      Write-Host '  ⚠️ 已把 MCP / preset 注册进 DSH：需要重启 DSH 才生效' -ForegroundColor Yellow
    } elseif (-not $dsh.registered) {
      Write-Host '  ⚠️ DSH 里还没注册小鱼的工具，跑一次 npm run setup-dsh 再重启 DSH' -ForegroundColor Yellow
    }
  } else {
    Write-Host '  ⚠️ 没找到在运行的 DSH（DeepSeek Harness）' -ForegroundColor Yellow
    if ($dsh -and $dsh.error) { Write-Host ("     {0}" -f $dsh.error) -ForegroundColor DarkGray }
    Write-Host '     先安装并打开 DSH、登录模型，再回面板「首次设置 → 自动检测」。' -ForegroundColor Yellow
  }
}

# ── 4. 自动发现 + 配对码 ───────────────────────────────────────────────────
Step '4/6' '自动发现网关，生成配对码'
if ($DryRun) {
  Write-Host '  （会运行 scripts\first-run.mjs：发现 token、写 config、生成 6 位配对码）'
} else {
$firstRaw = (& $NODE (Join-Path $APP 'scripts\first-run.mjs') --wait 15 --json 2>$null) -join "`n"
$first = $null
try { $first = $firstRaw | ConvertFrom-Json } catch { }
if (-not $first) {
  Write-Host '  ⚠️ 首次探测没拿到结果（可以先跳过，面板里能重试）。' -ForegroundColor Yellow
} else {
  if ($first.gateway.ok) {
    Write-Host ("  ✅ 网关：{0}（{1}）" -f ($first.gateway.nickname, $first.gateway.uin)) -ForegroundColor Green
  } else {
    Write-Host ("  ⚠️ 网关：{0}" -f $first.gateway.error) -ForegroundColor Yellow
  }
  if ($first.paired) {
    Write-Host ("  ✅ 已认主：{0}" -f $first.ownerQQ) -ForegroundColor Green
  } elseif ($first.pairing) {
    Write-Host ''
    Write-Host ("  配对码：{0}" -f $first.pairing.code) -ForegroundColor Magenta
    Write-Host '  用你自己的 QQ 私聊她，把这 6 位数字发过去。' -ForegroundColor Yellow
    Write-Host ''
  }
}
}

# ── 5. 起大脑 + 管家面板 + 定时行为 ────────────────────────────────────────
Step '5/6' '启动大脑、管家面板与定时行为'
if ($NoStart -or $DryRun) {
  Write-Host '  （跳过启动）'
  if ($DryRun) { Write-Host '  （会运行 bin\tasks.ps1 -Install：注册 18 个定时行为）' }
} else {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $APP 'bin\xiaoyu.ps1') restart
  if (Test-Port 8765) {
    Write-Host '  ⚠️ 8765 已被占用（可能是旧面板），跳过打开；先关掉它再点「小鱼管家」。' -ForegroundColor Yellow
  } else {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $APP 'bin\xiaoyu.ps1') gui
  }
  if (-not $NoTasks) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $APP 'bin\tasks.ps1') -Install *> $null
    Write-Host '  ✅ 定时行为已注册（bin\tasks.ps1 -List 可查看）' -ForegroundColor Green
  }
}

# ── 6. 收尾 ────────────────────────────────────────────────────────────────
Step '6/6' '完成'
Write-Host "  程序目录：$APP"
Write-Host '  管家面板：http://127.0.0.1:8765/setup'
if ($first -and $first.paired) {
  Write-Host '  已认主，直接去面板看她的状态就行。' -ForegroundColor Green
} elseif ($first -and $first.pairing) {
  Write-Host ("  还差一步：用你的 QQ 私聊她，发送 {0}" -f $first.pairing.code) -ForegroundColor Yellow
} else {
  Write-Host '  打开面板 → 首次设置 → 按提示完成。' -ForegroundColor Yellow
}
Write-Host ''
