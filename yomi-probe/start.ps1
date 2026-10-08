$ErrorActionPreference = 'Stop'
$probeUrl = 'http://127.0.0.1:18765/'
$probeReady = $false
try {
    $probeResponse = Invoke-WebRequest -Uri $probeUrl -TimeoutSec 2 -UseBasicParsing
    $probeReady = ($probeResponse.Content.Contains('<title>LinePort</title>') -or $probeResponse.Content.Contains('<title>LINE Relay Bridge</title>')) -and $probeResponse.Content.Contains('id="phone"')
} catch { }
if (-not $probeReady) {
    $probeNode = (Get-Command node.exe -ErrorAction Stop).Source
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules/@rikaidev/yomi/dist/line/core/service.js'))) { throw 'Dependencies missing. Run npm ci --ignore-scripts in yomi-probe first.' }
    $probeScript = Join-Path $PSScriptRoot 'server.mjs'
    Start-Process -FilePath $probeNode -ArgumentList ('"' + $probeScript + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
    for ($probeAttempt = 0; $probeAttempt -lt 20; $probeAttempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $probeResponse = Invoke-WebRequest -Uri $probeUrl -TimeoutSec 1 -UseBasicParsing
            $probeReady = ($probeResponse.Content.Contains('<title>LinePort</title>') -or $probeResponse.Content.Contains('<title>LINE Relay Bridge</title>')) -and $probeResponse.Content.Contains('id="phone"')
            if ($probeReady) { break }
        } catch { }
    }
}
if (-not $probeReady) { throw 'Local probe could not start. Check Node.js and port 18765.' }
Start-Process $probeUrl
