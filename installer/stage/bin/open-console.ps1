# 打开管家：优先用 Edge 的 --app 模式（没有地址栏、没有标签页，看起来就是个独立窗口）。
# 找不到 Edge 就退回默认浏览器——功能一样，只是多了浏览器的框。

param(
  [string]$Url = 'http://127.0.0.1:8765',
  [int]$WaitSeconds = 25
)

# 等控制台起来，别让用户看到"无法访问此网站"
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  try {
    $probe = Invoke-WebRequest -Uri "$Url/api/health" -UseBasicParsing -TimeoutSec 2
    if ($probe.StatusCode -eq 200) { break }
  } catch { Start-Sleep -Milliseconds 600 }
}

$edgeCandidates = @(
  (Join-Path ${env:ProgramFiles} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path $_) }

$edge = $edgeCandidates | Select-Object -First 1
if ($edge) {
  # --app 让窗口没有浏览器 UI；再给一个合适的初始尺寸
  Start-Process -FilePath $edge -ArgumentList @("--app=$Url", '--window-size=1280,860')
} else {
  # 没装 Edge（很少见）就退回默认浏览器
  Start-Process $Url
}
