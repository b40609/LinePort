param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Choose a new output directory; existing files are never overwritten.' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output | Out-Null
Push-Location $root
try {
    # Explicit Git inventory excludes login data, node_modules and generated files.
    $files = @(git ls-files --cached --others --exclude-standard -- yomi-probe)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read source inventory.' }
    foreach ($file in $files) {
        $destination = Join-Path $output $file
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $root $file) -Destination $destination
    }
    New-Item -ItemType Directory -Path (Join-Path $output 'runtime') | Out-Null
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    Copy-Item -LiteralPath $node -Destination (Join-Path $output 'runtime/node.exe')
    # Node distributes its bundled third-party notices alongside the runtime.
    $license = Join-Path (Split-Path $node -Parent) 'LICENSE'
    if (Test-Path -LiteralPath $license) {
        Copy-Item -LiteralPath $license -Destination (Join-Path $output 'runtime/LICENSE')
    } else {
        $nodeVersion = & $node --version
        if ($nodeVersion -notmatch '^v\d+\.\d+\.\d+$') { throw 'Unrecognized Node.js version.' }
        Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile (Join-Path $output 'runtime/LICENSE')
    }
    & npm.cmd ci --ignore-scripts --no-audit --no-fund --prefix (Join-Path $output 'yomi-probe')
    if ($LASTEXITCODE -ne 0) { throw 'Portable dependency installation failed.' }
    & dotnet publish (Join-Path $root 'src/LinePort.Launcher/LinePort.Launcher.csproj') -c Release -r win-x64 --self-contained true -o $output
    if ($LASTEXITCODE -ne 0) { throw 'Launcher publish failed.' }
    $assets = Get-Content -LiteralPath (Join-Path $root 'src/LinePort.Launcher/obj/project.assets.json') -Raw | ConvertFrom-Json
    $licenseDirectory = Join-Path $output 'runtime/licenses'
    New-Item -ItemType Directory -Path $licenseDirectory | Out-Null
    foreach ($framework in $assets.project.frameworks.PSObject.Properties.Value) {
        foreach ($dependency in $framework.downloadDependencies) {
            if ($dependency.name -notin @('Microsoft.NETCore.App.Runtime.win-x64', 'Microsoft.WindowsDesktop.App.Runtime.win-x64')) { continue }
            $runtimeVersion = ($dependency.version -replace '[\[\] ]', '').Split(',')[0]
            $packagePath = $null
            foreach ($folder in $assets.packageFolders.PSObject.Properties.Name) {
                $candidate = Join-Path $folder ($dependency.name.ToLowerInvariant() + '/' + $runtimeVersion)
                if (Test-Path -LiteralPath $candidate) { $packagePath = $candidate; break }
            }
            if (!$packagePath) { throw 'Cannot locate bundled .NET runtime notices.' }
            $notices = @(Get-ChildItem -LiteralPath $packagePath -File | Where-Object { $_.Name -match '^(LICENSE|THIRD-PARTY-NOTICES)(\.TXT)?$' })
            if (!$notices.Count) { throw 'Bundled .NET runtime notices are missing.' }
            foreach ($notice in $notices) {
                Copy-Item -LiteralPath $notice.FullName -Destination (Join-Path $licenseDirectory ($dependency.name + '-' + $notice.Name))
            }
        }
    }
    $version = (Get-Content -LiteralPath (Join-Path $output 'yomi-probe/package.json') -Raw | ConvertFrom-Json).version
    Copy-Item -LiteralPath (Join-Path $root "docs/RELEASE-$version.md") -Destination (Join-Path $output '更新說明.md')
    Copy-Item -LiteralPath (Join-Path $root 'docs/PORTABLE.md') -Destination (Join-Path $output '先讀我.md')
    foreach ($notice in @('LICENSE', 'THIRD_PARTY_NOTICES.md')) {
        Copy-Item -LiteralPath (Join-Path $root $notice) -Destination (Join-Path $output $notice)
    }
    & (Join-Path $output 'runtime/node.exe') --version | Set-Content -LiteralPath (Join-Path $output 'runtime/VERSION.txt')
    Write-Output "Portable package ready: $output"
} finally { Pop-Location }
