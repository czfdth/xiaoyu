<#
小鱼 · 本地语音识别服务（ASR，127.0.0.1:9881）
QQ 语音转写拿不到时，桥接会退回这里做本地识别。
计划任务只需要把它拉起来一次；它自己常驻。

用法：
  .\asr-start.ps1            # 没在跑就起
  .\asr-start.ps1 -Check     # 只报告
#>
param([switch]$Check)

$ROOT = Split-Path -Parent $PSScriptRoot
$NODE = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NODE) { exit 1 }

$raw = (& $NODE (Join-Path $ROOT 'src\paths.js') --init --json 2>$null) -join "`n"
$P = $raw | ConvertFrom-Json
$port = 9881

$up = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($Check) { Write-Host ("ASR {0}" -f $(if ($up) { '在线' } else { '不在' })); exit 0 }
if ($up) { exit 0 }

$python = $P.engines.gptSovits.python
$script = Join-Path $P.codeRoot 'scripts\asr_server.py'
if (-not $python -or -not (Test-Path $script)) {
  Add-Content -Path (Join-Path $P.dirs.logs 'asr.log') -Value ("[{0}] 缺少 python 或 asr_server.py，跳过" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8
  exit 1
}

Start-Process -FilePath $python -ArgumentList $script, "$port" `
  -WorkingDirectory $P.root -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $P.dirs.logs 'asr.out.log') `
  -RedirectStandardError (Join-Path $P.dirs.logs 'asr.err.log') | Out-Null
