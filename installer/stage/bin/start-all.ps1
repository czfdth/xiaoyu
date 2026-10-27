<#
小鱼 · 一键启动
按依赖顺序拉起：SnowLuma（QQ 网关）→ GPT-SoVITS（声音）→ ComfyUI（画图）→ bridge（大脑）

这个脚本里没有任何写死的盘符或用户名：
  · 目录、端口、引擎位置全部来自 src\paths.js（唯一路径来源）
  · 没装的引擎直接跳过，并告诉你去哪装，不算失败
  · SnowLuma 默认**不代你启动**（它是别人的专有组件，项目不变量 L6：只探测、不部署）；
    要它替你点一下，显式加 -StartGateway

用法：
  .\start-all.ps1                正常启动（SnowLuma 没开时会等你打开）
  .\start-all.ps1 -StartGateway  顺手替你打开 SnowLuma
  .\start-all.ps1 -NoEngines     只起 QQ 网关 + 大脑（不开声音/画图，省显存）
  .\start-all.ps1 -WithGui       顺手把管家面板也起起来（http://127.0.0.1:8765）
#>
param(
  [switch]$StartGateway,
  [switch]$NoEngines,
  [switch]$Fast,
  [switch]$Quiet,
  [switch]$DryRun,
  [switch]$WithGui,
  [switch]$Watchdog,
  [switch]$WithPet,
  [switch]$NoGatewayWait
)

$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
$NODE = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $NODE) {
  Write-Host '❌ 没找到 node。先装 Node.js 22+：https://nodejs.org/' -ForegroundColor Red
  exit 1
}

# ── 所有路径/端口/引擎：问 paths.js 要，脚本里不再自己拼 ──────────────────
$raw = (& $NODE (Join-Path $ROOT 'src\paths.js') --init --json 2>$null) -join "`n"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
  Write-Host '❌ 初始化失败：src\paths.js 跑不通（看它打印的错误）' -ForegroundColor Red
  exit 1
}
$P = $raw | ConvertFrom-Json

$LOG = $P.dirs.logs
$PORTS = $P.ports
$ENG = $P.engines
$gpuMode = 'idle'
try { $gpuMode = (Get-Content (Join-Path $P.dirs.state 'gpu-mode.txt') -Raw -ErrorAction SilentlyContinue).Trim() } catch { }
if (-not $gpuMode) { $gpuMode = 'idle' }
$wasMissingConfig = -not $P.configExists
New-Item -ItemType Directory -Force -Path $LOG | Out-Null

function Test-Port($p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Port($p, $name, $seconds = 90) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Test-Port $p) { Write-Host "  [OK]   $name ($p)" -ForegroundColor Green; return $true }
    Start-Sleep -Seconds 1
  }
  Write-Host "  [FAIL] $name ($p) 没起来，看 $LOG" -ForegroundColor Red
  return $false
}

function Say($msg, $color = 'Gray') { if (-not $Quiet) { Write-Host $msg -ForegroundColor $color } }

# -DryRun：只打印「会用什么路径、起什么、跳过什么」，不真的起进程（干净目录测试/排错用）
if ($DryRun) {
  Write-Host ''
  Write-Host '=== 小鱼 · 启动计划（dry-run）===' -ForegroundColor Cyan
  Write-Host "  包目录   $($P.root)"
  Write-Host "  配置     $($P.config)$(if ($P.configExists) { '' } else { '（不存在，--init 会生成）' })"
  Write-Host "  日志     $LOG"
  Write-Host "  端口     网关 $($PORTS.gateway) / WS $($PORTS.gatewayWs) / 声音 $($PORTS.tts) / 画图 $($PORTS.comfyui) / 大脑 $($PORTS.bridge)"
  Write-Host "  SnowLuma $($ENG.snowluma.home)$(if (-not $ENG.snowluma.home) { '（没装）' })"
  Write-Host "  声音     $($ENG.gptSovits.home)$(if (-not $ENG.gptSovits.home) { '（没装）' })"
  Write-Host "  画图     $($ENG.comfyui.home)$(if (-not $ENG.comfyui.home) { '（没装）' })"
  Write-Host "  大脑     $($P.root)\src\bridge.js"
  Write-Host '  （dry-run 不启动任何进程）'
  Write-Host ''
  exit 0
}

