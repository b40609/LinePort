# LinePort watchdog: run by the "LinePort-Service-Recovery" scheduled task (at logon and every
# 5 minutes). It only restarts what autostart says should be running, never undoes a manual
# relay stop, and stops itself after too many restarts. No token or message text is logged.
param(
    [string]$LinePortHome = (Join-Path $env:LOCALAPPDATA 'LinePort'),
    [string]$BaseUrl = 'http://127.0.0.1:18765',
    [int]$MaxRestarts = 3,
    [int]$WindowMinutes = 15,
    [int]$LogLines = 500,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$logPath = Join-Path $LinePortHome 'watchdog.log'
$statePath = Join-Path $LinePortHome 'watchdog-state.json'

function Write-WatchdogLog([string]$Message) {
    try {
        $entry = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'), ($Message -replace '[\r\n]+', ' ')
        $kept = @()
        if (Test-Path -LiteralPath $logPath) { $kept = @(Get-Content -LiteralPath $logPath -Tail ($LogLines - 1) -Encoding UTF8) }
        # Retry briefly: antivirus scans can hold the log file for a moment.
        for ($try = 0; $try -lt 5; $try++) { try { Set-Content -LiteralPath $logPath -Value (@($kept) + $entry) -Encoding UTF8; break } catch { Start-Sleep -Milliseconds 200 } }
    } catch { }
}
function Read-JsonFile($Path) {
    if (!(Test-Path -LiteralPath $Path)) { return $null }
    try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}
function Save-State($State) {
    $temporary = $statePath + '.tmp'
    Set-Content -LiteralPath $temporary -Value ($State | ConvertTo-Json -Compress) -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $statePath -Force
}
function Start-Entrypoint([string]$Name) {
    $script = Join-Path $LinePortHome $Name
    if (!(Test-Path -LiteralPath $script)) { Write-WatchdogLog "missing $Name; enable autostart on the LinePort page once to create it"; return $false }
    if ($DryRun) { Write-WatchdogLog "[dry-run] would start $Name"; return $true }
    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Start-Process -FilePath $shell -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $script + '"')) -WindowStyle Hidden
    Write-WatchdogLog "started $Name"
    return $true
}

try {
    $autostart = Read-JsonFile (Join-Path $LinePortHome 'autostart.json')
    if (!$autostart -or (!$autostart.service -and !$autostart.relay)) { exit 0 }
    $intent = Read-JsonFile (Join-Path $LinePortHome 'relay-intent.json')
    $relayWanted = [bool]$autostart.relay -and !($intent -and $intent.desired -eq 'stopped')

    # Probe the UI: the page itself needs no token; diagnostics needs the page's one-time token.
    $serviceUp = $false; $relayPhase = 'unknown'
    try {
        $html = (Invoke-WebRequest -Uri ($BaseUrl + '/') -UseBasicParsing -TimeoutSec 5).Content
        if ($html -match "const token='([a-f0-9]{64})'") {
            $serviceUp = $true
            $diagnostics = Invoke-RestMethod -Uri ($BaseUrl + '/api/diagnostics') -Headers @{ 'X-Probe-Token' = $Matches[1] } -TimeoutSec 10
            $relayPhase = [string]$diagnostics.phase
        }
    } catch { }

    $actions = @()
    if (!$serviceUp -and $autostart.service) { $actions += 'autostart-service.ps1' }
    # A stopped relay (no process) is restarted; failed/blocked routes need a person and are left alone.
    if ($relayWanted -and (!$serviceUp -or $relayPhase -in @('stopped', 'unavailable'))) {
        if ($serviceUp -or $autostart.service) { $actions += 'autostart-relay.ps1' }
    }
    if (!$actions.Count) { exit 0 }

    $state = Read-JsonFile $statePath
    $now = Get-Date
    $recent = @(@($state.restarts) | Where-Object { $_ } | ForEach-Object { [datetime]::Parse($_, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) } | Where-Object { ($now - $_).TotalMinutes -lt $WindowMinutes })
    $reason = 'service ' + $(if ($serviceUp) { 'up' } else { 'down' }) + ', relay ' + $relayPhase
    if ($recent.Count -ge $MaxRestarts) {
        # Circuit breaker: log once per open window, then stay quiet until restarts age out.
        if (!$state.circuitLoggedAt -or ($now - [datetime]::Parse($state.circuitLoggedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)).TotalMinutes -ge $WindowMinutes) {
            Write-WatchdogLog "circuit open: $($recent.Count) restarts within $WindowMinutes minutes; not restarting ($reason). Check autostart.log and the LinePort page."
            Save-State @{ restarts = @($recent | ForEach-Object { $_.ToString('o') }); circuitLoggedAt = $now.ToString('o') }
        }
        exit 0
    }
    Write-WatchdogLog "recovering: $reason"
    $started = $false
    foreach ($action in $actions) { if (Start-Entrypoint $action) { $started = $true } }
    if ($started) { Save-State @{ restarts = @(@($recent | ForEach-Object { $_.ToString('o') }) + $now.ToString('o')); circuitLoggedAt = $null } }
} catch {
    $text = [string]$_.Exception.Message
    Write-WatchdogLog ('watchdog error: ' + $_.Exception.GetType().Name + ': ' + $text.Substring(0, [Math]::Min(300, $text.Length)))
    exit 1
}
