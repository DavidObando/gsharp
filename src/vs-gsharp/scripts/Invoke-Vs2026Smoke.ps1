[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$SolutionPath,

    [string]$RootSuffix = 'GSharp',

    [string]$ActivityLogPath = (Join-Path $PSScriptRoot '..\ActivityLog.xml'),

    [int]$StartupTimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installationPath = (& $vswhere -latest -products * -property installationPath).Trim()
if (-not $installationPath) {
    throw 'No Visual Studio instance was found.'
}

$devenv = Join-Path $installationPath 'Common7\IDE\devenv.exe'
$solution = (Resolve-Path -LiteralPath $SolutionPath).Path
$log = [IO.Path]::GetFullPath($ActivityLogPath)
$process = Start-Process $devenv -ArgumentList @(
    '/RootSuffix',
    $RootSuffix,
    '/Log',
    $log,
    $solution
) -PassThru

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
do {
    Start-Sleep -Seconds 2
    $process.Refresh()
} while (-not $process.HasExited -and
         -not $process.MainWindowHandle -and
         (Get-Date) -lt $deadline)

if ($process.HasExited) {
    throw "Visual Studio exited during startup with code $($process.ExitCode)."
}

if (-not $process.MainWindowHandle) {
    Stop-Process -Id $process.Id
    throw "Visual Studio did not become ready within $StartupTimeoutSeconds seconds."
}

Write-Host "Visual Studio PID: $($process.Id)"
Write-Host "Activity log: $log"
