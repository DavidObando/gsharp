// <copyright file="Issue5039GeneratorIncrementalityTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Runtime.InteropServices
import System.Threading.Tasks
import System.Xml.Linq
import Gsharp.NET.Sdk.Tools
import Xunit

/// Exercises production generator targets with a real framework generator and host.
class Issue5039GeneratorIncrementalityTests : IDisposable {
    private let directory string = Path.Combine(
        RepoRoot.Path,
        "out",
        "test",
        "Issue5039GeneratorIncrementalityTests",
        Guid.NewGuid().ToString("N")
    )

    init() {
        Directory.CreateDirectory(directory)
    }

    func Dispose() -> Directory.Delete(directory, recursive: true)

    @Fact
    func EmptyOutput_TracksOptionsMetadataAndMembership_WithoutRepeatingNoOpWork() {
        WriteProject()
        File.WriteAllText(Path.Combine(directory, "Input.gs"), "package App\npartial class Foo {}")
        let extra = Path.Combine(directory, "Extra.gs")
        File.WriteAllText(extra, "package App\nclass Extra {}")
        File.WriteAllText(Path.Combine(directory, "Input.txt"), "additional input")
        Build("One", "First")
        Assert.Equal(1, ReportCount())
        Build("One", "First")
        Assert.Equal(1, ReportCount())

        Build("Two", "First")
        Assert.Equal(2, ReportCount())
        Build("Two", "First")
        Assert.Equal(2, ReportCount())

        Build("Two", "Second")
        Assert.Equal(3, ReportCount())
        Build("Two", "second")
        Assert.Equal(4, ReportCount())
        File.Delete(extra)
        Build("Two", "second")
        Assert.Equal(5, ReportCount())
        Build("Two", "second")
        Assert.Equal(5, ReportCount())

        Build("Two", "second", additional: false)
        Assert.Equal(6, ReportCount())
        let orphan = Path.Combine(directory, "obj", "gsgen", "stale.g.gs")
        File.WriteAllText(orphan, "class Stale {}")
        Build("Two", "second", additional: false, generators: false)
        Assert.Equal(7, ReportCount())
        Assert.False(File.Exists(orphan))
        Build("Two", "second", additional: false, generators: false)
        Assert.Equal(7, ReportCount())
        Assert.Equal(string.Empty, File.ReadAllText(Path.Combine(directory, "obj", "gsgen", "gsgen.manifest")))
    }

    @Fact
    func GeneratorErrorWithoutOutput_IsReportedAgain_InsteadOfCachingASuccessfulStamp() {
        WriteProject()
        File.WriteAllText(Path.Combine(directory, "Input.gs"), `package App
import System.Text.RegularExpressions
partial class P {
    shared {
        @GeneratedRegex("[")
        private partial func Digits() Regex;
    }
}
`)
        Build("App", "First", additional: false, error: "SYSLIB1042")
        Assert.Equal(1, ReportCount())
        Assert.False(File.Exists(Path.Combine(directory, "obj", "gsgen", "gsgen.manifest")))
        Build("App", "First", additional: false, error: "SYSLIB1042")
        Assert.Equal(2, ReportCount())
    }

    private func ReportCount() int32 -> Directory.GetFiles(directory, "phase-*.json").Length

    private func Build(
        rootNamespace string,
        group string,
        additional bool = true,
        generators bool = true,
        error string? = nil
    ) {
        let start = ProcessStartInfo("dotnet"){
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        }
        for argument in[]string{
            "msbuild",
            "Generators.proj",
            "-nologo",
            "-m:2",
            "-nr:false",
            "-v:minimal",
            "-p:RootNamespace=$rootNamespace",
            "-p:AdditionalGroup=$group",
            "-p:UseAdditional=${additional.ToString()}",
            "-p:UseGenerators=${generators.ToString()}"
        } {
            start.ArgumentList.Add(argument)
        }
        start.Environment["GSHARP_MEASURE_PHASES"] = Path.Combine(directory, "phase-{id}.json")
        using let process = Process.Start(start) ??
            throw InvalidOperationException("Cannot start generator target test.")
        let stdout = process.StandardOutput.ReadToEndAsync()
        let stderr = process.StandardError.ReadToEndAsync()
        if !process.WaitForExit(120000) {
            process.Kill(entireProcessTree: true)
            process.WaitForExit()
            throw TimeoutException("Generator target test timed out.")
        }
        Task.WaitAll(stdout, stderr)
        let output = stdout.Result + stderr.Result
        if error == nil {
            Assert.True(process.ExitCode == 0, output)
        } else {
            Assert.Contains(error, output)
            Assert.DoesNotContain("GS9998", output)
            Assert.True(process.ExitCode != 0, output)
        }
    }

    private func WriteProject() {
        let configuration = DirectoryInfo(AppContext.BaseDirectory).Parent?.Name ?? "Release"
        let gsgen = Path.Combine(RepoRoot.Path, "out", "bin", configuration, "Gsgen.Cli", "gsgen.dll")
        Assert.True(File.Exists(gsgen), gsgen)
        let runtime = RuntimeEnvironment.GetRuntimeDirectory()
        let packRoot = Path.GetFullPath(Path.Combine(runtime, "..", "..", "..", "packs", "Microsoft.NETCore.App.Ref"))
        let pack = Directory
            .GetDirectories(packRoot)
            .OrderByDescending((path string) -> path, StringComparer.Ordinal)
            .FirstOrDefault((path string) -> Directory.Exists(Path.Combine(path, "ref", "net10.0"))) ??
            throw InvalidOperationException("The net10.0 targeting pack was not found.")
        let generator = Path.Combine(pack, "analyzers", "dotnet", "cs", "System.Text.RegularExpressions.Generator.dll")
        Assert.True(File.Exists(generator), generator)
        let document = XDocument.Parse(Project)
        let root = document.Root ?? throw InvalidOperationException("The test project has no root.")
        let properties = root.Elements("PropertyGroup").Single()
        properties.SetElementValue("GsharpToolFullPath", typeof(GsgenTask).Assembly.Location)
        properties.SetElementValue("GsgenToolFullPath", gsgen)
        properties.SetElementValue("FrameworkReferences", Path.Combine(pack, "ref", "net10.0", "*.dll"))
        properties.SetElementValue("GeneratorAssembly", generator)
        root
            .Elements("Import")
            .Single()
            .SetAttributeValue("Project", Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets"))
        document.Save(Path.Combine(directory, "Generators.proj"))
    }

    shared {
        private const Project string = `<Project DefaultTargets="_GsharpRunSourceGenerators">
  <PropertyGroup>
    <IntermediateOutputPath>obj/</IntermediateOutputPath>
    <TargetName>Probe</TargetName>
    <GSharpUseSharedCompilation>false</GSharpUseSharedCompilation>
    <GSharpWorkerGrant>1</GSharpWorkerGrant>
  </PropertyGroup>
  <Import Project="placeholder" />
  <ItemGroup>
    <Compile Include="*.gs" />
    <ReferencePathWithRefAssemblies Include="$(FrameworkReferences)" />
    <GsharpAnalyzer Include="$(GeneratorAssembly)" Condition="'$(UseGenerators)' != 'False'" />
    <AdditionalFiles Include="Input.txt" Condition="'$(UseAdditional)' != 'False'">
      <SourceItemGroup>$(AdditionalGroup)</SourceItemGroup>
    </AdditionalFiles>
  </ItemGroup>
  <Target Name="_GsharpResolveAnalyzers" />
  <Target Name="ResolveReferences" />
</Project>`
    }
}
