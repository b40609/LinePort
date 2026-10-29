param(
    [switch]$InstallDeps,
    [switch]$Dev
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$electronDir = Join-Path $root 'electron'

Push-Location $electronDir
try {
    if ($InstallDeps -or !(Test-Path -LiteralPath (Join-Path $electronDir 'node_modules'))) {
        Write-Host "Installing Electron dependencies..." -ForegroundColor Cyan
        & npm.cmd install
        if ($LASTEXITCODE -ne 0) { throw "npm install in electron failed." }
    }

    if ($Dev) {
        Write-Host "Starting LinePort Electron in dev mode..." -ForegroundColor Green
        & npm.cmd start
    } else {
        Write-Host "Building LinePort Electron .exe installers..." -ForegroundColor Green
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "electron-builder failed." }
        Write-Host "Build complete! Artifacts located at: dist/electron-release/" -ForegroundColor Green
    }
} finally {
    Pop-Location
}
