$ErrorActionPreference = 'Stop'
$probeUrl = 'http://127.0.0.1:18765/'
$probeReady = $false
try {
    $probeResponse = Invoke-WebRequest -Uri $probeUrl -TimeoutSec 2 -UseBasicParsing
    $probeReady = $probeResponse.Content.Contains('<title>LINE') -and $probeResponse.Content.Contains('id="phone"')
} catch { }
if (-not $probeReady) {
    $probeNode = (Get-Command node.exe -ErrorAction Stop).Source
    $probeScript = Join-Path $PSScriptRoot 'server.mjs'
    Start-Process -FilePath $probeNode -ArgumentList ('"' + $probeScript + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
    for ($probeAttempt = 0; $probeAttempt -lt 20; $probeAttempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $probeResponse = Invoke-WebRequest -Uri $probeUrl -TimeoutSec 1 -UseBasicParsing
            $probeReady = $probeResponse.Content.Contains('<title>LINE') -and $probeResponse.Content.Contains('id="phone"')
            if ($probeReady) { break }
        } catch { }
    }
}
if (-not $probeReady) { throw 'Local probe could not start. Check Node.js and port 18765.' }
Start-Process $probeUrl
