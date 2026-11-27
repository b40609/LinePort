# LinePort watchdog: run by the "LinePort-Service-Recovery" scheduled task (at logon and every
# 5 minutes). It only restarts what autostart says should be running, never undoes a manual
# relay stop, and stops itself after too many restarts. No token or message text is logged.
param(
    [string]$LinePortHome = (Join-Path $env:LOCALAPPDATA 'LinePort'),
    [string]$BaseUrl = 'http://127.0.0.1:18765',
    [int]$MaxRestarts = 3,
    [int]$WindowMinutes = 15,
    [int]$LogLines = 500,
    [string]$StopRelayScript = '',
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
        # Write via a temp file and atomic rename so readers and antivirus scans never observe a truncated 0-byte log.
        $tmpLog = $logPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
        for ($try = 0; $try -lt 5; $try++) {
            try {
                Set-Content -LiteralPath $tmpLog -Value (@($kept) + $entry) -Encoding UTF8
                Move-Item -LiteralPath $tmpLog -Destination $logPath -Force
                break
            } catch { Start-Sleep -Milliseconds 200 }
        }
    } catch { }
}
function Send-WatchdogToast([string]$Title, [string]$Body) {
    $safeTitle = ($Title -replace '[\x00-\x1f\x7f]', ' ').Trim()
    $safeBody = ($Body -replace '[\x00-\x1f\x7f]', ' ').Trim()
    if ($safeTitle.Length -gt 120) { $safeTitle = $safeTitle.Substring(0, 120) }
    if ($safeBody.Length -gt 200) { $safeBody = $safeBody.Substring(0, 200) }
    if ($DryRun) { Write-WatchdogLog "[dry-run] would notify: $safeTitle - $safeBody"; return }
    try {
        $escapedTitle = [Security.SecurityElement]::Escape($safeTitle)
        $escapedBody = [Security.SecurityElement]::Escape($safeBody)
        $aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml("<toast scenario='reminder'><visual><binding template='ToastGeneric'><text>$escapedTitle</text><text>$escapedBody</text></binding></visual><actions><action content='OK' arguments='dismiss' activationType='system'/></actions></toast>")
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
    } catch {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            $notify = New-Object System.Windows.Forms.NotifyIcon
            $notify.Icon = [System.Drawing.SystemIcons]::Warning
            $notify.Visible = $true
            $notify.ShowBalloonTip(10000, $safeTitle, $safeBody, [System.Windows.Forms.ToolTipIcon]::Warning)
            Start-Sleep -Seconds 12
            $notify.Dispose()
        } catch { }
    }
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

function Stop-HungRelay {
    if ($DryRun) { Write-WatchdogLog '[dry-run] would stop hung relay'; return $true }
    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $candidate = $StopRelayScript
    if (!$candidate) {
        $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 18766 -State Listen -ErrorAction SilentlyContinue)
        foreach ($listener in $listeners) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
            if ($proc -and $proc.Name -eq 'node.exe' -and $proc.CommandLine -match '^"?[^"\r\n]*node\.exe"?\s+"?(?<relay>[^"\r\n]+relay\.mjs)"?\s*$') {
                $dir = Split-Path -Parent $Matches['relay']
                $pkgPath = Join-Path $dir 'package.json'
                $stopPath = Join-Path $dir 'stop-relay.ps1'
                if ((Test-Path -LiteralPath $pkgPath) -and (Test-Path -LiteralPath $stopPath)) {
                    $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ($pkg.name -eq 'lineport') { $candidate = $stopPath; break }
                }
            }
        }
    }
    if (!$candidate -or !(Test-Path -LiteralPath $candidate)) {
        Write-WatchdogLog 'hung relay stop skipped: verified stop-relay.ps1 not found'
        return $false
    }
    & $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $candidate | Out-Null
    for ($wait = 0; $wait -lt 20; $wait++) {
        if (!(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 18766 -State Listen -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
    }
    Write-WatchdogLog "stopped hung relay via $candidate"
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

    $state = Read-JsonFile $statePath
    $now = Get-Date
    $recent = @(@($state.restarts) | Where-Object { $_ } | ForEach-Object { [datetime]::Parse($_, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) } | Where-Object { ($now - $_).TotalMinutes -lt $WindowMinutes })
    $prevStreak = if ($state -and $null -ne $state.unavailableStreak) { [int]$state.unavailableStreak } else { 0 }
    $unavailableStreak = if ($relayWanted -and $serviceUp -and $relayPhase -eq 'unavailable') { $prevStreak + 1 } else { 0 }

    $actions = @()
    $stopHungFirst = $false
    if (!$serviceUp -and $autostart.service) { $actions += 'autostart-service.ps1' }
    # A stopped relay (no process) is restarted immediately; a hung relay (unavailable) is stopped first on its 2nd consecutive check.
    if ($relayWanted -and !$serviceUp) {
        if ($autostart.service) { $actions += 'autostart-relay.ps1' }
    } elseif ($relayWanted -and $relayPhase -eq 'stopped') {
        $actions += 'autostart-relay.ps1'
    } elseif ($relayWanted -and $relayPhase -eq 'unavailable') {
        if ($unavailableStreak -lt 2) {
            Write-WatchdogLog "relay unavailable (streak $unavailableStreak/2); waiting one more check before stopping hung worker"
            Save-State @{ restarts = @($recent | ForEach-Object { $_.ToString('o') }); circuitLoggedAt = $(if ($state) { $state.circuitLoggedAt } else { $null }); unavailableStreak = $unavailableStreak }
            exit 0
        }
        $stopHungFirst = $true
        $actions += 'autostart-relay.ps1'
    }
    if (!$actions.Count) {
        if ($prevStreak -ne 0) {
            Save-State @{ restarts = @($recent | ForEach-Object { $_.ToString('o') }); circuitLoggedAt = $(if ($state) { $state.circuitLoggedAt } else { $null }); unavailableStreak = 0 }
        }
        exit 0
    }

    $reason = 'service ' + $(if ($serviceUp) { 'up' } else { 'down' }) + ', relay ' + $relayPhase
    if ($recent.Count -ge $MaxRestarts) {
        # Circuit breaker: log and notify once per open window, then stay quiet until restarts age out.
        if (!$state.circuitLoggedAt -or ($now - [datetime]::Parse($state.circuitLoggedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)).TotalMinutes -ge $WindowMinutes) {
            Write-WatchdogLog "circuit open: $($recent.Count) restarts within $WindowMinutes minutes; not restarting ($reason). Check autostart.log and the LinePort page."
            Send-WatchdogToast 'LinePort 看門狗已暫停自動重啟' "服務連續重啟 $($recent.Count) 次仍無法恢復（$reason），請開啟 LinePort 並檢查 autostart.log。"
            Save-State @{ restarts = @($recent | ForEach-Object { $_.ToString('o') }); circuitLoggedAt = $now.ToString('o'); unavailableStreak = $unavailableStreak }
        }
        exit 0
    }
    Write-WatchdogLog "recovering: $reason"
    if ($stopHungFirst) { Stop-HungRelay | Out-Null }
    $started = $false
    foreach ($action in $actions) { if (Start-Entrypoint $action) { $started = $true } }
    if ($started) { Save-State @{ restarts = @(@($recent | ForEach-Object { $_.ToString('o') }) + $now.ToString('o')); circuitLoggedAt = $null; unavailableStreak = 0 } }
} catch {
    $text = [string]$_.Exception.Message
    Write-WatchdogLog ('watchdog error: ' + $_.Exception.GetType().Name + ': ' + $text.Substring(0, [Math]::Min(300, $text.Length)))
    exit 1
}
