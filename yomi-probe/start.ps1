param([ValidateSet('DESKTOPMAC', 'IOSIPAD')][string]$Device = 'DESKTOPMAC')
$ErrorActionPreference = 'Stop'
function Confirm-ProbeDevice($html) {
    $runningDevice = 'DESKTOPMAC'
    if ($html -match '<meta name="lineport-device" content="([A-Z]+)">') { $runningDevice = $Matches[1] }
    if ($runningDevice -cne $Device) { throw 'Different LINE device is running. Stop relay, run yomi-probe/stop-server.ps1, then launch the selected mode again.' }
}
$probeUrl = 'http://127.0.0.1:18765/'
$probeReady = $false
try {
    $probeResponse = Invoke-WebRequest -Uri $probeUrl -TimeoutSec 2 -UseBasicParsing
    $probeReady = ($probeResponse.Content.Contains('<title>LinePort</title>') -or $probeResponse.Content.Contains('<title>LINE Relay Bridge</title>')) -and $probeResponse.Content.Contains('id="phone"')
} catch { }
if ($probeReady) { Confirm-ProbeDevice $probeResponse.Content }
if (-not $probeReady) {
    $probeNode = (Get-Command node.exe -ErrorAction Stop).Source
    foreach ($dependency in @('node_modules/@rikaidev/yomi/dist/line/core/service.js', 'node_modules/qrcode/lib/index.js', 'node_modules/tweetnacl/nacl-fast.js')) {
        if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $dependency))) { throw 'Dependencies missing. Run npm ci --ignore-scripts in yomi-probe first.' }
    }
    $probeScript = Join-Path $PSScriptRoot 'server.mjs'
    $previousDevice = $env:LINEPORT_LINE_DEVICE
    try {
        $env:LINEPORT_LINE_DEVICE = $Device
        Start-Process -FilePath $probeNode -ArgumentList ('"' + $probeScript + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
    } finally { $env:LINEPORT_LINE_DEVICE = $previousDevice }
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
Confirm-ProbeDevice $probeResponse.Content
Start-Process $probeUrl
