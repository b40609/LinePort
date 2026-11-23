# Prunes old versioned LinePort install folders under "<app>\versions", keeping the latest
# complete releases (default 2: current + previous) plus any specified current directory.
# Never touches user data (%LOCALAPPDATA%\LinePort or LineCallYomiProbe) and skips folders
# currently held by a running process.
param(
    [Parameter(Mandatory = $true)][string]$VersionsRoot,
    [int]$Keep = 2,
    [string]$CurrentDirectory = '',
    [int]$IncompleteGraceMinutes = 60,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if ($Keep -lt 2) { $Keep = 2 }
if (!(Test-Path -LiteralPath $VersionsRoot)) { exit 0 }
$rootItem = Get-Item -LiteralPath $VersionsRoot -Force
if (!$rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'VersionsRoot must be a real directory.'
}
if ($rootItem.Name -cne 'versions') {
    throw 'Refusing to prune a directory not named "versions".'
}

$rootFull = [IO.Path]::GetFullPath($rootItem.FullName).TrimEnd('\', '/')
$currentFull = ''
if ($CurrentDirectory) {
    $currentFull = [IO.Path]::GetFullPath($CurrentDirectory).TrimEnd('\', '/')
}

$activeCommands = @()
try {
    $activeCommands = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'LinePort.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine } | ForEach-Object { [string]$_.CommandLine })
} catch { }

function Test-DirectoryInUse([string]$DirectoryPath) {
    $prefix = $DirectoryPath.TrimEnd('\', '/') + '\'
    foreach ($cmd in $activeCommands) {
        if ($cmd.IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
}

$pattern = '^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?-(\d{14})(?:-(\d+))?$'
$complete = @()
$incomplete = @()
$now = Get-Date

foreach ($dir in @(Get-ChildItem -LiteralPath $rootFull -Directory -Force)) {
    if ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    if ($dir.Name -notmatch $pattern) { continue }
    $full = [IO.Path]::GetFullPath($dir.FullName).TrimEnd('\', '/')
    $rank = '{0:D9}{1:D9}{2:D9}{3}{4:D9}{5}{6:D6}' -f `
        [int]$Matches[1], [int]$Matches[2], [int]$Matches[3], `
        $(if ($Matches[4]) { '0' } else { '1' }), `
        [int]$(if ($Matches[4]) { $Matches[4] } else { 0 }), `
        $Matches[5], `
        [int]$(if ($Matches[6]) { $Matches[6] } else { 0 })
    $isComplete = (Test-Path -LiteralPath (Join-Path $full 'LinePort.exe')) -and `
        (Test-Path -LiteralPath (Join-Path $full 'yomi-probe\package.json'))
    $entry = [pscustomobject]@{ FullName = $full; Name = $dir.Name; Rank = $rank; LastWriteTime = $dir.LastWriteTime }
    if ($isComplete) { $complete += $entry } else { $incomplete += $entry }
}

$ordered = @($complete | Sort-Object Rank -Descending)
$keepSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
if ($currentFull) { [void]$keepSet.Add($currentFull) }
foreach ($item in $ordered) {
    if ($keepSet.Count -ge $Keep -and ($currentFull -eq '' -or $keepSet.Contains($currentFull))) {
        # Ensure at least $Keep complete versions are kept even if CurrentDirectory wasn't complete yet.
        $keptComplete = @($ordered | Where-Object { $keepSet.Contains($_.FullName) }).Count
        if ($keptComplete -ge $Keep) { break }
    }
    [void]$keepSet.Add($item.FullName)
}

$toRemove = @()
foreach ($item in $ordered) {
    if (!$keepSet.Contains($item.FullName)) { $toRemove += $item }
}
foreach ($item in $incomplete) {
    if ($keepSet.Contains($item.FullName)) { continue }
    if (($now - $item.LastWriteTime).TotalMinutes -ge $IncompleteGraceMinutes) { $toRemove += $item }
}

foreach ($item in $toRemove) {
    if (Test-DirectoryInUse $item.FullName) {
        Write-Output "skipped (in use): $($item.Name)"
        continue
    }
    if ($DryRun) {
        Write-Output "[dry-run] would remove: $($item.Name)"
        continue
    }
    try {
        Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop
        Write-Output "removed: $($item.Name)"
    } catch {
        Write-Output "skipped (locked): $($item.Name)"
    }
}
