# Installs or updates the "LinePort-Service-Recovery" scheduled task: run watchdog.ps1 at logon
# and every 5 minutes as the current user (no admin rights, no stored password).
# -DryRun prints the plan without copying files or touching Task Scheduler. -Uninstall removes the task.
param(
    [string]$LinePortHome = (Join-Path $env:LOCALAPPDATA 'LinePort'),
    [string]$TaskName = 'LinePort-Service-Recovery',
    [int]$IntervalMinutes = 5,
    [switch]$Uninstall,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'watchdog.ps1'
$target = Join-Path $LinePortHome 'watchdog.ps1'
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $target + '"'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name

if ($Uninstall) {
    if ($DryRun) { Write-Output "[dry-run] would unregister task $TaskName"; return }
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    Write-Output "Removed task $TaskName (watchdog.ps1 and logs were kept)."
    return
}
if (!(Test-Path -LiteralPath $source)) { throw 'watchdog.ps1 is missing next to this installer.' }
if ($DryRun) {
    Write-Output "[dry-run] would copy $source -> $target"
    Write-Output "[dry-run] would register task $TaskName for $user"
    Write-Output "[dry-run] triggers: AtLogOn; every $IntervalMinutes minutes"
    Write-Output "[dry-run] action: $shell $arguments"
    return
}
New-Item -ItemType Directory -Force -Path $LinePortHome | Out-Null
# A stable copy keeps the task valid after the versioned install folder is replaced.
Copy-Item -LiteralPath $source -Destination $target -Force
$action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $LinePortHome
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$logon.Delay = 'PT1M'
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $repeat) -Settings $settings -Principal $principal -Description 'LinePort watchdog: restarts the local service and relay when autostart expects them (circuit breaker: 3 restarts per hour or without recovery, 2 for a hung relay).' -Force | Out-Null
Write-Output "Installed task $TaskName (logon + every $IntervalMinutes minutes)."
