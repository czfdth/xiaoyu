<#
小鱼 · 安装（便携版，无需管理员）
用法：右键「使用 PowerShell 运行」，或
      powershell -ExecutionPolicy Bypass -File install.ps1

安装到 %LOCALAPPDATA%\xiaoyu（可用 -Dest 指定别处）。
升级时保留 state\（她的记忆）和 config.json；程序文件整体覆盖。
#>
param(
  [string]$Dest,
  [switch]$NoAutostart,
  [switch]$NoShortcuts
)

$ErrorActionPreference = 'Stop'
$SRC = $PSScriptRoot
$DST = if ($Dest) { [IO.Path]::GetFullPath($Dest) } else { Join-Path $env:LOCALAPPDATA 'xiaoyu' }
$NODE = (Get-Command node -ErrorAction SilentlyContinue).Source
$START = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'

Write-Host ''
Write-Host '=== 小鱼 · 安装 ===' -ForegroundColor Cyan
Write-Host "从: $SRC"
Write-Host "到: $DST"

if (-not $NODE) {
  Write-Host '❌ 没找到 node。先装 Node.js 22+：https://nodejs.org/ 然后重跑。' -ForegroundColor Red
  exit 1
}

# 1) 程序文件（整体覆盖；state/config/logs 不在列表里，升级不会被冲掉）
if (Test-Path $DST) {
  Write-Host '  已存在，覆盖程序文件（保留 state 与 config.json）' -ForegroundColor DarkGray
} else {
  New-Item -ItemType Directory -Force -Path $DST | Out-Null
}
$copied = @()
$srcFull = [IO.Path]::GetFullPath($SRC).TrimEnd('\')
$dstFull = [IO.Path]::GetFullPath($DST).TrimEnd('\')
if ($srcFull -eq $dstFull) {
  Write-Host '  就在安装目录里运行：跳过复制，只做初始化' -ForegroundColor Yellow
} else {
  foreach ($d in 'src','bin','gui','roles','dsh','plugins','public','assets','scripts','images','audio','node_modules','docs','tests','pet') {
    $s = Join-Path $SRC $d
    if (-not (Test-Path $s)) { continue }
    $target = Join-Path $DST $d
    if (Test-Path $target) {
      # 目录已存在（升级）：拷「里面的内容」。直接 Copy-Item 目录会套一层 gui\gui。
      Get-ChildItem $s -Force | ForEach-Object { Copy-Item $_.FullName $target -Recurse -Force }
    } else {
      Copy-Item $s $target -Recurse -Force
    }
    $copied += $d
  }
  foreach ($f in 'package.json','package-lock.json','RELEASE.md','THIRD-PARTY-NOTICES.md','config.example.json','README.md','LICENSE','install.ps1','一键部署.bat','启动她.bat','停止她.bat','打开管家.bat','查看状态.bat') {
    $s = Join-Path $SRC $f
    if (Test-Path $s) { Copy-Item $s (Join-Path $DST $f) -Force; $copied += $f }
  }
}
Write-Host ("  已复制: " + ($copied -join ' ')) -ForegroundColor DarkGray

# 2) 首次运行：建 state/logs + 按模板生成 config.json（含引擎路径探测）
Push-Location $DST
try {
  $first = -not (Test-Path (Join-Path $DST 'config.json'))
  & $NODE (Join-Path $DST 'src\paths.js') --init | Out-Host
  if ($first) {
    Write-Host '  已生成 config.json —— 打开它填 ownerQQ / allow / snowluma.accessToken' -ForegroundColor Yellow
  } else {
    Write-Host '  已有 config.json，保持原样' -ForegroundColor DarkGray
  }
} finally {
  Pop-Location
}

if (-not $NoShortcuts) {
# 3) 快捷方式
$ws = New-Object -ComObject WScript.Shell
function New-Shortcut($path, $target, $argLine, $desc) {
  $s = $ws.CreateShortcut($path)
  $s.TargetPath = $target
  $s.Arguments = $argLine
  $s.WorkingDirectory = $DST
  $s.Description = $desc
  $s.Save()
}
New-Shortcut (Join-Path $START '小鱼管家.lnk') 'powershell.exe' `
  "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $DST 'bin\xiaoyu.ps1')`" gui" '小鱼管家面板'
New-Shortcut (Join-Path $START '小鱼启动.lnk') 'powershell.exe' `
  "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $DST 'bin\start-all.ps1')`"" '启动全部服务'
New-Shortcut (Join-Path $START '小鱼状态.lnk') 'powershell.exe' `
  "-NoProfile -Command `"node '$(Join-Path $DST 'bin\status.mjs')'; pause`"" '查看状态'

# 桌面也放一个（开始菜单有，但新用户第一眼找的是桌面）
$desktop = [Environment]::GetFolderPath('Desktop')
if ($desktop) {
  New-Shortcut (Join-Path $desktop '小鱼.lnk') 'powershell.exe' `
    "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $DST 'bin\xiaoyu.ps1')`" gui" '小鱼管家面板'
}

}
# 4) 开机自启（可选）
if (-not $NoAutostart) {
  $run = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $true)
  $run.SetValue('Xiaoyu', "powershell.exe -NoProfile -WindowStyle Hidden -File `"$(Join-Path $DST 'bin\start-all.ps1')`" -WithGui -Watchdog -NoGatewayWait -Fast -Quiet")
  $run.Close()
  Write-Host '  开机自启：已开启（含管家面板与看门狗）' -ForegroundColor DarkGray
}

# 5) 卸载脚本（保留她的记忆，除非 -Purge）
$uninstall = @"
# 卸载小鱼（保留 state 里的记忆，除非加 -Purge）
param([switch]`$Purge)
`$dst = '$DST'
Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { `$_.CommandLine -like '*xiaoyu*' -or `$_.CommandLine -like "*`$dst*" } |
  ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name Xiaoyu -ErrorAction SilentlyContinue
Get-ChildItem (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs') -Filter '小鱼*.lnk' -ErrorAction SilentlyContinue | Remove-Item -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) '小鱼.lnk') -Force -ErrorAction SilentlyContinue
Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { `$_.TaskName -like 'xiaoyu-*' } |
  Unregister-ScheduledTask -Confirm:`$false -ErrorAction SilentlyContinue
if (`$Purge) { Remove-Item `$dst -Recurse -Force; Write-Host '已完全删除（含记忆）' }
else {
  Get-ChildItem `$dst | Where-Object { `$_.Name -notin 'state','config.json' } | Remove-Item -Recurse -Force
  Write-Host '已卸载，记忆保留在' `$dst
}
"@
[IO.File]::WriteAllText((Join-Path $DST 'uninstall.ps1'), $uninstall, (New-Object Text.UTF8Encoding($true)))

Write-Host ''
Write-Host '✅ 安装完成' -ForegroundColor Green
Write-Host "   程序目录: $DST"
Write-Host '   开始菜单: 小鱼管家 / 小鱼启动 / 小鱼状态'
Write-Host "   填配置:   $DST\config.json（ownerQQ / allow / snowluma.accessToken）"
Write-Host "   卸载:     powershell -File `"$DST\uninstall.ps1`"" -ForegroundColor DarkGray
Write-Host ''
