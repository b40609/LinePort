param(
    [Parameter(Mandatory = $true)][string]$PortableDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$IsccPath
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$payload = (Resolve-Path -LiteralPath $PortableDirectory).Path
$compiler = (Resolve-Path -LiteralPath $IsccPath).Path
$version = (Get-Content -LiteralPath (Join-Path $root 'yomi-probe/package.json') -Raw | ConvertFrom-Json).version
$payloadVersion = (Get-Content -LiteralPath (Join-Path $payload 'yomi-probe/package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-rc\.\d+)?$' -or $version -cne $payloadVersion) { throw 'Payload and repository versions must match.' }
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Choose a new output directory; existing files are never overwritten.' }
$verify = Start-Process -FilePath (Join-Path $payload 'LinePort.exe') -ArgumentList '--verify-package' -WindowStyle Hidden -Wait -PassThru
if ($verify.ExitCode -ne 0) { throw 'Payload is incomplete.' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output | Out-Null
[IO.File]::WriteAllText((Join-Path $output 'installed-version.txt'), $version, [Text.Encoding]::ASCII)
$fileVersion = ($version -split '-')[0] + '.0'
& $compiler "/DPayloadRoot=$payload" "/DAppVersion=$version" "/DAppFileVersion=$fileVersion" "/DReleaseDirectory=$output" (Join-Path $root 'installer/LinePort.iss')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
$installer = Join-Path $output "LinePort-v$version-Windows-x64-Setup.exe"
if (!(Test-Path -LiteralPath $installer)) { throw 'Installer output missing.' }
Write-Output "Installer ready: $installer"
