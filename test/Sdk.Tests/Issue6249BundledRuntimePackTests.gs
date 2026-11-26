// <copyright file="Issue6249BundledRuntimePackTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import System
import System.Collections
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.IO.Compression
import System.Linq
import System.Text
import System.Xml.Linq
import Gsharp.NET.Sdk.Tools
import Microsoft.Build.Framework
import Microsoft.Build.Utilities
import Xunit

/// Issue #6249: verifies `ResolveReferencedGsharpRuntimesTask` and the
/// `_GsharpGetBundledRuntimesForPack` MSBuild target pack transitively
/// referenced bundled G# runtime assemblies into `lib/<tfm>/` (and `ref/<tfm>/`
/// when referenced by the reference assembly) without adding unreferenced ones.
class Issue6249BundledRuntimePackTests : IDisposable {
    private let directory string = Path.Combine(
        RepoRoot.Path,
        "out",
        "test",
        "Issue6249BundledRuntimePackTests",
        Guid.NewGuid().ToString("N")
    )

    init() {
        Directory.CreateDirectory(directory)
    }

    func Dispose() -> Directory.Delete(directory, recursive: true)

    @Fact
    func Task_ResolvesTransitiveClosure_ForExtensionsAssembly() {
        let extensionsPath = FindOutputDll("Gsharp.Extensions", "Gsharp.Extensions.dll")
        let channelsPath = FindOutputDll("Gsharp.Runtime.Channels", "Gsharp.Runtime.Channels.dll")
        let valuesPath = FindOutputDll("Gsharp.Runtime.Values", "Gsharp.Runtime.Values.dll")

        // Gsharp.Extensions references Gsharp.Runtime.Channels.
        let engine = CapturingBuildEngine()
        let task = ResolveReferencedGsharpRuntimesTask(){
            BuildEngine = engine,
            AssemblyPath = extensionsPath,
            BundledRuntimeCandidates = []ITaskItem{
                TaskItem(valuesPath),
                TaskItem(channelsPath),
                TaskItem(extensionsPath)
            }
        }
        Assert.True(task.Execute())
        Assert.Empty(engine.Warnings)
        let names = task.ReferencedRuntimes.Select((item ITaskItem) -> Path.GetFileName(item.ItemSpec)).ToArray()
        Assert.Equal([]string{"Gsharp.Runtime.Channels.dll"}, names)
    }

    @Fact
    func Task_ReturnsEmpty_ForAssemblyWithoutBundledRuntimeRefs() {
        let channelsPath = FindOutputDll("Gsharp.Runtime.Channels", "Gsharp.Runtime.Channels.dll")
        let valuesPath = FindOutputDll("Gsharp.Runtime.Values", "Gsharp.Runtime.Values.dll")
        let extensionsPath = FindOutputDll("Gsharp.Extensions", "Gsharp.Extensions.dll")

        // Gsharp.Runtime.Values has no references to any bundled G# runtime.
        let engine = CapturingBuildEngine()
        let task = ResolveReferencedGsharpRuntimesTask(){
            BuildEngine = engine,
            AssemblyPath = valuesPath,
            BundledRuntimeCandidates = []ITaskItem{
                TaskItem(extensionsPath),
                TaskItem(channelsPath),
                TaskItem(valuesPath)
            }
        }
        Assert.True(task.Execute())
        Assert.Empty(engine.Warnings)
        Assert.Empty(task.ReferencedRuntimes)
    }

    @Fact
    func Task_LogsWarning_WhenKnownBundledRuntimeCandidateIsMissing() {
        let extensionsPath = FindOutputDll("Gsharp.Extensions", "Gsharp.Extensions.dll")
        let engine = CapturingBuildEngine()
        let task = ResolveReferencedGsharpRuntimesTask(){
            BuildEngine = engine,
            AssemblyPath = extensionsPath,
            BundledRuntimeCandidates = Array.Empty[ITaskItem]()
        }
        Assert.True(task.Execute())
        Assert.Empty(task.ReferencedRuntimes)
        Assert.Contains(
            engine.Warnings,
            (msg string) -> msg.Contains("Gsharp.Runtime.Channels", StringComparison.Ordinal)
        )
    }

