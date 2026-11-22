param(
    [Parameter(Mandatory = $true)]
    [string]$Destination
)

$ErrorActionPreference = "Stop"

function Test-VsixPublisherRuntime {
    param([Parameter(Mandatory = $true)][string]$PublisherDirectory)

    $configPath = Join-Path $PublisherDirectory "VsixPublisher.exe.config"
    [xml]$config = Get-Content $configPath -Raw
    $namespaces = New-Object System.Xml.XmlNamespaceManager($config.NameTable)
    $namespaces.AddNamespace("asm", "urn:schemas-microsoft-com:asm.v1")
    $redirect = $config.SelectSingleNode(
        "/configuration/runtime/asm:assemblyBinding/asm:dependentAssembly[asm:assemblyIdentity/@name='Microsoft.Identity.Client']/asm:bindingRedirect",
        $namespaces
    )
    if (-not $redirect) {
        throw "VsixPublisher has no Microsoft.Identity.Client binding redirect."
    }

    $msal = Join-Path $PublisherDirectory "lib\Microsoft.Identity.Client.dll"
    $identity = [System.Reflection.AssemblyName]::GetAssemblyName($msal)
    if ($identity.Name -ne "Microsoft.Identity.Client" -or $identity.Version.ToString() -ne $redirect.newVersion) {
        throw "VsixPublisher MSAL mismatch: configuration expects $($redirect.newVersion), DLL is $($identity.FullName)."
    }
    Write-Host "VsixPublisher MSAL dependency: $($identity.FullName)"
}

$projectPath = Join-Path $PSScriptRoot "..\src\vs-gsharp\src\VsGsharp\VsGsharp.csproj"
[xml]$project = Get-Content $projectPath -Raw
$references = @($project.SelectNodes("/Project/ItemGroup/PackageReference[@Include='Microsoft.VSSDK.BuildTools']"))
if ($references.Count -ne 1 -or -not $references[0].Version) {
    throw "Expected one versioned Microsoft.VSSDK.BuildTools reference in VsGsharp.csproj."
}
$version = $references[0].Version

nuget.exe install Microsoft.VSSDK.BuildTools -Version $version -OutputDirectory $Destination `
    -ExcludeVersion -NonInteractive -DirectDownload -Source https://api.nuget.org/v3/index.json | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "Microsoft.VSSDK.BuildTools $version installation failed with exit code $LASTEXITCODE."
}

$bin = Join-Path $Destination "Microsoft.VSSDK.BuildTools\tools\vssdk\bin"
$publisher = Join-Path $bin "VsixPublisher.exe"
if (-not (Test-Path $publisher -PathType Leaf)) {
    throw "VsixPublisher.exe not found in Microsoft.VSSDK.BuildTools $version."
}
Test-VsixPublisherRuntime -PublisherDirectory $bin
return $publisher
