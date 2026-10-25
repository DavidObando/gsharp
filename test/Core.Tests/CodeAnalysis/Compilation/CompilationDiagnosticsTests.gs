// <copyright file="CompilationDiagnosticsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Compilation

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Threading
import System.Threading.Tasks
import Xunit

/// ADR-0212 S6: the diagnostics queries and the compilation-lifetime token. The contract, one test per row:
///
/// | Query | Includes | Order | Filter | Builds | Cancellation | Retired predecessor |
/// | --- | --- | --- | --- | --- | --- | --- |
/// | `GetDeclarationDiagnostics` | every tree's parse diagnostics, then the global scope's | tree order, then bind order | `ApplySourceSuppressions` | declarations only | request token cancels the wait; lifetime token kills the compilation | published answer, else `OperationCanceledException` |
/// | `GetBodyDiagnostics` | the bound program's | bind order | `ApplySourceSuppressions` | declarations and bodies | as above | as above |
/// | `GetDiagnostics` | declaration, body, then (no error in either) documentation | as listed | `ApplySourceSuppressions` on each part | both binds | as above | as above |
/// | `SemanticModel.GetDiagnostics` | `GetDiagnostics` entries located in the model's tree | as `GetDiagnostics` | tree text | as `GetDiagnostics` | as above | as above |
///
/// A successor inherits no published state; the host gives it a new `WorkBudget` before the first query.
open class CompilationDiagnosticsTests {
    @Fact
    func GetDiagnostics_FollowsTheOrderOfEmit_ParseThenBodyThenDocumentation() {
        let compilation = Compilation(Parse("Warnings.gs", WarningsText)){IsLibrary = true}
        let ids = compilation.GetDiagnostics().Select((d Diagnostic) -> d.Id).ToArray()
        Assert.Equal([]string{"GS0303", "GS0612", "GS0229"}, ids)
        using let stream = MemoryStream()
        let emitted = Compilation(Parse("Warnings.gs", WarningsText)){IsLibrary = true}.Emit(stream)
        Assert.Equal(ids, emitted.Diagnostics.Select((d Diagnostic) -> d.Id).ToArray())
    }

    @Fact
    func GetDeclarationDiagnostics_IsParseThenGlobalScope_AndDoesNotBindBodies() {
        let tree = Parse("Declarations.gs", DeclarationErrorText)
        let compilation = Compilation(tree)
        let probed = Counter()
        compilation.BodyBindProbe = () -> {
            Interlocked.Increment(&probed.Value)
        }
        let declaration = compilation.GetDeclarationDiagnostics()
        Assert.NotEmpty(declaration)
        Assert.Equal(
            tree.Diagnostics.Concat(compilation.GlobalScope.Diagnostics).Select((d Diagnostic) -> d).ToArray(),
            declaration.ToArray()
        )
        Assert.Contains(declaration, (d Diagnostic) -> d.Id == "GS0303")
        Assert.Contains(declaration, (d Diagnostic) -> d.IsError)
        Assert.Equal(0, probed.Value)
    }

    @Fact
    func GetBodyDiagnostics_IsTheBoundProgramsDiagnostics() {
        let compilation = Compilation(Parse("Body.gs", BodyErrorText))
        Assert.Equal(compilation.BoundProgram.Diagnostics.ToArray(), compilation.GetBodyDiagnostics().ToArray())
        Assert.Contains(compilation.GetBodyDiagnostics(), (d Diagnostic) -> d.IsError)
    }

