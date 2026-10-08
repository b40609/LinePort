$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$exePath = Join-Path $taskRoot 'dist\LineCall.Diagnostics.exe'
if (!(Test-Path -LiteralPath $exePath)) { & (Join-Path $PSScriptRoot 'Build.ps1') }
$startedAt = [DateTime]::UtcNow
$run = Start-Process -FilePath $exePath -ArgumentList '--self-test' -WindowStyle Hidden -Wait -PassThru
$package = Get-AppxPackage -Name 'Ryan.LineCall.Diagnostics'
if ($package) {
    $report = Join-Path $env:LOCALAPPDATA "Packages\$($package.PackageFamilyName)\LocalState\LineCallDiagnostics\self-tests\latest.json"
} else {
    $report = Join-Path $env:LOCALAPPDATA 'LineCallDiagnostics\self-tests\latest.json'
}
if (!(Test-Path -LiteralPath $report)) { throw 'No self-test report was produced.' }
if ((Get-Item -LiteralPath $report).LastWriteTimeUtc -lt $startedAt) { throw 'Self-test report is stale.' }
Get-Content -LiteralPath $report
$result = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
if (!$result.Passed) { throw 'Self-test report indicates failure.' }
if ($run.ExitCode -ne 0) { throw 'Self-test failed.' }
