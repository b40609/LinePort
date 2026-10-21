$ErrorActionPreference = 'Stop'
# Stop only this checkout's launcher-created UI process; never revoke a LINE session.
$relayListeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 18766 -State Listen -ErrorAction SilentlyContinue)
if ($relayListeners.Count) { throw 'Stop the relay from the page before stopping the local UI.' }
$expectedScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'server.mjs'))
$listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 18765 -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
    $serverProcessId = $listener.OwningProcess
    $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId"
    $expectedCommand = '^"?[^"\r\n]*node\.exe"?\s+"' + [regex]::Escape($expectedScript) + '"\s*$'
    if ($serverProcess.Name -ne 'node.exe' -or $serverProcess.CommandLine -notmatch $expectedCommand) {
        throw 'Port belongs to another process or a manually started server. Close its terminal with Ctrl+C; nothing was stopped.'
    }
    Stop-Process -Id $serverProcessId -ErrorAction Stop
}
Write-Output 'Local UI stopped. Saved data retained; LINE logout was not requested.'
