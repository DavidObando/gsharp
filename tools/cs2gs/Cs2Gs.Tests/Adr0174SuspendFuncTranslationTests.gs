// <copyright file="Adr0174SuspendFuncTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import Xunit

/// ADR-0174 D4 (P3-7): a C# `async ValueTask`/`ValueTask<T>`
/// method that uses the Gsharp.Concurrency runtime — or carries
/// `[Suspending]`, the attribute G# stamps on every suspending function —
/// translates to a G# `suspend func` with the awaited result type. An
/// `async ValueTask<T>` method that never touches the runtime keeps
/// ADR-0115 B.23's explicit `ValueTask[T]` envelope.
/// @remarks Discrimination witness (ADR-0154): a mutant that drops the runtime-usage
/// probe (treating every `async ValueTask` method as suspending) breaks
/// (cref:AsyncValueTask_WithoutTheRuntime_KeepsTheExplicitEnvelope);
/// a mutant that never sets `IsSuspend` breaks
/// (cref:AsyncValueTask_UsingChan_RendersSuspendFunc).
open class Adr0174SuspendFuncTranslationTests {
    @Fact
    func Printer_RendersSuspendModifier_WithTheLogicalReturnType() {
        let method = MethodDeclaration(
            "Take",
            parameters: List[Parameter]{
                Parameter("ch", NamedTypeReference("Chan", []NamedTypeReference{NamedTypeReference("int32")}))
            },
            returnType: NamedTypeReference("int32"),
            body: BlockStatement(List[GStatement]{ReturnStatement(IdentifierExpression("v"))}),
            isSuspend: true
        )
        let unit = CompilationUnit("Demo", List[ImportDirective](), List[GNode]{method})
        let rendered = GSharpPrinter.Print(unit)
        Assert.Contains("suspend func Take(ch Chan[int32]) int32 {", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("async", rendered, StringComparison.Ordinal)
    }

    @Fact
    func AsyncValueTask_UsingChan_RendersSuspendFunc() {
        let rendered = Render(`
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
`)
        Assert.Contains("suspend func Twice(ch Chan[int32]) int32 {", rendered, StringComparison.Ordinal)
        Assert.Contains("suspend func Drain(ch Chan[int32]) {", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("ValueTask[", rendered, StringComparison.Ordinal)
        AssertRoundTripBinds(rendered)
    }

    @Fact
    func AsyncValueTask_MarkedSuspending_RendersSuspendFunc() {
        let rendered = Render(`
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
`)
        Assert.Contains("suspend func Ready() int32 {", rendered, StringComparison.Ordinal)
        AssertRoundTripBinds(rendered)
    }

    @Fact
    func AsyncValueTask_WithoutTheRuntime_KeepsTheExplicitEnvelope() {
        let rendered = Render(`
using System.Threading.Tasks;

public static class Plain
{
    public static async ValueTask<int> Triple(int value)
    {
        await Task.CompletedTask;
        return value * 3;
    }
}
`)
        Assert.Contains("async func Triple(value int32) ValueTask[int32] {", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("suspend", rendered, StringComparison.Ordinal)
    }

    @Fact
    func AsyncValueTask_DeclaredInsideTheRuntime_KeepsTheExplicitEnvelope() {
        // Issue #3907: inside Gsharp.Concurrency itself the runtime-usage probe
        // is trivially true for every method, so it labelled the runtime's own
        // private helpers `suspend`. Those return their ValueTask to a
        // fast-path caller un-awaited, which a suspend func cannot express
        // (ADR-0174 D4 makes every call an implicit await).
        let rendered = Render(`
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
`)
        Assert.Contains("async func Slow(ch Chan[int32]) ValueTask[int32] {", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("suspend", rendered, StringComparison.Ordinal)
        AssertRoundTripBinds(rendered)
    }

    @Fact
    func AsyncValueTask_InsideTheRuntime_MarkedSuspending_StillRendersSuspendFunc() {
        // The attribute stays authoritative inside the runtime: #3882 marks
        // exactly the ChannelBatchExtensions methods that really are the
        // suspend ABI, and the #3907 narrowing must not reach them.
        let rendered = Render(`
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
`)
        Assert.Contains("suspend func Ready() int32 {", rendered, StringComparison.Ordinal)
    }

    shared {
        private func AssertRoundTripBinds(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let references = List[MetadataReference](
                CSharpProjectLoader.RuntimeReferences()
            ){MetadataReference.CreateFromFile(typeof(Gsharp.Concurrency.Chan[_]).Assembly.Location)}
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Program.cs", source)},
                references
            )
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity != TranslationSeverity.Info
            )
            return GSharpPrinter.Print(unit)
        }
    }
}
