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
            "after: Scenario.After(3)",
            "label: \"named\"",
            "value: await Scenario.InnerAsync(2)",
            "before: Scenario.Before(1)");
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
            "receiver?.ReceiveAsync(value: await Scenario.InnerAsync())",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "receiver?.Next!!.ReceiveAsync(value: await Scenario.InnerAsync())",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "Scenario.SetRefAsync(&a, value: await Scenario.InnerAsync())",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "Scenario.SetOutAsync(&b, value: await Scenario.InnerAsync())",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        AssertRoundTrip(printed);
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

        Assert.Contains("after: AwaitExpressionFixture.Trace(", emitted, StringComparison.Ordinal);
        Assert.Contains(
            "value: await AwaitExpressionFixture.TraceAsync(",
            emitted,
            StringComparison.Ordinal);
        Assert.Contains("before: AwaitExpressionFixture.Trace(", emitted, StringComparison.Ordinal);
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
        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
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
