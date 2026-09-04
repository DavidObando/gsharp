// <copyright file="Adr0174SuspendFuncTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0174 D4 (P3-7): a C# <c>async ValueTask</c>/<c>ValueTask&lt;T&gt;</c>
/// method that uses the Gsharp.Concurrency runtime — or carries
/// <c>[Suspending]</c>, the attribute G# stamps on every suspending function —
/// translates to a G# <c>suspend func</c> with the awaited result type. An
/// <c>async ValueTask&lt;T&gt;</c> method that never touches the runtime keeps
/// ADR-0115 B.23's explicit <c>ValueTask[T]</c> envelope.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that drops the runtime-usage
/// probe (treating every <c>async ValueTask</c> method as suspending) breaks
/// <see cref="AsyncValueTask_WithoutTheRuntime_KeepsTheExplicitEnvelope"/>;
/// a mutant that never sets <c>IsSuspend</c> breaks
/// <see cref="AsyncValueTask_UsingChan_RendersSuspendFunc"/>.
/// </remarks>
public class Adr0174SuspendFuncTranslationTests
{
    [Fact]
    public void Printer_RendersSuspendModifier_WithTheLogicalReturnType()
    {
        var method = new MethodDeclaration(
            "Take",
            parameters: new List<Parameter> { new Parameter("ch", new NamedTypeReference("Chan", new[] { new NamedTypeReference("int32") })) },
            returnType: new NamedTypeReference("int32"),
            body: new BlockStatement(new List<GStatement> { new ReturnStatement(new IdentifierExpression("v")) }),
            isSuspend: true);
        var unit = new CompilationUnit("Demo", new List<ImportDirective>(), new List<GNode> { method });

        string rendered = GSharpPrinter.Print(unit);

        Assert.Contains("suspend func Take(ch Chan[int32]) int32 {", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("async", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void AsyncValueTask_UsingChan_RendersSuspendFunc()
    {
        string rendered = Render(@"
using System.Threading.Tasks;
using Gsharp.Concurrency;

public static class Pipeline
{
    public static async ValueTask<int> Twice(Chan<int> ch)
    {
        int v = await ChannelOps.ReceiveValueAsync(ch, Context.None);
        return v * 2;
    }

    public static async ValueTask Drain(Chan<int> ch)
    {
        await ChannelOps.ReceiveValueAsync(ch, Context.None);
    }
}
");

        Assert.Contains("suspend func Twice(ch Chan[int32]) int32 {", rendered, StringComparison.Ordinal);
        Assert.Contains("suspend func Drain(ch Chan[int32]) {", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("ValueTask[", rendered, StringComparison.Ordinal);
        AssertRoundTripBinds(rendered);
    }

    [Fact]
    public void AsyncValueTask_MarkedSuspending_RendersSuspendFunc()
    {
        string rendered = Render(@"
using System.Threading.Tasks;
using Gsharp.Concurrency;

public static class Marked
{
    [Suspending]
    public static async ValueTask<int> Ready()
    {
        await Task.CompletedTask;
        return 7;
    }
}
");

        Assert.Contains("suspend func Ready() int32 {", rendered, StringComparison.Ordinal);
        AssertRoundTripBinds(rendered);
    }

    [Fact]
    public void AsyncValueTask_WithoutTheRuntime_KeepsTheExplicitEnvelope()
    {
        string rendered = Render(@"
using System.Threading.Tasks;

public static class Plain
{
    public static async ValueTask<int> Triple(int value)
    {
        await Task.CompletedTask;
        return value * 3;
    }
}
");

        Assert.Contains("async func Triple(value int32) ValueTask[int32] {", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("suspend", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void AsyncValueTask_DeclaredInsideTheRuntime_KeepsTheExplicitEnvelope()
    {
        // Issue #3907: inside Gsharp.Concurrency itself the runtime-usage probe
        // is trivially true for every method, so it labelled the runtime's own
        // private helpers `suspend`. Those return their ValueTask to a
        // fast-path caller un-awaited, which a suspend func cannot express
        // (ADR-0174 D4 makes every call an implicit await).
        string rendered = Render(@"
using System.Threading.Tasks;

namespace Gsharp.Concurrency;

public static class Inside
{
    public static ValueTask<int> Fast(Chan<int> ch) => Slow(ch);

    private static async ValueTask<int> Slow(Chan<int> ch)
    {
        await Task.CompletedTask;
        return 1;
    }
}
");

        Assert.Contains("async func Slow(ch Chan[int32]) ValueTask[int32] {", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("suspend", rendered, StringComparison.Ordinal);
        AssertRoundTripBinds(rendered);
    }

    [Fact]
    public void AsyncValueTask_InsideTheRuntime_MarkedSuspending_StillRendersSuspendFunc()
    {
        // The attribute stays authoritative inside the runtime: #3882 marks
        // exactly the ChannelBatchExtensions methods that really are the
        // suspend ABI, and the #3907 narrowing must not reach them.
        string rendered = Render(@"
using System.Threading.Tasks;

namespace Gsharp.Concurrency;

public static class InsideMarked
{
    [Suspending]
    public static async ValueTask<int> Ready()
    {
        await Task.CompletedTask;
        return 7;
    }
}
");

        Assert.Contains("suspend func Ready() int32 {", rendered, StringComparison.Ordinal);
    }

    private static void AssertRoundTripBinds(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" + string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Concurrency.Chan<>).Assembly.Location),
        };
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Program.cs", source) },
            references);

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity != TranslationSeverity.Info);
        return GSharpPrinter.Print(unit);
    }
}