    @Fact
    func GetDiagnostics_AppliesSourceSuppressionsToEveryPart() {
        const source = "@SuppressDiagnostic(\"GS0303\")\n" +
            "func QuietParse(cb func(int32) int32) int32 -> cb(1)\n" +
            "func LoudParse(cb func(int32) int32) int32 -> cb(1)\n" +
            "func R(ref s string) { s = \"r\" }\n" +
            "func F() {\n" +
            "    var a string? = nil\n" +
            "    @SuppressDiagnostic(\"GS0612\") {\n" +
            "        R(&a)\n" +
            "    }\n" +
            "    R(&a)\n" +
            "}\n"
        let compilation = Compilation(Parse("Suppressed.gs", source)){IsLibrary = true}
        let diagnostics = compilation.GetDiagnostics()
        Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0303")
        Assert.Equal(2, Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0303").Location.StartLine)
        let bodyWarning = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0612")
        Assert.Equal(9, bodyWarning.Location.StartLine)
    }

    @Fact
    func GetDiagnostics_AppliesSourceSuppressionsToTheDocumentationPass() {
        const source = "package Lib\n" + "@SuppressDiagnostic(\"GS0228\")\n" + "func Quiet() {}\n" + "func Loud() {}\n"
        let compilation = Compilation(Parse("Docs.gs", source)){IsLibrary = true, WarnOnMissingDocumentation = true}
        let missing = Assert.Single(compilation.GetDiagnostics(), (d Diagnostic) -> d.Id == "GS0228")
        Assert.Contains("'Loud'", missing.Message)
    }

    @Fact
    func GetDiagnostics_OmitsDocumentationWarningsWhileAnyTreeHasAnError_AndReturnsThemWhenTheErrorIsFixed() {
        let documented = Parse("Documented.gs", DocumentedText)
        let broken = Parse("Broken.gs", BrokenText)
        let withError = Compilation(documented, broken){IsLibrary = true}
        Assert.DoesNotContain(withError.GetDiagnostics(), (d Diagnostic) -> d.Id == "GS0229")
        Assert.Contains(withError.GetDiagnostics(), (d Diagnostic) -> d.IsError)
        // The declaration and body parts are unaffected by the rule.
        Assert.Equal(
            withError.GetDeclarationDiagnostics().Concat(withError.GetBodyDiagnostics()).ToArray(),
            withError.GetDiagnostics().ToArray()
        )
        let fixedBroken = Parse("Broken.gs", BrokenText.Replace("\"x\"", "1"))
        let fixed_ = Compilation(documented, fixedBroken){IsLibrary = true}
        Assert.Single(fixed_.GetDiagnostics(), (d Diagnostic) -> d.Id == "GS0229")
    }

    @Fact
    func SemanticModelGetDiagnostics_ReturnsTheEntriesLocatedInItsTree_InQueryOrder() {
        let documented = Parse("Documented.gs", DocumentedText)
        let warned = Parse("Warned.gs", "package Lib\nfunc Loud(cb func(int32) int32) int32 -> cb(1)\n")
        let compilation = Compilation(documented, warned){IsLibrary = true}
        let all = compilation.GetDiagnostics()
        let documentedModel = compilation.GetSemanticModel(documented).GetDiagnostics()
        let warnedModel = compilation.GetSemanticModel(warned).GetDiagnostics()
        Assert.Equal(
            all.Where((d Diagnostic) -> d.Location.Text == documented.Text).ToArray(),
            documentedModel.ToArray()
        )
        Assert.Equal(all.Where((d Diagnostic) -> d.Location.Text == warned.Text).ToArray(), warnedModel.ToArray())
        Assert.Equal([]string{"GS0229"}, documentedModel.Select((d Diagnostic) -> d.Id).ToArray())
        // A parse diagnostic appears once: in the tree that holds it, and in the whole list once.
        Assert.Equal([]string{"GS0303"}, warnedModel.Select((d Diagnostic) -> d.Id).ToArray())
        Assert.Single(all, (d Diagnostic) -> d.Id == "GS0303")
    }

    @Fact
    func DiagnosticQueries_PublishOnce() {
        let compilation = Compilation(Parse("Warnings.gs", WarningsText)){IsLibrary = true}
        Assert.True(compilation.GetDiagnostics().Equals(compilation.GetDiagnostics()))
        Assert.True(compilation.GetDeclarationDiagnostics().Equals(compilation.GetDeclarationDiagnostics()))
        Assert.True(compilation.GetBodyDiagnostics().Equals(compilation.GetBodyDiagnostics()))
    }

    @Fact
    func LifetimeToken_CancelledDuringABind_EveryWaiterSeesCancellation_AndASuccessorCompletes() {
        let a = Parse("A.gs", AText)
        let b = Parse("B.gs", BText)
        using let lifetime = CancellationTokenSource()
        let compilation = Compilation(a, b){
            IsLibrary = true,
            WorkBudget = CompilationWorkBudget(cancellationToken: lifetime.Token)
        }
        let _ = compilation.GlobalScope
        using let entered = ManualResetEventSlim(false)
        using let release = ManualResetEventSlim(false)
        compilation.BodyBindProbe = () -> {
            entered.Set()
            release.Wait()
        }
        let builder = Task.Run(() -> compilation.GetDiagnostics())
        Assert.True(entered.Wait(TimeSpan.FromSeconds(30)))
        let waiters = []Task{
            Task.Run(() -> compilation.GetDiagnostics()),
            Task.Run(() -> compilation.GetBodyDiagnostics()),
            Task.Run(() -> compilation.GetSemanticModel(a).GetDiagnostics())
        }
        Assert.False(Task.WaitAll(waiters, TimeSpan.FromMilliseconds(300)))
        lifetime.Cancel()
        release.Set()
        for waiter in waiters.Append(builder) {
            let thrown = Assert.Throws[AggregateException](
                () -> {
                    waiter.Wait(TimeSpan.FromSeconds(30))
                }
            )
            Assert.IsAssignableFrom[OperationCanceledException](thrown.InnerException)
        }
        // The compilation is dead: nothing was published, and every later query throws.
        Assert.ThrowsAny[OperationCanceledException](() -> compilation.GetDiagnostics())
        Assert.ThrowsAny[OperationCanceledException](() -> compilation.BoundProgram)
        Assert.ThrowsAny[OperationCanceledException](() -> compilation.GetSemanticModel(a).GetBoundNode(a.Root))
        // Recovery is a successor with a fresh budget.
        let successor = compilation.ReplaceSyntaxTree(a, Parse("A.gs", AText.Replace("return 1", "return 100")))
        successor.WorkBudget = CompilationWorkBudget()
        Assert.Empty(successor.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        Assert.NotNull(successor.BoundProgram)
    }

    @Fact
    func RequestToken_CancelledOnTheStartingRequest_DoesNotAbortTheBuildForAnotherReader() {
        let a = Parse("A.gs", AText)
        let compilation = Compilation(a){IsLibrary = true}
        let _ = compilation.GlobalScope
        let binds = Counter()
        using let entered = ManualResetEventSlim(false)
        using let release = ManualResetEventSlim(false)
        compilation.BodyBindProbe = () -> {
            Interlocked.Increment(&binds.Value)
            entered.Set()
            release.Wait()
        }
        using let requestA = CancellationTokenSource()
        using let requestB = CancellationTokenSource()
        let first = Task.Run(() -> compilation.GetDiagnostics(requestA.Token))
        Assert.True(entered.Wait(TimeSpan.FromSeconds(30)))
        let second = Task.Run(() -> compilation.GetDiagnostics(requestB.Token))
        Assert.False(second.Wait(TimeSpan.FromMilliseconds(300)))
        requestA.Cancel()
        release.Set()
        // Request B's wait ends with the built result. Request A may report its own cancellation.
        Assert.True(second.Wait(TimeSpan.FromSeconds(30)))
        Assert.Equal(0, Task.WaitAny([]Task{first}, TimeSpan.FromSeconds(30)))
        // The build ran once: cancelling A's token did not abort it and force a second bind.
        Assert.Equal(1, binds.Value)
        Assert.True(second.Result.Equals(compilation.GetDiagnostics()))
        Assert.NotNull(compilation.BoundProgram)
    }

    @Fact
    func RequestToken_CancelsTheWaitOfAReaderBehindABuild_NotTheBuild() {
        let a = Parse("A.gs", AText)
        let compilation = Compilation(a){IsLibrary = true}
        let _ = compilation.GlobalScope
        using let entered = ManualResetEventSlim(false)
        using let release = ManualResetEventSlim(false)
        compilation.BodyBindProbe = () -> {
            entered.Set()
            release.Wait()
        }
        let builder = Task.Run(() -> compilation.GetDiagnostics())
        Assert.True(entered.Wait(TimeSpan.FromSeconds(30)))
        using let request = CancellationTokenSource()
        let waiter = Task.Run(() -> compilation.GetDiagnostics(request.Token))
        Assert.False(waiter.Wait(TimeSpan.FromMilliseconds(200)))
        request.Cancel()
        let thrown = Assert.Throws[AggregateException](
            () -> {
                waiter.Wait(TimeSpan.FromSeconds(30))
            }
        )
        Assert.IsAssignableFrom[OperationCanceledException](thrown.InnerException)
        release.Set()
        Assert.True(builder.Wait(TimeSpan.FromSeconds(30)))
        Assert.True(builder.Result.Equals(compilation.GetDiagnostics()))
    }

    @Fact
    func SemanticModel_IndexWaitIsCancelledByTheRequestToken_AndTheIndexIsNotCachedAsFailed() {
        let a = Parse("A.gs", AText)
        let compilation = Compilation(a){IsLibrary = true}
        let _ = compilation.GlobalScope
        using let entered = ManualResetEventSlim(false)
        using let release = ManualResetEventSlim(false)
        compilation.BodyBindProbe = () -> {
            entered.Set()
            release.Wait()
        }
        let builder = Task.Run(() -> compilation.BoundProgram)
        Assert.True(entered.Wait(TimeSpan.FromSeconds(30)))
        let model = compilation.GetSemanticModel(a)
        let declaration = a.Root.Members.OfType[FunctionDeclarationSyntax]().First()
        using let request = CancellationTokenSource()
        let waiter = Task.Run(() -> model.GetDeclaredSymbol(declaration, request.Token))
        Assert.False(waiter.Wait(TimeSpan.FromMilliseconds(200)))
        request.Cancel()
        let thrown = Assert.Throws[AggregateException](
            () -> {
                waiter.Wait(TimeSpan.FromSeconds(30))
            }
        )
        Assert.IsAssignableFrom[OperationCanceledException](thrown.InnerException)
        release.Set()
        Assert.True(builder.Wait(TimeSpan.FromSeconds(30)))
        Assert.NotNull(model.GetDeclaredSymbol(declaration))
    }

    @Fact
    func RetiredCompilation_AnswersFromPublishedState_AndThrowsForUnbuiltState() {
        let a = Parse("A.gs", AText)
        let b = Parse("B.gs", BText)
        let previous = Compilation(a, b){IsLibrary = true}
        let declarations = previous.GetDeclarationDiagnostics()
        let successor = previous.ReplaceSyntaxTree(a, Parse("A.gs", AText.Replace("return 1", "return 100")))
        // The re-point retired the predecessor: published answers stay, nothing new is built on it.
        Assert.Same(previous.GlobalScope, successor.GlobalScope)
        Assert.True(declarations.Equals(previous.GetDeclarationDiagnostics()))
        Assert.ThrowsAny[OperationCanceledException](() -> previous.BoundProgram)
        Assert.ThrowsAny[OperationCanceledException](() -> previous.GetBodyDiagnostics())
        Assert.ThrowsAny[OperationCanceledException](() -> previous.GetDiagnostics())
        Assert.ThrowsAny[OperationCanceledException](() -> previous.GetSemanticModel(b).GetBoundNode(b.Root))
        // The successor is not retired.
        Assert.NotNull(successor.BoundProgram)
        Assert.Empty(successor.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func RetiredCompilation_WithABuiltProgram_RefusesToBuildAnIndex() {
        let a = Parse("A.gs", AText)
        let b = Parse("B.gs", BText)
        let previous = Compilation(a, b){IsLibrary = true}
        let _ = previous.BoundProgram
        let _ = previous.ReplaceSyntaxTree(a, Parse("A.gs", AText.Replace("return 1", "return 100")))
        // The index walk reads symbols that the re-point changed; it must not start.
        Assert.ThrowsAny[OperationCanceledException](() -> previous.GetSemanticModel(b).GetBoundNode(b.Root))
    }

    private class Counter {
        var Value int32
    }

    private func Parse(name string, text string) SyntaxTree -> SyntaxTree.Parse(SourceText.From(text, name))

    shared {
        private const AText string = `package P
func A() int32 {
    return 1
}
`
        private const BText string = `package P
func B() int32 {
    return 2
}
`
        // A parse warning (GS0303), a body warning (GS0612) and a documentation warning (GS0229).
        private const WarningsText string = `package Lib

func R(ref s string) { s = "r" }

/// Adds one number.
/// @param b wrong parameter
func Add(a int32) int32 {
    var n string? = nil
    R(&n)
    return a
}

func Loud(cb func(int32) int32) int32 -> cb(1)
`
        private const DocumentedText string = `package Lib

/// Adds one number.
/// @param b wrong parameter
func Add(a int32) int32 {
    return a
}
`
        private const BrokenText string = `package Lib

func Broken() int32 {
    return "x"
}
`
        private const DeclarationErrorText string = `package Lib

func Loud(cb func(int32) int32) int32 -> cb(1)
func B() Undefined {
    return nil
}
`
        private const BodyErrorText string = `package Lib

func Broken() int32 {
    return "x"
}
`
    }
}
