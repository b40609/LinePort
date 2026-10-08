param(
    [string]$SourceName = '',
    [string]$DestinationName = ''
)
$ErrorActionPreference = 'Stop'
if ($SourceName) { $env:LINECALL_SOURCE = $SourceName }
if ($DestinationName) { $env:LINECALL_DESTINATION = $DestinationName }
$relayUrl = 'http://127.0.0.1:18766/status'
try {
    $relayState = Invoke-RestMethod -Uri $relayUrl -TimeoutSec 2
    Write-Output ($relayState | ConvertTo-Json -Compress)
    exit
} catch { }
$relayNode = (Get-Command node.exe -ErrorAction Stop).Source
$relayScript = Join-Path $PSScriptRoot 'relay.mjs'
Start-Process -FilePath $relayNode -ArgumentList ('"' + $relayScript + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
for ($relayAttempt = 0; $relayAttempt -lt 20; $relayAttempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $relayState = Invoke-RestMethod -Uri $relayUrl -TimeoutSec 2
        if ($relayState.phase -ne 'starting') {
            Write-Output ($relayState | ConvertTo-Json -Compress)
            exit
        }
    } catch { }
}
throw 'Relay did not become ready. Check http://127.0.0.1:18766/status'
