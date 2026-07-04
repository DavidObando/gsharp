// <copyright file="Issue1904AsyncMainTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1904: <c>async Task Main()</c> / <c>async Task&lt;int&gt; Main()</c>
/// must translate to G# top-level statements driven by the gsc-emitted
/// synchronous async-entry-point wrapper (see
/// <c>Issue1904AsyncEntryPointEmitTests</c> on the gsc side), NOT to a shape
/// that the CLR rejects at process start.
/// <para>
/// <c>Compilation.GetEntryPoint</c> only resolves when the compilation's
/// <see cref="OutputKind"/> is <see cref="OutputKind.ConsoleApplication"/>, so
/// these tests pass that explicitly to
/// <see cref="CSharpProjectLoader.LoadInMemory"/> (the default remains a
/// library, unchanged for every other test in this suite).
/// </para>
/// </summary>
public class Issue1904AsyncMainTranslationTests
{
    [Fact]
    public void AsyncTaskMain_NoArgs_LowersToTopLevelAwaitStatements()
    {
        string rendered = Render(@"
using System;
using System.Threading.Tasks;

internal static class Program
{
    private static async Task Main()
    {
        Console.WriteLine(""start"");
        await Task.Delay(1);
        Console.WriteLine(""end"");
    }
}
");

        Assert.Contains("await Task.Delay(1)", rendered, StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine(\"start\")", rendered, StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine(\"end\")", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("func Main", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void AsyncTaskIntMain_ReturnStatement_LowersToTopLevelReturn()
    {
        string rendered = Render(@"
using System;
using System.Threading.Tasks;

internal static class Program
{
    private static async Task<int> Main()
    {
        await Task.Delay(1);
        return 7;
    }
}
");

        Assert.Contains("await Task.Delay(1)", rendered, StringComparison.Ordinal);
        Assert.Contains("return 7", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void AsyncTaskMain_StringArgsParameter_LowersToImplicitArgsIdentifier()
    {
        // Main's `string[]` parameter can be named anything; G# top-level
        // statements only ever expose the fixed implicit `args` (ADR-0066 D1),
        // so a renamed parameter must be substituted to `args` in the body.
        string rendered = Render(@"
using System;
using System.Threading.Tasks;

internal static class Program
{
    private static async Task Main(string[] arguments)
    {
        Console.WriteLine(arguments.Length);
        await Task.Delay(1);
    }
}
");

        Assert.Contains("args.Length", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("arguments", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Program.cs", source) },
            outputKind: OutputKind.ConsoleApplication);

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        // The entry-type hoist itself always logs an Info diagnostic (T3 /
        // ADR-0115 §B.1) — only reject Warning/Unsupported here.
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity != TranslationSeverity.Info);
        return GSharpPrinter.Print(unit);
    }
}
