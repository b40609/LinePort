$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$distDir = Join-Path $root 'dist\LinePort-Desktop-Portable'
$electronDist = Join-Path $root 'electron\node_modules\electron\dist'

if (Test-Path $distDir) {
    Remove-Item -Path $distDir -Recurse -Force
}
New-Item -ItemType Directory -Path $distDir -Force | Out-Null

Write-Host "Copying Electron binaries..." -ForegroundColor Cyan
Copy-Item -Path "$electronDist\*" -Destination $distDir -Recurse -Force

# Rename electron.exe to LinePort.exe
Rename-Item -Path (Join-Path $distDir 'electron.exe') -NewName 'LinePort.exe' -Force

# Create resources/app
$appDir = Join-Path $distDir 'resources\app'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null

Copy-Item -Path (Join-Path $root 'electron\main.cjs') -Destination $appDir -Force
Copy-Item -Path (Join-Path $root 'electron\package.json') -Destination $appDir -Force

# Bundle assets and yomi-probe into resources so the portable package is 100% self-contained
$resDir = Join-Path $distDir 'resources'
Copy-Item -Path (Join-Path $root 'package') -Destination (Join-Path $resDir 'package') -Recurse -Force
Copy-Item -Path (Join-Path $root 'yomi-probe') -Destination (Join-Path $resDir 'yomi-probe') -Recurse -Force

Write-Host "Portable desktop application ready at: $distDir\LinePort.exe" -ForegroundColor Green
