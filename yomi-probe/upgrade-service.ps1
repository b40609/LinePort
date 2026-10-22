# Only replace a verified LinePort process. Never terminate an arbitrary port owner.
function Get-LinePortProcess($Port, $Entry) {
    $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -ne 1) { throw 'Cannot identify the local LinePort service; no process was stopped.' }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listeners[0].OwningProcess)"
    $pattern = '^"?[^"\r\n]*node\.exe"?\s+(?:"(?<script>[^"\r\n]+)"|(?<script>[^\s"]+))\s*$'
    if ($process.Name -ne 'node.exe' -or $process.CommandLine -notmatch $pattern) { throw 'The port belongs to an unrecognized process; nothing was stopped.' }
    $script = $Matches['script']
    if (![IO.Path]::IsPathRooted($script) -or [IO.Path]::GetFileName($script) -cne $Entry) { throw 'Unrecognized LinePort entrypoint; nothing was stopped.' }
    $directory = Split-Path $script -Parent
    $package = Get-Content -LiteralPath (Join-Path $directory 'package.json') -Raw | ConvertFrom-Json
    if ($package.name -ne 'lineport' -or !(Test-Path -LiteralPath $script)) { throw 'Unrecognized LinePort package; nothing was stopped.' }
    return [pscustomobject]@{ Id = $process.ProcessId; Directory = $directory; Command = $process.CommandLine; Version = $package.version }
}

function Update-LinePortService($Html, $TargetDirectory) {
    $package = Get-Content -LiteralPath (Join-Path $TargetDirectory 'package.json') -Raw | ConvertFrom-Json
    # Older launchers have no machine-readable version, but all supported releases show it here.
    if ($Html -notmatch 'v(\d+\.\d+\.\d+)\s+.\s+LINE') { return $false }
    $runningVersion = [version]$Matches[1]
    $targetVersion = [version]$package.version
    if ($runningVersion -gt $targetVersion) { throw 'A newer LinePort is already running. Open that version instead; downgrade was blocked.' }
    $old = Get-LinePortProcess 18765 'server.mjs'
    if ($runningVersion -eq $targetVersion -and $old.Directory -eq $TargetDirectory) { return $false }
    # Check the replacement is usable before touching the old process.
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    foreach ($dependency in @('node_modules/@rikaidev/yomi/dist/line/core/service.js', 'node_modules/qrcode/lib/index.js', 'node_modules/tweetnacl/nacl-fast.js')) {
        if (!(Test-Path -LiteralPath (Join-Path $TargetDirectory $dependency))) { throw 'The new download is incomplete. Extract the entire Windows ZIP again; the old service is unchanged.' }
    }
    & $node --check (Join-Path $TargetDirectory 'server.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'New service validation failed; the old service is unchanged.' }
    $relay = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 18766 -State Listen -ErrorAction SilentlyContinue)
    if ($relay.Count) {
        $worker = Get-LinePortProcess 18766 'relay.mjs'
        if ($worker.Directory -ne $old.Directory) { throw 'The relay belongs to a different LinePort folder; nothing was stopped.' }
        if ($Html -notmatch "const token='([a-f0-9]{64})';") { throw 'Cannot authorize a safe relay stop; nothing was stopped.' }
        $headers = @{ 'X-Probe-Token' = $Matches[1] }
        $null = Invoke-RestMethod -Uri 'http://127.0.0.1:18765/api/relay/stop' -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 30
        $headers.Clear()
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            if (!(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 18766 -State Listen -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 250
        }
        if (Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 18766 -State Listen -ErrorAction SilentlyContinue) { throw 'Relay stop did not finish. The old UI was retained.' }
    }
    # Revalidate ownership immediately before stopping, including command and PID.
    $current = Get-LinePortProcess 18765 'server.mjs'
    if ($current.Id -ne $old.Id -or $current.Command -cne $old.Command) { throw 'The local service changed during the update; nothing else was stopped.' }
    Stop-Process -Id $old.Id -ErrorAction Stop
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (!(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 18765 -State Listen -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 250
    }
    throw 'The old service has not released its port. Please try opening LinePort again.'
}