Write-Host ''
Write-Host '=== 小鱼 · 启动 ===' -ForegroundColor Cyan

# 1) SnowLuma（QQ 网关）
if (Test-Port $PORTS.gateway) {
  Say "  [SKIP] SnowLuma 已在跑 ($($PORTS.gateway))" DarkGray
} elseif (-not $ENG.snowluma.home) {
  Write-Host '  [MISS] 没找到 SnowLuma。装好后重跑，或自己打开它。' -ForegroundColor Yellow
} elseif ($StartGateway -and $ENG.snowluma.launcher) {
  Write-Host '  打开 SnowLuma（你显式要求）…'
  Start-Process -FilePath $ENG.snowluma.launcher -WorkingDirectory $ENG.snowluma.home -WindowStyle Minimized | Out-Null
  Wait-Port $PORTS.gateway 'SnowLuma' 120 | Out-Null
} else {
  Write-Host "  SnowLuma 没在跑，请自己打开：$($ENG.snowluma.launcher)" -ForegroundColor Yellow
  if ($NoGatewayWait) {
    Say '  [SKIP] -NoGatewayWait：不等网关，大脑会自己重连' DarkGray
  } else {
    Write-Host '  （不想手动点，下次加 -StartGateway；现在等你 60 秒…）' -ForegroundColor DarkGray
    Wait-Port $PORTS.gateway 'SnowLuma' 60 | Out-Null
  }
}

# 2) GPT-SoVITS（声音）
if ($gpuMode -eq 'draw') {
  Say '  [SKIP] 画图模式：声音先不开' DarkGray
} elseif ($Fast) {
  Say '  [SKIP] -Fast：先起大脑，声音交给看门狗' DarkGray
} elseif ($NoEngines) {
  Say '  [SKIP] -NoEngines：不动声音' DarkGray
} elseif (Test-Port $PORTS.tts) {
  Say "  [SKIP] GPT-SoVITS 已在跑 ($($PORTS.tts))" DarkGray
} elseif (-not $ENG.gptSovits.home) {
  Write-Host '  [MISS] 没找到 GPT-SoVITS（可选：她只会发文字）' -ForegroundColor Yellow
} elseif (-not $ENG.gptSovits.python) {
  Write-Host "  [MISS] GPT-SoVITS 目录在 $($ENG.gptSovits.home)，但没找到 runtime\python.exe" -ForegroundColor Yellow
} else {
  Write-Host '  启动 GPT-SoVITS…'
  Start-Process -FilePath $ENG.gptSovits.python `
    -ArgumentList 'api_v2.py', '-c', 'GPT_SoVITS/configs/tts_infer.yaml', '-a', '127.0.0.1', '-p', "$($PORTS.tts)" `
    -WorkingDirectory $ENG.gptSovits.home -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LOG 'tts.out.log') -RedirectStandardError (Join-Path $LOG 'tts.err.log') | Out-Null
  Wait-Port $PORTS.tts 'GPT-SoVITS' 120 | Out-Null
}

# 3) ComfyUI（画图，可选；显存紧就别开）
if ($gpuMode -ne 'draw' -and $env:XIAOYU_FORCE_COMFY -ne '1') {
  Say '  [SKIP] 非画图模式（要开：bin\gpu.ps1 -Mode draw）' DarkGray
} elseif ($Fast) {
  Say '  [SKIP] -Fast：不开画图' DarkGray
} elseif ($NoEngines -or $env:XIAOYU_SKIP_COMFY -eq '1') {
  Say '  [SKIP] 不开画图' DarkGray
} elseif (Test-Port $PORTS.comfyui) {
  Say "  [SKIP] ComfyUI 已在跑 ($($PORTS.comfyui))" DarkGray
} elseif (-not $ENG.comfyui.home) {
  Write-Host '  [MISS] 没找到 ComfyUI（可选：她画不了图）' -ForegroundColor Yellow
} elseif (-not $ENG.comfyui.python) {
  Write-Host "  [MISS] ComfyUI 目录在 $($ENG.comfyui.home)，但没找到它的 python" -ForegroundColor Yellow
} else {
  Write-Host '  启动 ComfyUI（可选，显存紧可以不开）…'
  $env:OMP_NUM_THREADS = '1'
  $env:OPENBLAS_NUM_THREADS = '1'
  Start-Process -FilePath $ENG.comfyui.python `
    -ArgumentList 'main.py', '--port', "$($PORTS.comfyui)", '--listen', '127.0.0.1', '--lowvram', '--disable-pinned-memory' `
    -WorkingDirectory $ENG.comfyui.home -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LOG 'comfy.out.log') -RedirectStandardError (Join-Path $LOG 'comfy.err.log') | Out-Null
  Wait-Port $PORTS.comfyui 'ComfyUI' 90 | Out-Null
}

