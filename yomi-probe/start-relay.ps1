param(
    [string]$SourceName = '',
    [string]$DestinationName = '',
    [switch]$Interactive
)
$ErrorActionPreference = 'Stop'
if ($Interactive) {
    $SourceName = Read-Host 'Paste full SOURCE group name from the local page'
    $DestinationName = Read-Host 'Paste full DESTINATION group name from the local page'
    if (!$SourceName -or !$DestinationName) { throw 'Both group names are required.' }
}
$requestedSource = if ($SourceName) { $SourceName } elseif ($env:LINECALL_SOURCE) { $env:LINECALL_SOURCE } else { ([char]0x4F86).ToString() + [char]0x6E90 + '1' }
$requestedDestination = if ($DestinationName) { $DestinationName } elseif ($env:LINECALL_DESTINATION) { $env:LINECALL_DESTINATION } else { ([char]0x76EE).ToString() + [char]0x7684 + '2' }
if ($requestedSource -eq $requestedDestination) { throw 'Source and destination must differ.' }
if ($requestedSource -match '[\r\n\x00]' -or $requestedDestination -match '[\r\n\x00]') { throw 'Invalid group name.' }
function Confirm-RelayState($relayState) {
    if ($relayState.app -ne 'line-relay-bridge') { throw 'Port 18766 is occupied by an old or unknown service. Stop the old relay before upgrading.' }
    if ($env:LINEPORT_CONFIG_REVISION) {
        if ($relayState.version -ne 3 -or $relayState.revision -cne $env:LINEPORT_CONFIG_REVISION) { throw 'Different rules are running. Stop the relay before switching rules.' }
    } elseif ($relayState.version -eq 3 -or $relayState.source -cne $requestedSource -or $relayState.destination -cne $requestedDestination) { throw 'A different route is running. Run stop-relay.ps1 before switching groups.' }
    if ($relayState.phase -eq 'failed') { throw "Relay failed at stage $($relayState.stage). Read docs/TROUBLESHOOTING.md, then stop and restart." }
}
$relayUrl = 'http://127.0.0.1:18766/status'
$relayState = $null
try {
    $relayState = Invoke-RestMethod -Uri $relayUrl -TimeoutSec 2
} catch { }
if ($relayState) {
    Confirm-RelayState $relayState
    if ($relayState.phase -in @('running', 'degraded')) { Write-Output ($relayState | ConvertTo-Json -Depth 8 -Compress); return }
} else {
$relayNode = (Get-Command node.exe -ErrorAction Stop).Source
$relayScript = Join-Path $PSScriptRoot 'relay.mjs'
if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules/@rikaidev/yomi/dist/line/core/service.js'))) { throw 'Dependencies missing. Run npm ci --ignore-scripts in yomi-probe first.' }
$previousSource = $env:LINECALL_SOURCE
$previousDestination = $env:LINECALL_DESTINATION
try {
    $env:LINECALL_SOURCE = $requestedSource
    $env:LINECALL_DESTINATION = $requestedDestination
    Start-Process -FilePath $relayNode -ArgumentList ('"' + $relayScript + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
} finally {
    $env:LINECALL_SOURCE = $previousSource
    $env:LINECALL_DESTINATION = $previousDestination
}
}
for ($relayAttempt = 0; $relayAttempt -lt 120; $relayAttempt++) {
    Start-Sleep -Milliseconds 500
    $relayState = $null
    try {
        $relayState = Invoke-RestMethod -Uri $relayUrl -TimeoutSec 2
    } catch { }
    if ($relayState) {
        Confirm-RelayState $relayState
        if ($relayState.phase -in @('running', 'degraded')) { Write-Output ($relayState | ConvertTo-Json -Depth 8 -Compress); return }
    }
}
throw 'Relay did not become ready. Check http://127.0.0.1:18766/status'
