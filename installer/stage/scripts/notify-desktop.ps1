param(
  [string]$Title = '小鱼',
  [string]$Text = 'QQ 网关掉线了'
)
# Windows 气泡通知（不依赖第三方模块，用 WinForms 的托盘气泡）
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.BalloonTipTitle = $Title
$notify.BalloonTipText = $Text
$notify.Visible = $true
$notify.ShowBalloonTip(10000)
Start-Sleep -Seconds 12
$notify.Dispose()
