// <copyright file="Issue3090AwaitInvocationArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

@Collection("IlVerifyPipeline")
class Issue3090AwaitInvocationArgumentTests {
    @Fact
    func PipelineFailureDetails_MissingArtifactPreservesOriginalFailure() {
        let result = RunResult{RunId: "missing-run"}
        let app = AppResult{Stages: {StageResult{Stage: "compile", Status: "failed"}}, Artifacts: {"missing.json"}}
        let details = PipelineFailureDetails(AppContext.BaseDirectory, result, app)
        Assert.Contains("compile=failed", details, StringComparison.Ordinal)
        Assert.Contains("Artifact unavailable:", details, StringComparison.Ordinal)
    }

    @Fact
    func NestedAwaitNamedArguments_PreserveNamesWithoutTranslatorSpills() {
        let printed = Translate(`using System.Threading;
using System.Threading.Tasks;

public sealed class Store
{
    public Task<int> GetDueAtAsync(int id, CancellationToken ct) =>
        Task.FromResult(id);
}

public sealed class Queue
{
    public Task EnqueueAsync(
        string job,
        int priority,
        int dueAt,
        CancellationToken ct) =>
        Task.CompletedTask;
}

public static class Scenario
{
    public static async Task RunAsync(
        Queue queue,
        Store store,
        int id,
        CancellationToken ct)
    {
        await queue.EnqueueAsync(
            "job",
            priority: 0,
            dueAt: await store.GetDueAtAsync(id, ct),
            ct: ct);
    }
}`)
        Assert.Contains("priority: 0", printed, StringComparison.Ordinal)
        Assert.Contains("dueAt: await store.GetDueAtAsync(id, ct)", printed, StringComparison.Ordinal)
        Assert.Contains("ct: ct", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        AssertRoundTrip(printed)
    }

    @Fact
    func ReorderedNamedAwaitArguments_PreserveLexicalSourceOrder() {
        let printed = Translate(`using System.Threading.Tasks;

public sealed class Receiver
{
    public Task ReceiveAsync(
        string label,
        int before,
        int value,
        int after) =>
        Task.CompletedTask;
}

public static class Scenario
{
    public static async Task RunAsync()
    {
        await GetReceiver().ReceiveAsync(
            after: After(3),
            label: "named",
            value: await InnerAsync(2),
            before: Before(1));
    }

    private static Receiver GetReceiver() => new Receiver();
    private static int Before(int value) => value;
    private static int After(int value) => value;
    private static Task<int> InnerAsync(int value) => Task.FromResult(value);
}`)
        AssertInOrder(
            printed,
            "GetReceiver().ReceiveAsync(",
            "after: After(3)",
            "label: \"named\"",
            "value: await InnerAsync(2)",
            "before: Before(1)"
        )
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        AssertRoundTrip(printed)
    }

    @Fact
    func ConditionalAndRefOutAwaitArguments_RemainNative() {
        let printed = Translate(`using System.Threading.Tasks;

public sealed class Receiver
{
    public Receiver? Next { get; }
    public Task ReceiveAsync(int value) => Task.CompletedTask;
}

public static class Scenario
{
    public static async Task ConditionalAsync(Receiver? receiver)
    {
        Task? direct = receiver?.ReceiveAsync(value: await InnerAsync());
        Task? chained = receiver?.Next!.ReceiveAsync(value: await InnerAsync());
        if (direct is not null)
        {
            await direct;
        }

        if (chained is not null)
        {
            await chained;
        }
    }

    public static async Task RefOutAsync()
    {
        int a = 0;
        int b;
        await SetRefAsync(ref a, value: await InnerAsync());
        await SetOutAsync(out b, value: await InnerAsync());
    }

    private static Task<int> InnerAsync() => Task.FromResult(1);
    private static Task SetRefAsync(ref int slot, int value)
    {
        slot = value;
        return Task.CompletedTask;
    }

    private static Task SetOutAsync(out int slot, int value)
    {
        slot = value;
        return Task.CompletedTask;
    }
}`)
        Assert.Contains("receiver?.ReceiveAsync(value: await InnerAsync())", printed, StringComparison.Ordinal)
        Assert.Contains("receiver?.Next!!.ReceiveAsync(value: await InnerAsync())", printed, StringComparison.Ordinal)
        Assert.Contains("SetRefAsync(&a, value: await InnerAsync())", printed, StringComparison.Ordinal)
        Assert.Contains("SetOutAsync(out b, value: await InnerAsync())", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        AssertRoundTrip(printed)
    }

    @Fact
    func Mp4aNestedRecordStructNamedConstructor_RoundTripsWithoutNestedColon() {
        let printed = Translate(`public sealed class Entry
{
    public uint SamplesInFrame { get; }
}

public sealed class SttsBox
{
    public readonly record struct SampleEntry
    {
        public SampleEntry(uint sampleCount, uint sampleDelta)
        {
            FrameCount = sampleCount;
            FrameDelta = sampleDelta;
        }

        public uint FrameCount { get; }
        public uint FrameDelta { get; }
    }
}

public static class Scenario
{
    public static SttsBox.SampleEntry Create(Entry entry) =>
        new SttsBox.SampleEntry(
            sampleCount: 1,
            entry.SamplesInFrame);
}`)
        Assert.DoesNotContain("FrameCount: sampleCount:", printed, StringComparison.Ordinal)
        Assert.Contains("FrameCount: 1", printed, StringComparison.Ordinal)
        Assert.Contains("FrameDelta: entry.SamplesInFrame", printed, StringComparison.Ordinal)
        AssertRoundTrip(printed)
    }

    @Fact
    async func RecordStructNamedConstructor_PreservesLexicalEvaluationAndFieldBinding() {
        let compiler string? = FindCompiler()
        if compiler == nil || !IlVerifyToolAvailable() {
            return
        }
        const Source = `using System;

public readonly record struct RPoint
{
    public RPoint(int x = 0, int y = 0, int z = 9)
    {
        X = x;
        Y = y;
        Z = z;
    }

    public int X { get; }
    public int Y { get; }
    public int Z { get; }
}

public static class Side
{
    public static int Log(string label, int value)
    {
        Console.WriteLine(label);
        return value;
    }
}

public static class Program
{
    public static void Main()
    {
        var reversed = new RPoint(
            y: Side.Log("Y", 2),
            x: Side.Log("X", 1));
        Console.WriteLine($"{reversed.X},{reversed.Y},{reversed.Z}");

        var mixed = new RPoint(
            x: Side.Log("A", 3),
            Side.Log("B", 4));
        Console.WriteLine($"{mixed.X},{mixed.Y},{mixed.Z}");
    }
}`
        let sourceRoot = NewOutputRoot()
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
        let projectDirectory = Path.Combine(sourceRoot, "RecordStruct")
        Directory.CreateDirectory(projectDirectory)
        let projectPath = Path.Combine(projectDirectory, "RecordStruct.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), Source)
        let goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden")
        File.WriteAllText(goldenPath, `Y
X
1,2,9
A
B
3,4,9
`)
        let outputRoot = NewOutputRoot()
        let pipeline = MigrationPipeline(
            PipelineOptions{CompileViaSdk: false, GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        )
        let app = CorpusApp("test/Issue3090RecordStruct", projectPath, TargetKind.Exe, goldenPath)
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(
                Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id)),
                "*.gs",
                SearchOption.AllDirectories
            )
                .Select(File.ReadAllText)
        )
        AssertInOrder(emitted, "Y: Side.Log(\"Y\", 2)", "X: Side.Log(\"X\", 1)", "Z: 9")
        AssertInOrder(emitted, "X: Side.Log(\"A\", 3)", "Y: Side.Log(\"B\", 4)", "Z: 9")
        Assert.DoesNotContain("__spill", emitted, StringComparison.Ordinal)
        if !appResult.Succeeded {
            Assert.Fail(PipelineFailureDetails(outputRoot, result, appResult))
        }
        Assert.Equal(
            []string{"passed", "passed", "passed", "passed"},
            appResult.Stages.Select((stage StageResult) -> stage.Status).ToArray()
        )
    }

    @Fact
    async func G10AsyncConsole_NativeAwaitArguments_VerifyAndPreserveParity() {
        let compiler string? = FindCompiler()
        if compiler == nil || !IlVerifyToolAvailable() {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let outputRoot = NewOutputRoot()
        let pipeline = MigrationPipeline(
            PipelineOptions{CompileViaSdk: false, GscPath: compiler, OutputRoot: outputRoot}
        )
        let app = CorpusDiscovery.FindById(corpus, "corpus/G10-Async-Console")!!
        Assert.NotNull(app)
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(
                Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id)),
                "*.gs",
                SearchOption.AllDirectories
            )
                .Select(File.ReadAllText)
        )
        Assert.Contains("after: Trace(", emitted, StringComparison.Ordinal)
        Assert.Contains("value: await TraceAsync(", emitted, StringComparison.Ordinal)
        Assert.Contains("before: Trace(", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", emitted, StringComparison.Ordinal)
        Assert.Equal(1, CountOccurrences(emitted, "TraceReceiver(\"static-extension\")"))
        Assert.Equal(1, CountOccurrences(emitted, "CreateReceiver(\"bare-extension\")"))
        if !appResult.Succeeded {
            Assert.Fail(PipelineFailureDetails(outputRoot, result, appResult))
        }
        Assert.Equal(
            []string{"passed", "passed", "passed", "passed"},
            appResult.Stages.Select((stage StageResult) -> stage.Status).ToArray()
        )
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info
            )
            return GSharpPrinter.Print(unit)
        }

        private func AssertRoundTrip(printed string) {
            let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                roundTrip!!.Success,
                string.Join(Environment.NewLine, roundTrip!!.Errors) + Environment.NewLine + printed
            )
        }

        private func AssertInOrder(text string, fragments ...string) {
            var previous = -1
            for fragment in fragments {
                let current = text.IndexOf(fragment, previous + 1, StringComparison.Ordinal)
                Assert.True(
                    current > previous,
                    "Expected '$fragment' after offset $previous.${Environment.NewLine}$text"
                )
                previous = current
            }
        }

        private func CountOccurrences(text string, value string) int32 {
            var count = 0
            var start = 0
            while (start = text.IndexOf(value, start, StringComparison.Ordinal)) >= 0 {
                count++
                start += value.Length
            }
            return count
        }

        private func IlVerifyToolAvailable() bool {
            try {
                return !IlVerifyRunner.IsEnabled || IlVerifyRunner().EnsureToolAvailable()
            } catch {
                return false
            }
        }

        private func NewOutputRoot() string {
            let root = Path.Combine(
                AppContext.BaseDirectory,
                "pipeline-tests",
                "issue3090-native",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(root)
            return root
        }

        private func PipelineFailureDetails(outputRoot string, result RunResult, app AppResult) string -> string.Join(
            "; ",
            app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
        ) +
            Environment.NewLine +
            string
            .Join(
            Environment.NewLine,
            app.Artifacts.Select((path string) -> ReadArtifact(Path.Combine(outputRoot, result.RunId, path)))
        )

        private func ReadArtifact(path string) string {
            try {
                return File.ReadAllText(path)
            } catch (error IOException) {
                return "Artifact unavailable: '$path' (${error.Message})"
            } catch (error UnauthorizedAccessException) {
                return "Artifact unavailable: '$path' (${error.Message})"
            }
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Debug", "Release"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }

        private func ResolveCorpusDir() string? -> TestFixtureSource.Resolve("tools", "cs2gs", "corpus")
    }
}
