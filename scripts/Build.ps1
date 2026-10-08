$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$publishPath = Join-Path $taskRoot 'dist'
dotnet publish (Join-Path $taskRoot 'src\LineCall.Diagnostics\LineCall.Diagnostics.csproj') -c Release -r win-x64 --self-contained false -o $publishPath
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
Write-Host "Build ready: $publishPath"
