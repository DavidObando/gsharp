// <copyright file="Issue5271ReferenceAssemblyPackTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import System
import System.Collections.Generic
import System.ComponentModel
import System.Diagnostics
import System.IO
import System.IO.Compression
import System.Linq
import System.Text
import System.Threading
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
        let output = CompleteProcess(process)
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
        // This restored SDK fixture emits dependency groups even when they contain no dependencies.
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

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Timeout_PreservesOutputAndThePrimaryFailure_WhenTerminationRacesWithExit(exitRace bool) {
        let ready = Path.Combine(directory, "ready")
        File.WriteAllText(Path.Combine(directory, "Blocking.proj"), `<Project>
  <UsingTask TaskName="Block" TaskFactory="RoslynCodeTaskFactory"
             AssemblyFile="$(MSBuildToolsPath)/Microsoft.Build.Tasks.Core.dll">
    <ParameterGroup><Ready ParameterType="System.String" Required="true" /></ParameterGroup>
    <Task><Code Type="Fragment" Language="cs"><![CDATA[
      System.Console.Out.Write("stdout tail");
      System.Console.Out.Flush();
      System.Console.Error.Write("stderr tail");
      System.Console.Error.Flush();
      System.IO.File.WriteAllText(Ready, "ready");
      System.Threading.Thread.Sleep(60000);
    ]]></Code></Task>
  </UsingTask>
  <Target Name="Block"><Block Ready="$(Ready)" /></Target>
</Project>`)
        let start = ProcessStartInfo("dotnet"){
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        }
        start.Environment["TMPDIR"] = directory
        start.Environment["TEMP"] = directory
        start.Environment["TMP"] = directory
        for argument in[]string{"msbuild", "Blocking.proj", "-nr:false", "-nologo", "-v:q", "-p:Ready=$ready"} {
            start.ArgumentList.Add(argument)
        }
        using let process = Process.Start(start) ?? throw InvalidOperationException("Cannot start timeout fixture.")
        try {
            Assert.True(SpinWait.SpinUntil(() -> File.Exists(ready), 10000), "The owned child did not become ready.")
            var terminate Action[Process]? = nil
            if exitRace {
                terminate = (owned Process) -> {
                    owned.Kill(entireProcessTree: true)
                    Assert.True(owned.WaitForExit(5000), "The owned child did not exit.")
                    throw InvalidOperationException("Simulated exit race.")
                }
            }
            let elapsed = Stopwatch.StartNew()
            let error = Assert.Throws[TimeoutException](() -> CompleteProcess(process, 1, terminate))
            Assert.Contains("fixture timed out", error.Message)
            Assert.Contains("stdout tail", error.Message)
            Assert.Contains("stderr tail", error.Message)
            Assert.True(process.HasExited, "Timeout cleanup left the owned child alive.")
            Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(15), "Timeout cleanup exceeded its bounds.")
            if exitRace {
                Assert.Contains("Simulated exit race.", error.ToString())
            }
        } finally {
            try {
                process.Kill(entireProcessTree: true)
            } catch (InvalidOperationException) {
                Assert.True(process.HasExited)
            }
            Assert.True(process.WaitForExit(5000), "The owned child survived test cleanup.")
        }
    }

    shared {
        private func CompleteProcess(
            process Process,
            timeoutMilliseconds int32 = 120000,
            terminate Action[Process]? = nil
        ) string {
            let stdout = StringBuilder()
            let stderr = StringBuilder()
            using let stop = CancellationTokenSource()
            let readers = Task.WhenAll(
                ReadOutput(process.StandardOutput, stdout, stop.Token),
                ReadOutput(process.StandardError, stderr, stop.Token)
            )
            let exited = process.WaitForExit(timeoutMilliseconds)
            if !exited || !CompletesWithin(readers, 5000) {
                let failures = List[Exception]()
                try {
                    if terminate == nil {
                        process.Kill(entireProcessTree: true)
                    } else {
                        terminate(process)
                    }
                } catch (ex InvalidOperationException) {
                    failures.Add(ex)
                } catch (ex Win32Exception) {
                    failures.Add(ex)
                } catch (ex AggregateException) {
                    failures.Add(ex)
                }
                var stopped = false
                try {
                    stopped = process.WaitForExit(5000)
                } catch (ex Win32Exception) {
                    failures.Add(ex)
                }
                let drained = CompletesWithin(readers, 5000)
                if !drained {
                    stop.Cancel()
                    CompletesWithin(readers, 1000)
                }
                if readers.Exception is {} readFailure {
                    failures.Add(readFailure)
                }
                var cause Exception? = nil
                if failures.Count > 0 {
                    cause = AggregateException(failures)
                }
                throw TimeoutException(
                    "The metadata-only pack fixture timed out. Child exited: $stopped; pipes drained: $drained.\n" +
                        "stdout:\n${Snapshot(stdout)}\nstderr:\n${Snapshot(stderr)}",
                    cause
                )
            }
            if readers.IsFaulted || readers.IsCanceled {
                throw IOException(
                    "Pack output capture failed.\nstdout:\n${Snapshot(stdout)}\nstderr:\n${Snapshot(stderr)}",
                    readers.Exception
                )
            }
            return Snapshot(stdout) + Snapshot(stderr)
        }

        private func CompletesWithin(task Task, milliseconds int32) bool ->
        Task.WhenAny(task, Task.Delay(milliseconds)).GetAwaiter().GetResult() == task

        private async func ReadOutput(reader StreamReader, output StringBuilder, cancellation CancellationToken) Task {
            let buffer = [1024]char
            while true {
                let count = await reader.ReadAsync(buffer.AsMemory(), cancellation)
                if count == 0 {
                    return
                }
                lock output {
                    output.Append(buffer, 0, count)
                }
            }
        }

        private func Snapshot(output StringBuilder) string {
            lock output {
                return output.ToString()
            }
        }

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
