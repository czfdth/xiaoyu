param(
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [Parameter(Mandatory=$true)][string]$RuntimeRoot,
  [Parameter(Mandatory=$true)][string]$EvidenceDir
)
$ErrorActionPreference = 'Stop'
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$RuntimeRoot = (Resolve-Path -LiteralPath $RuntimeRoot).Path
if ($SourceRoot -eq $RuntimeRoot) { throw 'Source and runtime must differ' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $RuntimeRoot ('backups\program-update-' + $stamp)
New-Item -ItemType Directory -Path $backup -Force | Out-Null
New-Item -ItemType Directory -Path $EvidenceDir -Force | Out-Null
$files = @('src/wake-guidance.js','src/sticker-lib.js','src/agency.js','src/situation.js','src/continuity.js','src/adaptive-tools.js','src/delivery-guard.js','src/experience-learning.js','src/drawing-fallback.js','scripts/sketch_render.py','src/project-workflow.js','src/reality.js','src/state-store.js','src/memory-attribution.js','src/memory-extraction.js','src/commitments.js',
  'src/autonomy.js','src/deliveries.js','src/paths.js','scripts/extract-memory.mjs',
  'scripts/proactive-nudge.mjs','scripts/life-wake.mjs','src/bridge.js','src/mcp-snowluma-safe.js')
function Runtime-Path([string]$relative) {
  $full = [IO.Path]::GetFullPath((Join-Path $RuntimeRoot $relative))
  if (-not $full.StartsWith($RuntimeRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Target escapes runtime root' }
  return $full
}
foreach ($file in $files) {
  if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot $file) -PathType Leaf)) { throw ('Missing source: ' + $file) }
  Runtime-Path $file | Out-Null
}
function Protected-Hashes {
  $paths = @((Runtime-Path 'config.json'), (Runtime-Path 'state/backup-key'), (Runtime-Path 'state/projects.json'))
  foreach ($folder in @('roles','images','audio','state/memory')) {
    $dir = Runtime-Path $folder
    if (Test-Path -LiteralPath $dir) { $paths += @(Get-ChildItem -LiteralPath $dir -Recurse -File | ForEach-Object FullName) }
  }
  $rows = @{}
  foreach ($file in $paths) {
    if (Test-Path -LiteralPath $file -PathType Leaf) { $rows[$file.Substring($RuntimeRoot.Length + 1)] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
  }
  return $rows
}
$tasks = @(Get-ScheduledTask -TaskName 'xiaoyu-*' | Where-Object { $_.State -ne 'Disabled' })
$tasks | Select-Object TaskName,TaskPath | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'enabled-tasks.json') -Encoding UTF8
$watchdogWasRunning = $false
$watchdogFlags = @()
$runtimeCfg = Get-Content -LiteralPath (Runtime-Path 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$port = if ($runtimeCfg.consolePort) { [int]$runtimeCfg.consolePort } else { 3100 }
$token = (Get-Content -LiteralPath (Runtime-Path 'state/console-token') -Raw).Trim()
if ($runtimeCfg.consoleToken -match '^[A-Za-z0-9_-]{16,128}$') { $token = $runtimeCfg.consoleToken }
$headers = @{'x-console-token'=$token;'content-type'='application/json'}
$changed = @()
$success = $false
$bridgeStopped = $false
$node = (Get-Command node).Source
function Start-Bridge {
  Start-Process -FilePath $node -ArgumentList 'src/bridge.js' -WorkingDirectory $RuntimeRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $RuntimeRoot ('logs\bridge-update-' + $stamp + '.out.log')) `
    -RedirectStandardError (Join-Path $RuntimeRoot ('logs\bridge-update-' + $stamp + '.err.log')) | Out-Null
  for ($i=0; $i -lt 50; $i++) {
    try { return Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/status') -Headers $headers -TimeoutSec 2 } catch { Start-Sleep -Milliseconds 200 }
  }
  throw 'Updated bridge did not become healthy'
}
try {
  foreach ($task in $tasks) { Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath | Out-Null }
  $watchdogFile = Runtime-Path 'state/watchdog.lock'
  if (Test-Path -LiteralPath $watchdogFile) {
    $wid = 0
    [int]::TryParse((Get-Content -LiteralPath $watchdogFile -Raw).Trim(), [ref]$wid) | Out-Null
    $worker = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $wid) -ErrorAction SilentlyContinue
    if ($worker) {
      if ($worker.CommandLine -notmatch [regex]::Escape((Runtime-Path 'bin/watchdog.ps1'))) { throw 'Watchdog PID does not match runtime' }
      foreach ($flag in @('-WithGui','-WithEngines','-Quiet')) { if ($worker.CommandLine -match [regex]::Escape($flag)) { $watchdogFlags += $flag } }
      Stop-Process -Id $wid -ErrorAction Stop
      $watchdogWasRunning = $true
    }
  }
  $oldPid = [int](Get-Content -LiteralPath (Runtime-Path 'state/bridge.lock') -Raw).Trim()
  $oldBridge = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $oldPid)
  if (-not $oldBridge -or $oldBridge.Name -ne 'node.exe' -or $oldBridge.CommandLine -notmatch 'src[\\/]bridge\.js') { throw 'Bridge PID does not match' }
  Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/restart') -Method POST -Headers $headers -Body '{}' -TimeoutSec 5 | Out-Null
  for ($i=0; $i -lt 50 -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }
  if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) { throw 'Bridge did not stop gracefully' }
  $bridgeStopped = $true
  $before = Protected-Hashes
  foreach ($entry in @('state','roles','config.json','companion.json')) {
    $from = Runtime-Path $entry
    if (Test-Path -LiteralPath $from) {
      $dataBackup = Join-Path $backup 'data'
      New-Item -ItemType Directory -Path $dataBackup -Force | Out-Null
      Copy-Item -LiteralPath $from -Destination $dataBackup -Recurse -Force
    }
  }
  foreach ($file in $files) {
    $target = Runtime-Path $file
    $saved = Join-Path $backup ('code\' + $file)
    if (Test-Path -LiteralPath $target) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
      Copy-Item -LiteralPath $target -Destination $saved
    }
    $changed += $file
    $temp = $target + '.incoming-' + $stamp
    Copy-Item -LiteralPath (Join-Path $SourceRoot $file) -Destination $temp
    Move-Item -LiteralPath $temp -Destination $target -Force
    if ((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath (Join-Path $SourceRoot $file)).Hash) { throw ('Code hash mismatch: ' + $file) }
  }
  $status = Start-Bridge
  # Restart only this MCP stdio worker. Installed dsh-mcp-client supervises/reconnects it.
  $mcpScript = Runtime-Path 'src/mcp-snowluma-safe.js'
  $oldMcp = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape($mcpScript) })
  foreach ($worker in $oldMcp) { Stop-Process -Id $worker.ProcessId }
  $newMcp = @()
  for ($i=0; $i -lt 50; $i++) {
    $newMcp = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape($mcpScript) -and $_.ProcessId -notin @($oldMcp.ProcessId) })
    if ($newMcp.Count -gt 0) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($oldMcp.Count -gt 0 -and $newMcp.Count -eq 0) { throw 'DSH did not reconnect the QQ tool worker' }
  $after = Protected-Hashes
  $mismatch = @($before.Keys | Where-Object { $before[$_] -ne $after[$_] })
  if ($mismatch.Count) { throw ('Protected data changed during deployment: ' + ($mismatch -join ', ')) }
  $manifest = @($files | ForEach-Object { @{path=$_;sha256=(Get-FileHash -LiteralPath (Runtime-Path $_)).Hash} })
  $report = @{backup=$backup;protectedFiles=$before.Count;protectedUnchanged=$true;code=$manifest;
    oldBridgePid=$oldPid;newBridgePid=[int](Get-Content -LiteralPath (Runtime-Path 'state/bridge.lock') -Raw).Trim();
    oldMcpPids=@($oldMcp.ProcessId);newMcpPids=@($newMcp.ProcessId);mode=$status.mode;dshReady=$status.dshReady;qqConnected=$status.snowluma.connected}
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $EvidenceDir ('deployment-' + $stamp + '.json')) -Encoding UTF8
  $success = $true
  Write-Output ('SYNC_OK files=' + $files.Count + ' protected=' + $before.Count + ' qqConnected=' + $status.snowluma.connected)
  Write-Output ('BACKUP=' + $backup)
} catch {
  $failure = $_
  if ($changed.Count -gt 0) {
    try { Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/restart') -Method POST -Headers $headers -Body '{}' -TimeoutSec 3 | Out-Null; Start-Sleep -Seconds 1 } catch { }
    foreach ($file in $changed) {
      $saved = Join-Path $backup ('code\' + $file)
      $target = Runtime-Path $file
      if (Test-Path -LiteralPath $saved) { Copy-Item -LiteralPath $saved -Destination $target -Force }
      elseif (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    }
    try { Start-Bridge | Out-Null } catch { }
    $mcpScript = Runtime-Path 'src/mcp-snowluma-safe.js'
    Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape($mcpScript) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
  } elseif ($bridgeStopped) { try { Start-Bridge | Out-Null } catch { } }
  throw $failure
} finally {
  foreach ($task in $tasks) { Enable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath | Out-Null }
  if ($watchdogWasRunning) {
    Start-Process -FilePath 'powershell.exe' -ArgumentList (@('-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',('"' + (Runtime-Path 'bin/watchdog.ps1') + '"')) + $watchdogFlags) `
      -WorkingDirectory $RuntimeRoot -WindowStyle Hidden | Out-Null
  }
  if (-not $success) { Write-Output ('Update failed; original code backup: ' + $backup) }
}
