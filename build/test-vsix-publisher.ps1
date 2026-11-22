$ErrorActionPreference = "Stop"

$destination = Join-Path $env:RUNNER_TEMP "gsharp-vsix-publisher-smoke"
$resolver = Join-Path $PSScriptRoot "get-vsix-publisher.ps1"
$publisher = . $resolver -Destination $destination
$directory = Split-Path $publisher

[System.Reflection.Assembly]::LoadFrom((Join-Path $directory "lib\Microsoft.Identity.Client.dll")) | Out-Null
$clientId = "00000000-0000-0000-0000-000000000001"
$builder = [Microsoft.Identity.Client.PublicClientApplicationBuilder]::Create($clientId)
$builder = $builder.WithAuthority("https://login.microsoftonline.com/common")
$client = $builder.Build()
if ($client.AppConfig.ClientId -ne $clientId) {
    throw "The packaged MSAL client did not initialize."
}

$configPath = Join-Path $directory "VsixPublisher.exe.config"
$original = [System.IO.File]::ReadAllText($configPath)
try {
    [xml]$mutant = $original
    $namespaces = New-Object System.Xml.XmlNamespaceManager($mutant.NameTable)
    $namespaces.AddNamespace("asm", "urn:schemas-microsoft-com:asm.v1")
    $redirect = $mutant.SelectSingleNode(
        "/configuration/runtime/asm:assemblyBinding/asm:dependentAssembly[asm:assemblyIdentity/@name='Microsoft.Identity.Client']/asm:bindingRedirect",
        $namespaces
    )
    $redirect.newVersion = "4.0.0.0"
    $mutant.Save($configPath)
    $rejected = $false
    try {
        Test-VsixPublisherRuntime -PublisherDirectory $directory
    } catch {
        if ($_.Exception.Message -notlike "VsixPublisher MSAL mismatch:*") { throw }
        $rejected = $true
    }
    if (-not $rejected) {
        throw "The publisher validation accepted a mismatched MSAL assembly."
    }
} finally {
    [System.IO.File]::WriteAllText($configPath, $original)
}
Test-VsixPublisherRuntime -PublisherDirectory $directory
Write-Host "Packaged publisher authentication initialization and mismatch discrimination passed."
