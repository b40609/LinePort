$ErrorActionPreference = 'Stop'
$expectedScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'relay.mjs'))
$listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 18766 -State Listen -ErrorAction SilentlyContinue)
if (!$listeners.Count) { Write-Output 'No relay listener is running.'; return }
foreach ($listener in $listeners) {
    $relayProcessId = $listener.OwningProcess
    $relayProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $relayProcessId"
    # Only stop this checkout's exact Node entrypoint. Never stop all Node processes.
    $expectedCommand = '^"?[^"\r\n]*node\.exe"?\s+"' + [regex]::Escape($expectedScript) + '"\s*$'
    if ($relayProcess.Name -ne 'node.exe' -or $relayProcess.CommandLine -notmatch $expectedCommand) {
        throw 'Port belongs to another process or a manually started relay. Inspect its command line; nothing was stopped.'
    }
    Stop-Process -Id $relayProcessId -ErrorAction Stop
}
Write-Output 'Relay stopped. An in-flight send may remain uncertain; it will not be resent.'
