// <copyright file="Issue5271ReferenceAssemblyPackTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import System
import System.Diagnostics
import System.IO
import System.IO.Compression
import System.Linq
import System.Threading.Tasks
import System.Xml.Linq
import Gsharp.NET.Sdk.Tools
import Xunit

/// Exercises reference-assembly packaging without compiling against a platform workload.
class Issue5271ReferenceAssemblyPackTests : IDisposable {
    private let directory string = Path.Combine(
        RepoRoot.Path,
        "out",
        "test",
        "Issue5271ReferenceAssemblyPackTests",
        Guid.NewGuid().ToString("N")
    )

    init() {
        Directory.CreateDirectory(directory)
    }

    func Dispose() -> Directory.Delete(directory, recursive: true)

    @Fact
    func Pack_UsesEachInnerBuildsEffectiveFramework_ForReferenceAndLibraryPaths() {
        let document = XDocument.Parse(Project)
        let root = document.Root ?? throw InvalidOperationException("The fixture has no root.")
        let properties = root.Elements("PropertyGroup").Last()
        properties.SetElementValue("GsharpToolFullPath", typeof(BuildTask).Assembly.Location)
        properties.SetElementValue("FixtureAssembly", typeof(Issue5271ReferenceAssemblyPackTests).Assembly.Location)
        root
            .Elements("Import")
            .Last()
            .SetAttributeValue("Project", Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets"))
        document.Save(Path.Combine(directory, "Pack.proj"))

        let start = ProcessStartInfo("dotnet"){
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        }
        for argument in[]string{
            "msbuild",
            "Pack.proj",
            "-restore",
            "-t:Pack",
            "-p:NoBuild=true",
            "-p:Configuration=Release",
            "-nr:false",
            "-nologo",
            "-v:minimal"
        } {
            start.ArgumentList.Add(argument)
        }
        using let process = Process.Start(start) ?? throw InvalidOperationException("Cannot start pack.")
        let stdout = process.StandardOutput.ReadToEndAsync()
        let stderr = process.StandardError.ReadToEndAsync()
        if !process.WaitForExit(120000) {
            process.Kill(entireProcessTree: true)
            process.WaitForExit()
            throw TimeoutException("The metadata-only pack fixture timed out.")
        }
        Task.WaitAll(stdout, stderr)
        let output = stdout.Result + stderr.Result
        Assert.True(process.ExitCode == 0, output)
        Assert.DoesNotContain("NU1012", output)
        let packages = Directory.GetFiles(Path.Combine(directory, "bin", "Release"), "*.nupkg")
        Assert.Single(packages)
        using let archive = ZipFile.OpenRead(packages[0])
        let libraries = archive
            .Entries
            .Select((entry ZipArchiveEntry) -> entry.FullName)
            .Where(
            (name string) -> name.StartsWith("lib/", StringComparison.Ordinal) && name.EndsWith(
                "/Pack.dll",
                StringComparison.Ordinal
            )
        )
            .OrderBy((name string) -> name, StringComparer.Ordinal)
            .ToArray()
        let references = archive
            .Entries
            .Select((entry ZipArchiveEntry) -> entry.FullName)
            .Where(
            (name string) -> name.StartsWith("ref/", StringComparison.Ordinal) && name.EndsWith(
                "/Pack.dll",
                StringComparison.Ordinal
            )
        )
            .OrderBy((name string) -> name, StringComparer.Ordinal)
            .ToArray()
        Assert.NotEmpty(libraries)
        Assert.NotEmpty(references)
        Assert.Equal(
            []string{
                "lib/net10.0-android35.0/Pack.dll",
                "lib/net10.0-android36.0/Pack.dll",
                "lib/net10.0-windows7.0/Pack.dll",
                "lib/net10.0/Pack.dll"
            },
            libraries
        )
        Assert.Equal(libraries.Select((name string) -> "ref/" + name.Substring(4)).ToArray(), references)
        let nuspecEntry = archive.Entries.Single(
            (entry ZipArchiveEntry) -> entry.FullName.EndsWith(".nuspec", StringComparison.Ordinal)
        )
        using let nuspecStream = nuspecEntry.Open()
        let nuspec = XDocument.Load(nuspecStream)
        let frameworks = nuspec
            .Descendants()
            .Where((element XElement) -> element.Name.LocalName == "dependencies")
            .Elements()
            .Where((element XElement) -> element.Name.LocalName == "group")
            .Select((element XElement) -> element.Attribute("targetFramework")?.Value ?? string.Empty)
            .OrderBy((name string) -> name, StringComparer.Ordinal)
            .ToArray()
        Assert.NotEmpty(frameworks)
        Assert.Equal(
            []string{"net10.0", "net10.0-android35.0", "net10.0-android36.0", "net10.0-windows7.0"},
            frameworks
        )
    }

    shared {
        // Design-time evaluation supplies packaging metadata without requiring an Android workload.
        // Reuse a compiled assembly; production targets and NuGet still create and validate every package path.
        private const Project string = `<Project>
  <PropertyGroup>
    <ImportDirectoryBuildProps>false</ImportDirectoryBuildProps>
    <ImportDirectoryBuildTargets>false</ImportDirectoryBuildTargets>
    <DesignTimeBuild>true</DesignTimeBuild>
  </PropertyGroup>
  <Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk" />
  <PropertyGroup>
    <TargetFrameworks>net10.0;net10.0-android;net10.0-android35.0;net10.0-windows</TargetFrameworks>
    <TargetPlatformVersion Condition="'$(TargetFramework)' == 'net10.0-android'">36.0</TargetPlatformVersion>
    <SupportedOSPlatformVersion Condition="$(TargetFramework.Contains('-android'))">26</SupportedOSPlatformVersion>
    <EnableWindowsTargeting>true</EnableWindowsTargeting>
    <ProduceReferenceAssembly>true</ProduceReferenceAssembly>
    <DebugType>none</DebugType>
    <PackageId>PackProbe</PackageId>
    <Version>1.0.0</Version>
    <NoWarn>NU5131</NoWarn>
  </PropertyGroup>
  <Import Project="Sdk.targets" Sdk="Microsoft.NET.Sdk" />
  <Import Project="placeholder" />
  <Target Name="SeedAssemblies"
          BeforeTargets="_GetBuildOutputFilesWithTfm;_GsharpGetRefAssemblyForPack"
          DependsOnTargets="GetTargetPath">
    <Copy SourceFiles="$(FixtureAssembly)" DestinationFiles="$(TargetPath)" />
    <Copy SourceFiles="$(FixtureAssembly)" DestinationFiles="$(TargetRefPath)" />
  </Target>
</Project>`
    }
}
