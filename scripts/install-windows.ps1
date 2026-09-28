# Runs Nova in the background for the current Windows user. No admin rights.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1              install or repair, then (re)start Nova
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Stop        stop Nova (it starts again at next sign-in)
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Uninstall   stop Nova and remove the autostart
#
# A scheduled task named "Nova" starts server\launcher.js --keep-alive --log with no window
# (conhost --headless) when you sign in, in your own session, so mapped drives and your
# network credentials work. The launcher restarts the server after a crash; the task also
# runs every 5 minutes, which does nothing while Nova is running (IgnoreNew) and brings the
# launcher back if it has stopped. If company policy blocks creating tasks, a shortcut in
# the Startup folder is used instead: it starts Nova at sign-in, without the 5-minute check.
# Output goes to data\logs\nova.log. Safe to run again: it replaces what it made before.
param([switch]$Uninstall, [switch]$Stop)
$ErrorActionPreference = 'Stop'

$App = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $App 'server\launcher.js'
$TaskName = 'Nova'
$Shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Nova.lnk'
$Conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$DataDir = if ($env:NOVA_DATA_DIR) { $env:NOVA_DATA_DIR } else { Join-Path $App 'data' }

# The task's own process is conhost; the launcher (and the server under it) are found by
# the full launcher path in their command line. A copy started by hand with npm start uses a
# relative path, so it's left alone, and the start below refuses to run beside it.
function Stop-Nova {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $running = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($Launcher, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  foreach ($p in $running) { & taskkill.exe /PID $p.ProcessId /T /F | Out-Null }
  if ($running.Count) { Start-Sleep -Seconds 1 } # let the port close
  return $running.Count
}

function Test-Up($url) {
  try { return [bool](Invoke-RestMethod "$url/api/health" -TimeoutSec 2).ok } catch { return $false }
}

function Get-Port {
  try { $port = (Get-Content (Join-Path $DataDir 'config.json') -Raw | ConvertFrom-Json).server.port } catch { $port = $null }
  if ($port) { return $port } else { return 8484 }
}

if ($Stop -or $Uninstall) {
  $n = Stop-Nova
  Write-Host $(if ($n) { 'Nova stopped.' } else { 'Nova wasn''t running.' })
  if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item $Shortcut -ErrorAction SilentlyContinue
    Write-Host 'Nova no longer starts when you sign in. Your data folder is untouched.'
  }
  exit 0
}

# Checks before changing anything.
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js isn''t on PATH. Install Node 22.13 or later (24 LTS recommended), then run this again.' }
$version = [version]((& $node -v).TrimStart('v'))
if ($version -lt [version]'22.13.0') { throw "Nova needs Node 22.13 or later, and this is $version. Update Node, then run this again." }
if (-not (Test-Path (Join-Path $App 'node_modules\@anthropic-ai\claude-agent-sdk'))) {
  throw "Nova's packages aren't installed. Run npm install in $App, then run this again."
}
if (-not (Test-Path $Conhost)) { throw "$Conhost is missing, so Nova can't run without a window on this version of Windows." }

# The full path to node.exe, so the task doesn't depend on PATH at sign-in. Re-run this
# after moving or upgrading Node to a different folder.
$arguments = "--headless `"$node`" `"$Launcher`" --keep-alive --log"
$user = "$env:USERDOMAIN\$env:USERNAME"
$mode = $null
try {
  $action = New-ScheduledTaskAction -Execute $Conhost -Argument $arguments -WorkingDirectory $App
  $atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
  $every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5)
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $atLogon, $every5 -Settings $settings -Principal $principal `
    -Description "Runs Nova ($App) in the background. Made by scripts\install-windows.ps1." -Force | Out-Null
  Remove-Item $Shortcut -ErrorAction SilentlyContinue
  $mode = 'task'
} catch {
  Write-Warning "Couldn't create the scheduled task ($($_.Exception.Message)). Using a Startup folder shortcut instead."
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($Shortcut)
  $lnk.TargetPath = $Conhost
  $lnk.Arguments = $arguments
  $lnk.WorkingDirectory = $App
  $lnk.WindowStyle = 7 # minimised, in case conhost ever shows anything
  $lnk.Description = 'Starts Nova in the background.'
  $lnk.Save()
  $mode = 'shortcut'
}

# (Re)start now, so a re-run picks up a new Node or a changed script.
$url = "http://127.0.0.1:$(Get-Port)"
Stop-Nova | Out-Null
if (Test-Up $url) {
  throw "Something else is already answering at $url, probably Nova started with npm start. Stop it (Ctrl+C in its window), then run this again. The autostart is set up either way."
}
if ($mode -eq 'task') { Start-ScheduledTask -TaskName $TaskName }
else { Start-Process -FilePath $Conhost -ArgumentList $arguments -WorkingDirectory $App -WindowStyle Hidden }

$up = $false
for ($i = 0; $i -lt 60 -and -not $up; $i++) { Start-Sleep -Milliseconds 500; $up = Test-Up $url }
if (-not $up) { throw "Nova didn't answer at $url within 30 seconds. See $(Join-Path $DataDir 'logs\nova.log')." }
Write-Host "Nova is running at $url and will start again whenever you sign in$(if ($mode -eq 'task') { ', with a check every 5 minutes' })."
Write-Host "Log: $(Join-Path $DataDir 'logs\nova.log')"
