[CmdletBinding()]
param(
    [string]$VsixPath = (Join-Path $PSScriptRoot '..\src\VsGsharp\bin\Debug\net472\GSharp.VisualStudio.vsix'),
    [string]$RootSuffix = 'GSharp'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw "Visual Studio Installer was not found at '$vswhere'."
}

$installationPath = (& $vswhere -latest -products * -property installationPath).Trim()
$instanceId = (& $vswhere -latest -products * -property instanceId).Trim()
$resolvedVsix = (Resolve-Path -LiteralPath $VsixPath).Path
if (-not $installationPath -or -not $instanceId) {
    throw 'No Visual Studio instance was found.'
}

$installer = Join-Path $installationPath 'Common7\IDE\VSIXInstaller.exe'
$devenvExe = Join-Path $installationPath 'Common7\IDE\devenv.exe'
$profilePattern = Join-Path $env:LOCALAPPDATA "Microsoft\VisualStudio\*_${instanceId}${RootSuffix}"

function Invoke-DevenvConfiguration([string]$Argument, [string]$Description) {
    $startedAt = Get-Date
    $process = Start-Process -FilePath $devenvExe -ArgumentList @(
        '/RootSuffix',
        $RootSuffix,
        $Argument
    ) -PassThru -Wait
    if ($process.ExitCode -eq -1) {
        $configurationProcesses = Get-CimInstance Win32_Process -Filter "Name = 'devenv.exe'" |
            Where-Object {
                $_.CreationDate -ge $startedAt.AddSeconds(-2) -and
                $_.CommandLine -match "(?i)/$([regex]::Escape($Argument.TrimStart('/')))(?:\s|$)"
            }
        foreach ($configurationProcess in $configurationProcesses) {
            $child = Get-Process -Id $configurationProcess.ProcessId -ErrorAction SilentlyContinue
            if ($child -and -not $child.WaitForExit(300000)) {
                Stop-Process -Id $child.Id
                throw "$Description did not finish within five minutes."
            }
        }
        return
    }

    if ($process.ExitCode -ne 0) {
        throw "$Description failed with exit code $($process.ExitCode)."
    }
}

function Clear-ProfileCaches {
    Get-Item -Path $profilePattern -ErrorAction SilentlyContinue |
        ForEach-Object {
            foreach ($name in @('ComponentModelCache', 'MEFCacheBackup')) {
                $cache = Join-Path $_.FullName $name
                if (Test-Path -LiteralPath $cache) {
                    Remove-Item -LiteralPath $cache -Recurse -Force
                }
            }

            foreach ($name in @('ExtensionMetadata2.0.mpack', 'ExtensionMetadataCache.mpack')) {
                $cache = Join-Path $_.FullName "Extensions\$name"
                if (Test-Path -LiteralPath $cache) {
                    Remove-Item -LiteralPath $cache -Force
                }
            }

            foreach ($cache in Get-ChildItem $_.FullName -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -eq 'InstalledTemplates.json' -or
                    $_.Name -like 'NpdProjectTemplateCache_*' }) {
                Remove-Item -LiteralPath $cache.FullName -Force
            }

            Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like 'ItemTemplatesCache_*' -or
                    $_.Name -like 'ProjectTemplatesCache_*' } |
                Remove-Item -Recurse -Force
        }
}

Get-CimInstance Win32_Process -Filter "Name = 'devenv.exe'" |
    Where-Object { $_.CommandLine -match "(?i)/RootSuffix\s+[`"']?$([regex]::Escape($RootSuffix))(?:[`"']?\s|$)" } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId
        Wait-Process -Id $_.ProcessId -Timeout 30 -ErrorAction SilentlyContinue
    }

$installed = Get-Item -Path $profilePattern -ErrorAction SilentlyContinue |
    Get-ChildItem -Filter extension.vsixmanifest -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
        try {
            ([xml](Get-Content -LiteralPath $_.FullName)).PackageManifest.Metadata.Identity.Id -eq 'GSharp.VisualStudio'
        }
        catch {
            $false
        }
    } |
    Select-Object -First 1

if ($installed) {
    & $installer /quiet /shutdownprocesses "/instanceIds:$instanceId" "/rootSuffix:$RootSuffix" /uninstall:GSharp.VisualStudio
    if ($LASTEXITCODE -ne 0) {
        throw "VSIX uninstall failed with exit code $LASTEXITCODE."
    }

    Invoke-DevenvConfiguration /UpdateConfiguration 'Visual Studio configuration cleanup'
}

& $installer /quiet /shutdownprocesses "/instanceIds:$instanceId" "/rootSuffix:$RootSuffix" $resolvedVsix
if ($LASTEXITCODE -ne 0) {
    throw "VSIX installation failed with exit code $LASTEXITCODE."
}

Invoke-DevenvConfiguration /UpdateConfiguration 'Visual Studio configuration update'
Invoke-DevenvConfiguration /ClearCache 'Visual Studio cache refresh'
Invoke-DevenvConfiguration /UpdateConfiguration 'Visual Studio post-cache configuration update'
Clear-ProfileCaches

$discovery = Start-Process -FilePath $devenvExe -ArgumentList @(
    '/RootSuffix',
    $RootSuffix
) -PassThru
Start-Sleep -Seconds 30
$null = $discovery.CloseMainWindow()
if (-not $discovery.WaitForExit(60000)) {
    Stop-Process -Id $discovery.Id
    throw 'Visual Studio extension discovery did not close within one minute.'
}

Write-Host "Installed '$resolvedVsix' into root suffix '$RootSuffix'."
