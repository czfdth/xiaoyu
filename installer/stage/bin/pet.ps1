<#
小鱼 · 状态挂件（桌面置顶小窗，不依赖 Electron）
左侧循环播放动作，右侧实时显示她此刻：心情 · 在做 · 惦记 · 网关/大脑/DSH。

动作素材来自 dsh-pet（MIT License, Copyright (c) 2026 PC2005-cloud）：
https://github.com/PC2005-cloud/dsh-pet
已转成 GIF 放在 <程序目录>\pet\actions\；点动画或右键可换下一个。

用法：
  .\pet.ps1
右键：下一个动作 / 刷新 / 打开面板 / 关闭。拖动可换位置。
#>
param(
  [int]$Port = 8765,
  [int]$IntervalSeconds = 4,
  [int]$ActionSeconds = 9
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$ROOT = Split-Path -Parent $PSScriptRoot
$base = "http://127.0.0.1:$Port"
$stateDir = Join-Path $ROOT 'state'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$lockFile = Join-Path $stateDir 'pet.lock'

if (Test-Path $lockFile) {
  $old = (Get-Content $lockFile -Raw -ErrorAction SilentlyContinue)
  if ($old) { $old = $old.Trim() }
  if ($old -and (Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue)) { exit 0 }
}
Set-Content $lockFile $PID

$bg = [System.Drawing.Color]::FromArgb(13, 17, 23)
$panelBg = [System.Drawing.Color]::FromArgb(22, 27, 34)
$fg = [System.Drawing.Color]::FromArgb(230, 237, 243)
$muted = [System.Drawing.Color]::FromArgb(139, 148, 158)
$accent = [System.Drawing.Color]::FromArgb(79, 209, 197)
$okColor = [System.Drawing.Color]::FromArgb(63, 185, 80)
$badColor = [System.Drawing.Color]::FromArgb(248, 81, 73)

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.Width = 386
$form.Height = 196
$form.BackColor = $bg
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Left = $area.Right - $form.Width - 24
$form.Top = $area.Top + 48

$stage = New-Object System.Windows.Forms.PictureBox
$stage.Left = 10; $stage.Top = 8; $stage.Width = 112; $stage.Height = 132
$stage.SizeMode = 'Zoom'
$stage.BackColor = $panelBg
$stage.Cursor = 'Hand'
$form.Controls.Add($stage)

$actionName = New-Object System.Windows.Forms.Label
$actionName.Left = 8; $actionName.Top = 146; $actionName.Width = 116; $actionName.Height = 20
$actionName.Text = ''; $actionName.ForeColor = $muted; $actionName.TextAlign = 'MiddleCenter'
$actionName.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)
$form.Controls.Add($actionName)

$name = New-Object System.Windows.Forms.Label
$name.Left = 134; $name.Top = 8; $name.Width = 120; $name.Height = 24
$name.Text = '小鱼'; $name.ForeColor = $fg
$name.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($name)

$mood = New-Object System.Windows.Forms.Label
$mood.Left = 246; $mood.Top = 11; $mood.Width = 130; $mood.Height = 20
$mood.Text = '…'; $mood.ForeColor = $accent
$mood.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.Controls.Add($mood)

$doing = New-Object System.Windows.Forms.Label
$doing.Left = 134; $doing.Top = 36; $doing.Width = 240; $doing.Height = 44
$doing.Text = '正在读她的状态…'; $doing.ForeColor = $fg
$doing.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.Controls.Add($doing)

$think = New-Object System.Windows.Forms.Label
$think.Left = 134; $think.Top = 84; $think.Width = 240; $think.Height = 40
$think.Text = ''; $think.ForeColor = $muted
$think.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)
$form.Controls.Add($think)

$dots = @{}
$labels = @{ gateway = '网关'; bridge = '大脑'; dsh = 'DSH' }
$left = 136
foreach ($key in 'gateway','bridge','dsh') {
  $dot = New-Object System.Windows.Forms.Panel
  $dot.Left = $left; $dot.Top = 160; $dot.Width = 7; $dot.Height = 7
  $dot.BackColor = $muted
  $form.Controls.Add($dot)
  $dots[$key] = $dot
  $lbl = New-Object System.Windows.Forms.Label
  $lbl.Left = $left + 10; $lbl.Top = 154; $lbl.Width = 40; $lbl.Height = 18
  $lbl.Text = $labels[$key]; $lbl.ForeColor = $muted
  $lbl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)
  $form.Controls.Add($lbl)
  $left += 66
}

