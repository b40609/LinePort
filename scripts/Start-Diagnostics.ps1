param([switch]$Build, [switch]$InstallOnly)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$publishPath = Join-Path $taskRoot 'dist'
$exePath = Join-Path $publishPath 'LineCall.Diagnostics.exe'
if ($Build -or !(Test-Path -LiteralPath $exePath)) { & (Join-Path $PSScriptRoot 'Build.ps1') }
if (Get-Process -Name 'LineCall.Diagnostics' -ErrorAction SilentlyContinue) {
    Write-Host 'Diagnostics is already running. Open it from the system tray.'
    exit 0
}
$manifestPath = Join-Path $taskRoot 'package\AppxManifest.xml'
$assetsPath = Join-Path $taskRoot 'package\Assets'
[void][System.IO.Directory]::CreateDirectory($assetsPath)
Add-Type -AssemblyName System.Drawing
foreach ($asset in @(@('Logo.png',150), @('SmallLogo.png',44))) {
    $assetPath = Join-Path $assetsPath $asset[0]
    if (!(Test-Path -LiteralPath $assetPath)) {
        $bitmap = [System.Drawing.Bitmap]::new([int]$asset[1], [int]$asset[1])
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::FromArgb(0,130,80))
            $bitmap.Save($assetPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
    }
}
$package = Get-AppxPackage -Name 'Ryan.LineCall.Diagnostics'
if (!$package) {
    $developer = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense
    if ($developer -ne 1) { throw 'Enable Windows Developer Mode for local package registration, then run this script again.' }
    Add-AppxPackage -Register $manifestPath -ExternalLocation $publishPath
    $package = Get-AppxPackage -Name 'Ryan.LineCall.Diagnostics'
    if (!$package) { throw 'Package registration did not complete.' }
}
Write-Host "Package identity ready: $($package.PackageFamilyName)"
if (!$InstallOnly) {
    # This is an interactive diagnostic window. No background terminal is opened.
    Start-Process -FilePath $exePath
}
