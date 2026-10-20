// <copyright file="Issue5039GeneratorIncrementalityTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import System
import System.Collections
import System.Diagnostics
import System.IO
import System.Linq
import System.Runtime.InteropServices
import System.Threading
import System.Threading.Tasks
import System.Xml.Linq
import Gsharp.NET.Sdk.Tools
import Microsoft.Build.Framework
import TaskItem = Microsoft.Build.Utilities.TaskItem
import Xunit

/// Exercises production generator targets with a real framework generator and host.
class Issue5039GeneratorIncrementalityTests : IDisposable {
    private var lastOutput string = string.Empty
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

    @Fact
    func RemovingFinalSourceAndAnalyzer_CleansGeneratedPartsBeforeCompileInclusion() {
        WriteProject()
        let source = Path.Combine(directory, "Input.gs")
        File.WriteAllText(source, `package App
import System.Text.RegularExpressions
partial class P {
    shared {
        @GeneratedRegex("a")
        private partial func Match() Regex;
    }
}
`)
        Build("App", "First", additional: false)
        let manifest = Path.Combine(directory, "obj", "gsgen", "gsgen.manifest")
        let generated = File
            .ReadAllLines(manifest)
            .Where((path string) -> path.Length > 0)
            .Select((path string) -> Path.GetFullPath(Path.Combine(directory, path)))
            .ToArray()
        Assert.NotEmpty(generated)
        Assert.All(generated, (path string) -> Assert.True(File.Exists(path)))
        File.Delete(source)
        let projectFile = Path.Combine(directory, "Generators.proj")
        let project = XDocument.Load(projectFile)
        let root = project.Root ?? throw InvalidOperationException("The test project has no root.")
        root.SetAttributeValue("DefaultTargets", "_GsharpIncludeGeneratedCompile")
        root.Add(
            XElement.Parse(
                "<Target Name=\"AssertEmptyCompile\" AfterTargets=\"_GsharpIncludeGeneratedCompile\"><Error Condition=\"'@(Compile)' != ''\" Text=\"Stale generated Compile items: @(Compile)\" /></Target>"
            )
        )
        project.Save(projectFile)
        Build("App", "First", additional: false, generators: false)
        Assert.Equal(string.Empty, File.ReadAllText(manifest))
        Assert.All(generated, (path string) -> Assert.False(File.Exists(path)))
        Assert.Equal(2, ReportCount())
        Build("App", "First", additional: false, generators: false)
        Assert.Equal(2, ReportCount())
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func DirectDiagnosticErrors_AreRepeatedUntilFixed_ThenReturnToNoOpBuilds(reuse bool, stderr bool) {
        WriteProject()
        File.WriteAllText(Path.Combine(directory, "Input.gs"), "package App\npartial class Foo {}")
        let additional = Path.Combine(directory, "Input.txt")
        File.WriteAllText(additional, "ok")
        let generator = CompileCSharpFixture(`using System.Linq;
using Microsoft.CodeAnalysis;
[Generator]
public sealed class RawDiagnosticGenerator : IIncrementalGenerator {
    public void Initialize(IncrementalGeneratorInitializationContext context) {
        context.RegisterSourceOutput(context.AdditionalTextsProvider.Collect(), (spc, files) => {
            if (files.Any(file => file.GetText().ToString() == "error"))
                __WRITER__.WriteLine("gsgen(1,1): error RAW5039: raw generator failure");
            spc.AddSource("Foo.g.cs", "namespace App { partial class Foo { public int Value => 1; } }");
        });
    }
}`.Replace(
                "__WRITER__",
                if stderr {
                    "System.Console.Error"
                } else {
                    "System.Console"
                }
            ), "RawDiagnosticGenerator", executable: false)
        let projectFile = Path.Combine(directory, "Generators.proj")
        let project = XDocument.Load(projectFile)
        project.Root?.Element("PropertyGroup")?.SetElementValue("GeneratorAssembly", generator)
        project.Save(projectFile)
        Build("App", "First", reuse: reuse)
        Assert.Equal(1, ReportCount())
        File.WriteAllText(additional, "error")
        Build("App", "First", error: "RAW5039", reuse: reuse)
        Assert.Equal(2, ReportCount())
        Build("App", "First", error: "RAW5039", reuse: reuse)
        Assert.Equal(3, ReportCount())
        File.WriteAllText(additional, "ok")
        Build("App", "First", reuse: reuse)
        Assert.Equal(4, ReportCount())
        Build("App", "First", reuse: reuse)
        Assert.Equal(4, ReportCount())
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ActualSdkInputs_InvalidateGlobalsAdditionalSourceReferenceAndGeneratorContent(reuse bool) {
        WriteProject()
        let source = Path.Combine(directory, "Input.gs")
        File.WriteAllText(source, "package App\n@Obsolete\npartial class Foo {}")
        let originalSourceTime = File.GetLastWriteTimeUtc(source)
        let additional = Path.Combine(directory, "Input.txt")
        File.WriteAllText(additional, "one")
        let reference = CompileCSharpFixture(
            "namespace Contract { public static class Marker { public const string Value = \"r1\"; } }",
            "Contract",
            executable: false
        )
        let generator = CompileCSharpFixture(
            SdkInputGenerator.Replace("__VERSION__", "g1"),
            "InputGenerator",
            executable: false
        )
        let projectFile = Path.Combine(directory, "Generators.proj")
        let project = XDocument.Load(projectFile)
        let root = project.Root ?? throw InvalidOperationException("The test project has no root.")
        root.Element("PropertyGroup")?.SetElementValue("GeneratorAssembly", generator)
        root.Add(XElement("ItemGroup", XElement("ReferencePathWithRefAssemblies", XAttribute("Include", reference))))
        project.Save(projectFile)
        let manifest = Path.Combine(directory, "obj", "gsgen", "gsgen.manifest")
        Build("App", "First", reuse: reuse, behavior: "off")
        Assert.Equal(1, ReportCount())
        Assert.Equal(string.Empty, File.ReadAllText(manifest))
        Build("App", "First", reuse: reuse, behavior: "off")
        Assert.Equal(1, ReportCount())

        let verify = (expected string, count int32, group string) -> {
            Build("App", group, reuse: reuse, behavior: "on")
            Assert.Equal(count, ReportCount())
            let generated = Assert.Single(File.ReadAllLines(manifest).Where((path string) -> path.Length > 0))
            Assert.Contains(expected, File.ReadAllText(Path.GetFullPath(Path.Combine(directory, generated))))
            Build("App", group, reuse: reuse, behavior: "on")
            Assert.Equal(count, ReportCount())
        }
        verify("g1|on|one|r1|1|First", 2, "First")
        Assert.Equal(originalSourceTime, File.GetLastWriteTimeUtc(source))
        File.WriteAllText(additional, "two")
        verify("g1|on|two|r1|1|First", 3, "First")
        verify("g1|on|two|r1|1|Second", 4, "Second")
        File.WriteAllText(source, "package App\n@Obsolete\n@CLSCompliant(true)\npartial class Foo {}")
        verify("g1|on|two|r1|2|Second", 5, "Second")
        let referenceIdentity = System.Reflection.AssemblyName.GetAssemblyName(reference).FullName
        CompileCSharpFixture(
            "namespace Contract { public static class Marker { public const string Value = \"r2\"; } }",
            "Contract",
            executable: false
        )
        Assert.Equal(referenceIdentity, System.Reflection.AssemblyName.GetAssemblyName(reference).FullName)
        verify("g1|on|two|r2|2|Second", 6, "Second")
        let generatorIdentity = System.Reflection.AssemblyName.GetAssemblyName(generator).FullName
        CompileCSharpFixture(SdkInputGenerator.Replace("__VERSION__", "g2"), "InputGenerator", executable: false)
        Assert.Equal(generatorIdentity, System.Reflection.AssemblyName.GetAssemblyName(generator).FullName)
        verify("g2|on|two|r2|2|Second", 7, "Second")
    }

    private func ReportCount() int32 -> Directory.GetFiles(directory, "phase-*.json").Length

    @Fact
    func RemovedGeneratedPart_ForcesFinalCompilation_InsteadOfLeavingThePreviousAssembly() {
        WriteProject(fullCompilation: true)
        File.WriteAllText(
            Path.Combine(directory, "Input.gs"),
            "package App\npublic class Consumer { public func Use() string -> Generated.Value }"
        )
        File.WriteAllText(
            Path.Combine(directory, "Foreign.cs"),
            "namespace App { public static class Generated { public static string Value => \"present\"; } }"
        )
        Build("App", "First", additional: false, generators: false)
        Assert.True(
            File.Exists(Path.Combine(directory, "obj", "Probe.dll")),
            lastOutput + "\n" + string.Join("\n", Directory.GetFiles(directory, "*", SearchOption.AllDirectories))
        )
        let manifest = Path.Combine(directory, "obj", "gsgen", "gsgen.manifest")
        let generated = Path.GetFullPath(
            Path.Combine(directory, Assert.Single(File.ReadAllLines(manifest).Where((line string) -> line.Length > 0)))
        )
        Assert.True(File.Exists(generated))
        Build("App", "First", additional: false, generators: false, foreign: false, error: "Generated")
        Assert.False(File.Exists(generated))
        Assert.Equal(string.Empty, File.ReadAllText(manifest))
    }

    @Fact
    func StandaloneCancellation_StopsGeneratorDescendants() {
        let pidFile = Path.Combine(directory, "helper.pid")
        let tool = CompileBlockingTool(pidFile)
        let engine = RecordingEngine()
        let task = GsgenTask{
            BuildEngine: engine,
            GsgenToolFullPath: tool,
            Compile: []ITaskItem{TaskItem(Path.Combine(directory, "Input.gs"))},
            BasePath: directory,
            OutputDir: Path.Combine(directory, "generated"),
            ManifestPath: Path.Combine(directory, "manifest"),
            ResponseFilePath: Path.Combine(directory, "generator.rsp")
        }
        let execution = System.Threading.Tasks.Task.Run(() -> task.Execute())
        try {
            Assert.True(SpinWait.SpinUntil(() -> File.Exists(pidFile), 10000))
            using let child = Process.GetProcessById(int32.Parse(File.ReadAllText(pidFile)))
            task.Cancel()
            Assert.True(execution.Wait(10000), "Cancellation did not complete while a generator helper was alive.")
            Assert.False(execution.Result)
            Assert.True(child.WaitForExit(10000), "Standalone cancellation left a generator helper alive.")
            Assert.False(engine.HadError)
        } finally {
            task.Cancel()
            if File.Exists(pidFile) {
                try {
                    using let child = Process.GetProcessById(int32.Parse(File.ReadAllText(pidFile)))
                    if !child.HasExited {
                        child.Kill(entireProcessTree: true)
                    }
                    child.WaitForExit()
                } catch (ex ArgumentException) {
                    // The owned helper already exited.

                }
            }
            Assert.True(execution.Wait(10000), "The cancelled task did not stop after helper cleanup.")
        }
    }

    private func CompileBlockingTool(pidFile string) string {
        return CompileCSharpFixture(`using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
class BlockingTool {
    static void Main(string[] args) {
        if (args[0] == "child") { Thread.Sleep(60000); return; }
        using var child = Process.Start(new ProcessStartInfo("dotnet") {
            UseShellExecute = false,
            ArgumentList = { typeof(BlockingTool).Assembly.Location, "child" }
        });
        File.WriteAllText(@"__PID__", child.Id.ToString());
        Thread.Sleep(60000);
    }
}`.Replace("__PID__", pidFile.Replace("\"", "\"\"")), "BlockingTool", executable: true)
    }

    private func CompileCSharpFixture(text string, name string, executable bool) string {
        let source = Path.Combine(directory, "$name.cs")
        File.WriteAllText(source, text)
        let sdkRoot = Path.GetFullPath(Path.Combine(RuntimeEnvironment.GetRuntimeDirectory(), "..", "..", "..", "sdk"))
        let compiler = Directory
            .GetDirectories(sdkRoot)
            .Select((path string) -> Path.Combine(path, "Roslyn", "bincore", "csc.dll"))
            .First(File.Exists)
        let tool = Path.Combine(directory, "$name.dll")
        let start = ProcessStartInfo("dotnet"){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        start.ArgumentList.Add(compiler)
        start.ArgumentList.Add("/nologo")
        start.ArgumentList.Add(
            if executable {
                "/target:exe"
            } else {
                "/target:library"
            }
        )
        start.ArgumentList.Add("/out:$tool")
        let references = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty).Split(
            Path.PathSeparator,
            StringSplitOptions.RemoveEmptyEntries
        )
        for reference in references {
            start.ArgumentList.Add("/r:$reference")
        }
        if !executable {
            let configuration = DirectoryInfo(AppContext.BaseDirectory).Parent?.Name ?? "Release"
            start.ArgumentList.Add(
                "/r:" + Path.Combine(
                    RepoRoot.Path,
                    "out",
                    "bin",
                    configuration,
                    "Gsgen.Cli",
                    "Microsoft.CodeAnalysis.dll"
                )
            )
        }
        start.ArgumentList.Add(source)
        using let process = Process.Start(start) ?? throw InvalidOperationException("Cannot compile blocking tool.")
        using let outputDeadline = CancellationTokenSource(TimeSpan.FromSeconds(30))
        let stdout = process.StandardOutput.ReadToEndAsync(outputDeadline.Token)
        let stderr = process.StandardError.ReadToEndAsync(outputDeadline.Token)
        if !process.WaitForExit(30000) {
            process.Kill(entireProcessTree: true)
            process.WaitForExit()
            throw TimeoutException("Blocking tool compilation timed out.")
        }
        System.Threading.Tasks.Task.WaitAll(stdout, stderr)
        Assert.True(process.ExitCode == 0, stdout.Result + stderr.Result)
        if executable {
            File.WriteAllText(
                Path.ChangeExtension(tool, ".runtimeconfig.json"),
                `{"runtimeOptions":{"tfm":"net10.0","framework":{"name":"Microsoft.NETCore.App","version":"10.0.0"}}}`
            )
        }
        return tool
    }

    private class RecordingEngine : IBuildEngine {
        prop HadError bool
        prop ContinueOnError bool -> false
        prop LineNumberOfTaskNode int32 -> 0
        prop ColumnNumberOfTaskNode int32 -> 0
        prop ProjectFileOfTaskNode string -> string.Empty
        func LogErrorEvent(e BuildErrorEventArgs) -> HadError = true

        func LogWarningEvent(e BuildWarningEventArgs) { }

        func LogMessageEvent(e BuildMessageEventArgs) { }

        func LogCustomEvent(e CustomBuildEventArgs) { }

        func BuildProjectFile(
            project string,
            targets[]string,
            properties IDictionary,
            outputs IDictionary
        ) bool -> false
    }

    private func Build(
        rootNamespace string,
        group string,
        additional bool = true,
        generators bool = true,
        foreign bool = true,
        error string? = nil,
        reuse bool = false,
        behavior string? = nil
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
            "-p:UseGenerators=${generators.ToString()}",
            "-p:UseForeign=${foreign.ToString()}",
            "-p:GSharpUseSharedCompilation=${reuse.ToString()}"
        } {
            start.ArgumentList.Add(argument)
        }
        if behavior != nil {
            start.ArgumentList.Add("-p:AvaloniaNameGeneratorBehavior=$behavior")
        }
        start.Environment["GSHARP_MEASURE_PHASES"] = Path.Combine(directory, "phase-{id}.json")
        using let process = Process.Start(start) ??
            throw InvalidOperationException("Cannot start generator target test.")
        using let outputDeadline = CancellationTokenSource(TimeSpan.FromSeconds(120))
        let stdout = process.StandardOutput.ReadToEndAsync(outputDeadline.Token)
        let stderr = process.StandardError.ReadToEndAsync(outputDeadline.Token)
        if !process.WaitForExit(120000) {
            process.Kill(entireProcessTree: true)
            process.WaitForExit()
            throw TimeoutException("Generator target test timed out.")
        }
        Task.WaitAll(stdout, stderr)
        let output = stdout.Result + stderr.Result
        lastOutput = output
        if error == nil {
            Assert.True(process.ExitCode == 0, output)
        } else {
            Assert.Contains(error, output)
            Assert.DoesNotContain("GS9998", output)
            Assert.True(process.ExitCode != 0, output)
        }
    }

    private func WriteProject(fullCompilation bool = false) {
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
        if fullCompilation {
            root.SetAttributeValue("DefaultTargets", "CoreCompile")
            properties.SetElementValue(
                "GsharpCompilerFullPath",
                Path.Combine(RepoRoot.Path, "out", "bin", configuration, "Compiler", "gsc.dll")
            )
            properties.SetElementValue("TargetFramework", "net10.0")
            properties.SetElementValue("OutputType", "Library")
            root.Add(
                XElement.Parse(
                    "<ItemGroup><IntermediateAssembly Include=\"obj/Probe.dll\" /><Compile Include=\"Foreign.cs\" Condition=\"'$(UseForeign)' != 'False'\" /></ItemGroup>"
                )
            )
            root.Add(XElement.Parse("<Target Name=\"_ComputeNonExistentFileProperty\" />"))
        }
        document.Save(Path.Combine(directory, "Generators.proj"))
    }

    shared {
        private const SdkInputGenerator string = `using System.Linq;
using Microsoft.CodeAnalysis;
[Generator]
public sealed class InputGenerator : IIncrementalGenerator {
    public void Initialize(IncrementalGeneratorInitializationContext context) {
        var inputs = context.CompilationProvider.Combine(context.AdditionalTextsProvider.Collect())
            .Combine(context.AnalyzerConfigOptionsProvider);
        context.RegisterSourceOutput(inputs, (spc, input) => {
            input.Right.GlobalOptions.TryGetValue("build_property.AvaloniaNameGeneratorBehavior", out var behavior);
            if (behavior != "on") return;
            var compilation = input.Left.Left;
            var files = input.Left.Right;
            var additional = files.IsEmpty ? "" : files[0].GetText().ToString();
            var group = "";
            if (!files.IsEmpty)
                input.Right.GetOptions(files[0]).TryGetValue("build_metadata.AdditionalFiles.SourceItemGroup", out group);
            var marker = compilation.GetTypeByMetadataName("Contract.Marker");
            var value = (marker.GetMembers("Value").First() as IFieldSymbol).ConstantValue as string;
            var attributes = compilation.GetTypeByMetadataName("App.Foo").GetAttributes().Length;
            var text = "__VERSION__|" + behavior + "|" + additional + "|" + value + "|" + attributes + "|" + group;
            spc.AddSource("Foo.g.cs", "namespace App { partial class Foo { public string Value => \"" + text + "\"; } }");
        });
    }
}`

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