$hint = New-Object System.Windows.Forms.Label
$hint.Left = 300; $hint.Top = 156; $hint.Width = 78; $hint.Height = 18
$hint.Text = '右键菜单'; $hint.ForeColor = $muted; $hint.TextAlign = 'MiddleRight'
$hint.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 7)
$form.Controls.Add($hint)

# 拖动
$script:drag = $false
$script:dx = 0
$script:dy = 0
$form.Add_MouseDown({ $script:drag = $true; $script:dx = $_.X; $script:dy = $_.Y })
$form.Add_MouseUp({ $script:drag = $false })
$form.Add_MouseMove({
  if ($script:drag) { $form.Left = [System.Windows.Forms.Cursor]::Position.X - $script:dx; $form.Top = [System.Windows.Forms.Cursor]::Position.Y - $script:dy }
})

# 动作 GIF
$script:actions = @()
$actDir = Join-Path $ROOT 'pet\actions'
if (Test-Path $actDir) { $script:actions = @(Get-ChildItem $actDir -File -Filter '*.gif' | Sort-Object Name) }
$script:lastIndex = -1

function Show-NextAction {
  if (-not $script:actions.Count) { return }
  $idx = $script:lastIndex
  if ($script:actions.Count -gt 1) {
    while ($idx -eq $script:lastIndex) { $idx = Get-Random -Minimum 0 -Maximum $script:actions.Count }
  } else { $idx = 0 }
  $script:lastIndex = $idx
  $file = $script:actions[$idx]
  try {
    if ($stage.Image) { $stage.Image.Dispose() }
    $stage.Image = [System.Drawing.Image]::FromFile($file.FullName)
    $actionName.Text = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
  } catch { /* 读不了就跳过 */ }
}

# 状态
function Set-Dot($key, $okValue) { $dots[$key].BackColor = if ($okValue) { $okColor } else { $badColor } }

function Update-State {
  try {
    $o = Invoke-RestMethod "$base/api/overview" -TimeoutSec 4
    $her = $o.her
    $name.Text = if ($her.role) { [string]$her.role } else { '小鱼' }
    $m = if ($her.mood.mood) { $her.mood.mood } elseif ($her.inner.mood) { $her.inner.mood } else { '—' }
    $mood.Text = '· ' + $m
    $doing.Text = '在做：' + (($her.inner.doing) -replace '\s+', ' ')
    $parts = @()
    if ($her.inner.thinking) { $parts += '在想：' + $her.inner.thinking }
    if ($her.inner.worrying) { $parts += '惦记：' + $her.inner.worrying }
    $think.Text = ($parts -join '  ·  ')
    Set-Dot 'gateway' ([bool]$o.ports.gateway)
    Set-Dot 'bridge' ([bool]$o.ports.bridge)
    Set-Dot 'dsh' ([bool]$o.dsh.ok)
  } catch {
    $doing.Text = '面板没开：' + $base
    $think.Text = '（启动 打开管家.bat 后我会自己回来）'
    Set-Dot 'gateway' $false
    Set-Dot 'bridge' $false
    Set-Dot 'dsh' $false
  }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miNext = $menu.Items.Add('下一个动作')
$miNext.Add_Click({ Show-NextAction })
$miRefresh = $menu.Items.Add('刷新状态')
$miRefresh.Add_Click({ Update-State })
$miPanel = $menu.Items.Add('打开管家面板')
$miPanel.Add_Click({ Start-Process $base })
$miClose = $menu.Items.Add('关闭挂件')
$miClose.Add_Click({ $form.Close() })
$form.ContextMenuStrip = $menu
$stage.Add_Click({ Show-NextAction })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(2000, $IntervalSeconds * 1000)
$timer.Add_Tick({ Update-State })
$timer.Start()

$actionTimer = New-Object System.Windows.Forms.Timer
$actionTimer.Interval = [Math]::Max(4000, $ActionSeconds * 1000)
$actionTimer.Add_Tick({ Show-NextAction })
$actionTimer.Start()

$form.Add_Shown({ Update-State; Show-NextAction })
$form.Add_FormClosed({
  $timer.Stop(); $actionTimer.Stop()
  if ($stage.Image) { $stage.Image.Dispose() }
  Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
})
[System.Windows.Forms.Application]::Run($form)