    @Fact
    func PackTarget_IncludesTransitiveBundledRuntimes_InLibAndRef() {
        let extensionsPath = FindOutputDll("Gsharp.Extensions", "Gsharp.Extensions.dll")
        let channelsPath = FindOutputDll("Gsharp.Runtime.Channels", "Gsharp.Runtime.Channels.dll")
        let valuesPath = FindOutputDll("Gsharp.Runtime.Values", "Gsharp.Runtime.Values.dll")

        // Isolate from repository Directory.Build.props/targets.
        File.WriteAllText(Path.Combine(directory, "Directory.Build.props"), "<Project />\n")
        File.WriteAllText(Path.Combine(directory, "Directory.Build.targets"), "<Project />\n")

        // Use Gsharp.Extensions.dll as both TargetPath and TargetRefPath so the
        // pack target must discover its dependency on Gsharp.Runtime.Channels.
        let document = XDocument.Parse(`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ProduceReferenceAssembly>true</ProduceReferenceAssembly>
    <GeneratePackageOnBuild>false</GeneratePackageOnBuild>
    <IncludeSymbols>false</IncludeSymbols>
    <DebugSymbols>false</DebugSymbols>
    <DebugType>none</DebugType>
    <IsPackable>true</IsPackable>
    <PackageId>PackRuntimeTest</PackageId>
    <Version>1.0.0</Version>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <Import Project="" />
  <PropertyGroup>
    <TargetPath>$(FixtureAssembly)</TargetPath>
    <TargetRefPath>$(FixtureAssembly)</TargetRefPath>
  </PropertyGroup>
  <Target Name="BuiltProjectOutputGroup" Returns="@(BuiltProjectOutputGroupOutput)">
    <ItemGroup>
      <BuiltProjectOutputGroupOutput Include="$(TargetPath)" TargetPath="PackRuntime.dll" FinalOutputPath="$(TargetPath)" />
    </ItemGroup>
  </Target>
</Project>`)
        let root = document.Root ?? throw InvalidOperationException("The fixture has no root.")
        let properties = root.Elements("PropertyGroup").First()
        properties.SetElementValue("GsharpToolFullPath", typeof(BuildTask).Assembly.Location)
        properties.SetElementValue("FixtureAssembly", extensionsPath)
        properties.SetElementValue("GsharpExtensionsAssemblyFullPath", extensionsPath)
        properties.SetElementValue("GsharpChannelsRuntimeAssemblyFullPath", channelsPath)
        properties.SetElementValue("GsharpValuesRuntimeAssemblyFullPath", valuesPath)
        root
            .Elements("Import")
            .Last()
            .SetAttributeValue("Project", Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets"))
        document.Save(Path.Combine(directory, "PackRuntime.proj"))

        let start = ProcessStartInfo("dotnet"){
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        }
        for argument in[]string{
            "msbuild",
            "PackRuntime.proj",
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
        let stdoutTask = process.StandardOutput.ReadToEndAsync()
        let stderrTask = process.StandardError.ReadToEndAsync()
        process.WaitForExit()
        let output = stdoutTask.GetAwaiter().GetResult() + stderrTask.GetAwaiter().GetResult()
        Assert.True(process.ExitCode == 0, output)

        let packages = Directory.GetFiles(Path.Combine(directory, "bin", "Release"), "*.nupkg")
        Assert.Single(packages)
        using let archive = ZipFile.OpenRead(packages[0])
        let entries = archive.Entries.Select((e ZipArchiveEntry) -> e.FullName).ToHashSet(StringComparer.Ordinal)
        Assert.Contains("lib/net10.0/Gsharp.Runtime.Channels.dll", entries)
        Assert.DoesNotContain("lib/net10.0/Gsharp.Runtime.Values.dll", entries)
        Assert.Contains("ref/net10.0/Gsharp.Runtime.Channels.dll", entries)
        Assert.DoesNotContain("ref/net10.0/Gsharp.Runtime.Values.dll", entries)
    }

    private func FindOutputDll(projectFolder string, fileName string) string {
        let path = Path.Combine(RepoRoot.Path, "out", "bin", "Release", projectFolder, fileName)
        Assert.True(File.Exists(path), "Expected build output at " + path)
        return path
    }

    private class CapturingBuildEngine : IBuildEngine {
        let Warnings List[string] = List[string]()

        prop ContinueOnError bool -> false
        prop LineNumberOfTaskNode int32 -> 0
        prop ColumnNumberOfTaskNode int32 -> 0
        prop ProjectFileOfTaskNode string -> ""

        func BuildProjectFile(
            projectFileName string,
            targetNames[]string,
            globalProperties IDictionary,
            targetOutputs IDictionary
        ) bool -> false

        func LogCustomEvent(e CustomBuildEventArgs) { }

        func LogErrorEvent(e BuildErrorEventArgs) { }

        func LogMessageEvent(e BuildMessageEventArgs) { }

        func LogWarningEvent(e BuildWarningEventArgs) -> Warnings.Add(e.Message ?? "")
    }
}
