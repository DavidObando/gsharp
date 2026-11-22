$ErrorActionPreference = "Stop"

$destination = Join-Path $env:RUNNER_TEMP "gsharp-vsix-publisher-smoke"
$resolver = Join-Path $PSScriptRoot "get-vsix-publisher.ps1"
$publisher = . $resolver -Destination $destination
$directory = Split-Path $publisher

$configPath = Join-Path $directory "VsixPublisher.exe.config"
$smoke = Join-Path $directory "GSharp.PublisherAuthSmoke.exe"
$smokeConfig = "$smoke.config"
try {
    Add-Type -TypeDefinition @'
using System;
using Microsoft.Identity.Client;

public static class PublisherAuthSmoke
{
    public static void Main()
    {
        const string clientId = "00000000-0000-0000-0000-000000000001";
        var client = PublicClientApplicationBuilder.Create(clientId)
            .WithAuthority("https://login.microsoftonline.com/common")
            .Build();
        if (client.AppConfig.ClientId != clientId)
            throw new InvalidOperationException("The packaged MSAL client did not initialize.");
    }
}
'@ -ReferencedAssemblies @(
        (Join-Path $directory "lib\Microsoft.Identity.Client.dll"),
        (Join-Path $directory "lib\Microsoft.IdentityModel.Abstractions.dll")
    ) -OutputAssembly $smoke -OutputType ConsoleApplication
    Copy-Item $configPath $smokeConfig
    & $smoke
    if ($LASTEXITCODE -ne 0) {
        throw "The packaged MSAL smoke failed with exit code $LASTEXITCODE."
    }
} finally {
    Remove-Item $smoke, $smokeConfig -Force -ErrorAction SilentlyContinue
}

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
