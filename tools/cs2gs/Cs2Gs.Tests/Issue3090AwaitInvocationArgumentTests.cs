// <copyright file="Issue3090AwaitInvocationArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

[Collection(IlVerifyPipelineCollection.Name)]
public sealed class Issue3090AwaitInvocationArgumentTests
{
    [Fact]
    public void NestedAwaitNamedArguments_PreserveNamesWithoutTranslatorSpills()
    {
        string printed = Translate("""
            using System.Threading;
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
            }
            """);

        Assert.Contains("priority: 0", printed, StringComparison.Ordinal);
        Assert.Contains(
            "dueAt: await store.GetDueAtAsync(id, ct)",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("ct: ct", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        AssertRoundTrip(printed);
    }

    [Fact]
    public void ReorderedNamedAwaitArguments_PreserveLexicalSourceOrder()
    {
        string printed = Translate("""
            using System.Threading.Tasks;

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
            }
            """);

        AssertInOrder(
            printed,
            "GetReceiver().ReceiveAsync(",
            "after: After(3)",
            "label: \"named\"",
            "value: await InnerAsync(2)",
            "before: Before(1)");
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        AssertRoundTrip(printed);
    }

    [Fact]
    public void ConditionalAndRefOutAwaitArguments_RemainNative()
    {
        string printed = Translate("""
            using System.Threading.Tasks;

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
            }
            """);

        Assert.Contains(
            "receiver?.ReceiveAsync(value: await InnerAsync())",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "receiver?.Next!!.ReceiveAsync(value: await InnerAsync())",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "SetRefAsync(&a, value: await InnerAsync())",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "SetOutAsync(out b, value: await InnerAsync())",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        AssertRoundTrip(printed);
    }

    [Fact]
    public void Mp4aNestedRecordStructNamedConstructor_RoundTripsWithoutNestedColon()
    {
        string printed = Translate("""
            public sealed class Entry
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
            }
            """);

        Assert.DoesNotContain("FrameCount: sampleCount:", printed, StringComparison.Ordinal);
        Assert.Contains("FrameCount: 1", printed, StringComparison.Ordinal);
        Assert.Contains(
            "FrameDelta: entry.SamplesInFrame",
            printed,
            StringComparison.Ordinal);
        AssertRoundTrip(printed);
    }

    [Fact]
    public async Task RecordStructNamedConstructor_PreservesLexicalEvaluationAndFieldBinding()
    {
        string compiler = FindCompiler();
        if (compiler is null || !IlVerifyToolAvailable())
        {
            return;
        }

        const string Source = """
            using System;

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
            }
            """;

        string sourceRoot = NewOutputRoot();
        File.WriteAllText(
            Path.Combine(sourceRoot, "Directory.Build.props"),
            "<Project></Project>");
        string projectDirectory = Path.Combine(sourceRoot, "RecordStruct");
        Directory.CreateDirectory(projectDirectory);
        string projectPath = Path.Combine(projectDirectory, "RecordStruct.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), Source);
        string goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden");
        File.WriteAllText(
            goldenPath,
            "Y\nX\n1,2,9\nA\nB\n3,4,9\n");

        string outputRoot = NewOutputRoot();
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                CompileViaSdk = false,
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
            });
        var app = new CorpusApp(
            "test/Issue3090RecordStruct",
            projectPath,
            TargetKind.Exe,
            goldenPath);
        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(
                    Path.Combine(
                        outputRoot,
                        result.RunId,
                        MigrationPipeline.SanitizeAppId(app.Id)),
                    "*.gs",
                    SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        AssertInOrder(
            emitted,
            "Y: Side.Log(\"Y\", 2)",
            "X: Side.Log(\"X\", 1)",
            "Z: 9");
        AssertInOrder(
            emitted,
            "X: Side.Log(\"A\", 3)",
            "Y: Side.Log(\"B\", 4)",
            "Z: 9");
        Assert.DoesNotContain("__spill", emitted, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
        Assert.Equal(
            new[] { "passed", "passed", "passed", "passed" },
            appResult.Stages.Select(stage => stage.Status).ToArray());
    }

    [Fact]
    public async Task G10AsyncConsole_NativeAwaitArguments_VerifyAndPreserveParity()
    {
        string compiler = FindCompiler();
        if (compiler is null || !IlVerifyToolAvailable())
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        string outputRoot = NewOutputRoot();
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                CompileViaSdk = false,
                GscPath = compiler,
                OutputRoot = outputRoot,
            });
        CorpusApp app = CorpusDiscovery.FindById(corpus, "corpus/G10-Async-Console");
        Assert.NotNull(app);

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(
                    Path.Combine(
                        outputRoot,
                        result.RunId,
                        MigrationPipeline.SanitizeAppId(app.Id)),
                    "*.gs",
                    SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.Contains("after: Trace(", emitted, StringComparison.Ordinal);
        Assert.Contains(
            "value: await TraceAsync(",
            emitted,
            StringComparison.Ordinal);
        Assert.Contains("before: Trace(", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", emitted, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(emitted, "TraceReceiver(\"static-extension\")"));
        Assert.Equal(1, CountOccurrences(emitted, "CreateReceiver(\"bare-extension\")"));
        Assert.True(
            appResult.Succeeded,
            string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
        Assert.Equal(
            new[] { "passed", "passed", "passed", "passed" },
            appResult.Stages.Select(stage => stage.Status).ToArray());
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Source.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity != TranslationSeverity.Info);
        return GSharpPrinter.Print(unit);
    }

    private static void AssertRoundTrip(string printed)
    {
        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            roundTrip.Success,
            string.Join(Environment.NewLine, roundTrip.Errors) + Environment.NewLine + printed);
    }

    private static void AssertInOrder(string text, params string[] fragments)
    {
        int previous = -1;
        foreach (string fragment in fragments)
        {
            int current = text.IndexOf(fragment, previous + 1, StringComparison.Ordinal);
            Assert.True(
                current > previous,
                $"Expected '{fragment}' after offset {previous}.{Environment.NewLine}{text}");
            previous = current;
        }
    }

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        int start = 0;
        while ((start = text.IndexOf(value, start, StringComparison.Ordinal)) >= 0)
        {
            count++;
            start += value.Length;
        }

        return count;
    }

    private static bool IlVerifyToolAvailable()
    {
        try
        {
            return !IlVerifyRunner.IsEnabled || new IlVerifyRunner().EnsureToolAvailable();
        }
        catch
        {
            return false;
        }
    }

    private static string NewOutputRoot()
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            "pipeline-tests",
            "issue3090-native",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindCompiler()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Debug", "Release" })
            {
                string candidate = Path.Combine(
                    directory.FullName,
                    "out",
                    "bin",
                    configuration,
                    "Compiler",
                    "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }

    private static string ResolveCorpusDir()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            string candidate = Path.Combine(directory.FullName, "tools", "cs2gs", "corpus");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not locate tools/cs2gs/corpus above " + AppContext.BaseDirectory);
    }
}