# 4) bridge（大脑，最后起）
if (Test-Port $PORTS.bridge) {
  Say "  [SKIP] bridge 已在跑 ($($PORTS.bridge))" DarkGray
} else {
  Write-Host '  启动 bridge…'
  Start-Process -FilePath $NODE -ArgumentList 'src/bridge.js' -WorkingDirectory $P.root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LOG 'bridge.out.log') -RedirectStandardError (Join-Path $LOG 'bridge.err.log') | Out-Null
  Wait-Port $PORTS.bridge 'bridge' 60 | Out-Null
}

# 5) 管家面板（可选，-WithGui 才起）
if ($WithGui) {
  if (Test-Port $PORTS.gui) {
    Say "  [SKIP] 管家面板已在跑 ($($PORTS.gui))" DarkGray
  } else {
    Write-Host '  启动管家面板…'
    Start-Process -FilePath $NODE -ArgumentList 'gui/server.mjs' -WorkingDirectory $P.codeRoot -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $LOG 'console.out.log') -RedirectStandardError (Join-Path $LOG 'console.err.log') | Out-Null
    Wait-Port $PORTS.gui '管家面板' 30 | Out-Null
  }
}

# 6) 看门狗（可选，-Watchdog 才起）：只管大脑和面板，掉了自动拉
if ($Watchdog -and -not $DryRun) {
  $running = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'watchdog\.ps1' }
  if ($running) {
    Say '  [SKIP] 看门狗已在跑' DarkGray
  } else {
    Write-Host '  启动看门狗…'
    $watchArgs = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $P.codeRoot 'bin\watchdog.ps1'), '-WithGui', '-Quiet')
    if (-not $NoEngines) { $watchArgs += '-WithEngines' }
    Start-Process -FilePath 'powershell' -ArgumentList $watchArgs -WorkingDirectory $P.codeRoot -WindowStyle Hidden | Out-Null
  }
}

# 7) 桌宠（可选，-WithPet）
if ($WithPet -and -not $DryRun) {
  try {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($PORTS.gui)/api/desktop-pet/start" -TimeoutSec 25 | Out-Null
    Say '  桌宠已放到桌面' DarkGray
  } catch { Write-Host '  [WARN] 桌宠没起来（可稍后在面板点「放到桌面」）' -ForegroundColor Yellow }
}

# ── 结果 ──────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '=== 状态 ===' -ForegroundColor Cyan
$rows = @(
  @{ port = $PORTS.gateway;   name = 'QQ 网关' },
  @{ port = $PORTS.gatewayWs; name = 'QQ WebSocket' },
  @{ port = $PORTS.tts;       name = '声音' },
  @{ port = $PORTS.comfyui;   name = '画图' },
  @{ port = $PORTS.bridge;    name = '大脑' }
)
foreach ($r in $rows) {
  $mark = if (Test-Port $r.port) { '✅' } else { '❌' }
  Write-Host ("  {0} {1,-6} {2}" -f $mark, $r.port, $r.name)
}
Write-Host ''
Write-Host "配置：$($P.config)" -ForegroundColor DarkGray
Write-Host "日志：$LOG" -ForegroundColor DarkGray
if ($wasMissingConfig) {
  Write-Host '第一次运行已经生成了 config.json —— 还需要填 ownerQQ、allow、snowluma.accessToken。' -ForegroundColor Yellow
}
Write-Host '她在线吗：网关 ✅ + 大脑 ✅ 就是在跑；说她不动就看 logs\bridge.out.log' -ForegroundColor DarkGray
Write-Host ''
