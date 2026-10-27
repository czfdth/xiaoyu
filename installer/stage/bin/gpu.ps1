<#
小鱼 · GPU 模式切换（手动）
她唱歌/说话/画图会抢显存，切之前先把对面那个停掉。

  .\gpu.ps1 -Mode voice   停 ComfyUI（8188），给声音让路
  .\gpu.ps1 -Mode draw    停 GPT-SoVITS（9880），给画图让路
  .\gpu.ps1 -Mode idle    只报告，不动手

只停进程，不负责启动；启动仍走面板「启动全部」或引擎自己的脚本。
#>
param([ValidateSet('voice', 'draw', 'idle')][string]$Mode = 'idle')

$ports = @{ tts = 9880; comfyui = 8188 }

function Get-PortPid([int]$port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
    return [int]$c.OwningProcess
  } catch { return 0 }
}

function Stop-Engine([string]$name, [int]$port) {
  $target = Get-PortPid $port
  if (-not $target) { Write-Host "  $name 没在跑（$port）" -ForegroundColor DarkGray; return }
  Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
  Write-Host "  已停 $name（PID $target，端口 $port）" -ForegroundColor Yellow
}

Write-Host ''
Write-Host "GPU 模式：$Mode" -ForegroundColor Cyan
switch ($Mode) {
  'voice' { Stop-Engine 'ComfyUI' $ports.comfyui }
  'draw'  { Stop-Engine 'GPT-SoVITS' $ports.tts }
  'idle'  {
    foreach ($item in @(@('声音', $ports.tts), @('画图', $ports.comfyui))) {
      $target = Get-PortPid $item[1]
      Write-Host ("  {0}：{1}" -f $item[0], $(if ($target) { "在跑（PID $target）" } else { '没跑' }))
    }
  }
}
Write-Host ''
$stateDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'state'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
Set-Content (Join-Path $stateDir 'gpu-mode.txt') $Mode -Encoding UTF8
