// <copyright file="Adr0174SuspendFuncBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0174 D4, the declared path: a `suspend func` is a suspending
/// function — its logical return type is `R`, a call from a suspending or
/// `async` body is an implicit await typed `R`, a call from a plain
/// function blocks through the runtime's root bridge and warns (GS0558), and
/// the synthesized entry point is the root where that block is silent. The
/// body may use `await`; `async` and `suspend` never coexist.
/// @remarks Discrimination witness (ADR-0154): a mutant that types the call as
/// `ValueTask[R]` without the implicit await breaks
/// (cref:Call_FromSuspendingCaller_IsAnImplicitAwaitTypedR) (the
/// bound tree has no await, the sum is not `int32`); a mutant that drops
/// the root exemption breaks (cref:Call_FromEntryPoint_DoesNotWarn).
open class Adr0174SuspendFuncBindingTests {
    @Fact
    func Declaration_IsSuspending_NotAsync_WithLogicalReturnType() {
        let program = Bind(`package P
suspend func take(ch in chan[int32]) int32 {
    return <-ch
}`)
        let take = program.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "take")
        Assert.Equal(SuspendingKind.Declared, take.SuspendingKind)
        Assert.True(take.IsSuspending)
        Assert.False(take.IsAsync)
        Assert.True(take.AsyncReturnsValueTask)
        Assert.Equal(TypeSymbol.Int32, take.Type)
    }

    @Fact
    func Call_FromSuspendingCaller_IsAnImplicitAwaitTypedR() {
        let program = Bind(`package P
suspend func take(ch in chan[int32]) int32 {
    return <-ch
}
suspend func twice(ch in chan[int32]) int32 {
    return take(ch) + take(ch)
}`)
        let twice = program.Functions.Single(
            (p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "twice"
        )
        let awaits = Collect[BoundAwaitExpression](twice.Value)
        Assert.Equal(2, awaits.Count)
        Assert.All(awaits, (a BoundAwaitExpression) -> Assert.Equal(TypeSymbol.Int32, a.Type))
        Assert.All(awaits, (a BoundAwaitExpression) -> Assert.Contains("ValueTask", a.Expression.Type.Name))
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func Call_FromAsyncCaller_IsAnImplicitAwait() {
        let program = Bind(`package P
suspend func take(ch in chan[int32]) int32 {
    return <-ch
}
async func run(ch chan[int32]) int32 {
    return take(ch)
}`)
        let run = program.Functions.Single((p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "run")
        Assert.Single(Collect[BoundAwaitExpression](run.Value))
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func Call_FromABoundaryFunction_BlocksAndWarnsGS0558() {
        // A plain caller would be inferred suspending (D4); an `open` method is
        // a boundary, so its call keeps the blocking root bridge and warns.
        let program = Bind(`package P
suspend func take(ch in chan[int32]) int32 {
    return <-ch
}
open class Reader {
    open func Read(ch chan[int32]) int32 {
        return take(ch)
    }
}`)
        let diagnostic = Assert.Single(program.Diagnostics)
        Assert.Equal("GS0558", diagnostic.Id)
        Assert.Equal(DiagnosticSeverity.Warning, diagnostic.Severity)
        Assert.Contains("'take'", diagnostic.Message)
        let read = program.Functions.Single(
            (p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "Read"
        )
        Assert.Empty(Collect[BoundAwaitExpression](read.Value))
        let bridge = Assert.Single(
            Collect[BoundImportedCallExpression](read.Value),
            (c BoundImportedCallExpression) -> c.Function.Name == "Wait"
        )
        Assert.Equal("Gsharp.Concurrency.Blocking", bridge.Function.ImportedClass.ClassType.FullName)
        Assert.Equal(TypeSymbol.Int32, bridge.Type)
    }

    @Fact
    func ExplicitBlockingWait_IsTheIntentionalBlockingSpelling() {
        let program = Bind(`package P
import System.Threading.Tasks
import Gsharp.Concurrency
open class Reader {
    open func Read() int32 {
        return Blocking.Wait(ValueTask[int32](7))
    }
}`)
        Assert.DoesNotContain(program.Diagnostics, (d Diagnostic) -> d.Id == "GS0558")
        let read = program.Functions.Single(
            (p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "Read"
        )
        Assert.Single(
            Collect[BoundImportedCallExpression](read.Value),
            (c BoundImportedCallExpression) -> c.Function.Name == "Wait"
        )
    }

    @Fact
    func Call_FromPlainFunction_IsInferred_AndAwaited() {
        let program = Bind(`package P
suspend func take(ch in chan[int32]) int32 {
    return <-ch
}
func plain(ch chan[int32]) int32 {
    return take(ch)
}`)
        Assert.Empty(program.Diagnostics)
        let plain = program.Functions.Single(
            (p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "plain"
        )
        Assert.Equal(SuspendingKind.Inferred, plain.Key.SuspendingKind)
        Assert.Single(Collect[BoundAwaitExpression](plain.Value))
    }

    @Fact
    func Call_FromEntryPoint_DoesNotWarn() {
        let (diagnostics, _) = CompileDiagnostics(`package P
suspend func take(ch in chan[int32]) int32 {
    return <-ch
}
let ch = chan[int32](1)
ch <- 3
let v = take(ch)`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Await_IsAllowedInsideASuspendFunc() {
        let (diagnostics, _) = CompileDiagnostics(`package P
import System.Threading.Tasks
suspend func pause() int32 {
    await Task.Delay(1)
    return 1
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func ExplicitAwait_OnASuspendingCall_IsRedundantAndLegal() {
        // The call is already completed as an implicit await; a spelled-out
        // `await` (what a C# or Go programmer, and cs2gs, writes) must not
        // report GS0133 against the logical type `int32`.
        let program = Bind(`package P
suspend func twice(ch in chan[int32]) int32 {
    return <-ch * 2
}
suspend func run(ch chan[int32]) int32 {
    let a = await twice(ch)
    return a
}`)
        let run = program.Functions.Single((p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "run")
        let await_ = Assert.Single(Collect[BoundAwaitExpression](run.Value))
        Assert.Equal(TypeSymbol.Int32, await_.Type)
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func ExplicitAwait_OnAGenuineNestedTask_StillAwaitsTwice() {
        let program = Bind(`package P
import System.Threading.Tasks
suspend func inner() Task[int32] {
    return Task.FromResult(3)
}
suspend func run() int32 {
    return await inner()
}`)
        let run = program.Functions.Single((p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "run")
        Assert.Equal(2, Collect[BoundAwaitExpression](run.Value).Count)
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func VoidSuspendFunc_CallIsAnAwaitedStatement() {
        let program = Bind(`package P
suspend func fill(ch out chan[int32]) {
    ch <- 1
}
suspend func run(ch chan[int32]) {
    fill(ch)
}`)
        let run = program.Functions.Single((p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "run")
        let await_ = Assert.Single(Collect[BoundAwaitExpression](run.Value))
        Assert.Equal(TypeSymbol.Void, await_.Type)
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func SuspendMethod_OnAClass_IsAnImplicitAwaitAtTheCallSite() {
        let program = Bind(`package P
class Pump {
    var ch chan[int32] = chan[int32](4)
    suspend func Take() int32 {
        return <-ch
    }
    suspend func TakeTwo() int32 {
        return Take() + Take()
    }
}`)
        Assert.Empty(program.Diagnostics)
        let takeTwo = program.Functions.Single(
            (p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "TakeTwo"
        )
        Assert.Equal(2, Collect[BoundAwaitExpression](takeTwo.Value).Count)
    }

    @Fact
    func SymbolDisplay_ShowsSuspend() {
        let program = Bind(`package P
suspend func take(ch in chan[int32]) int32 {
    return <-ch
}`)
        let take = program.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "take")
        let display = SymbolDisplay.ToDisplayString(take, SymbolDisplayFormat.Hover)
        Assert.Contains("suspend", display)
        Assert.DoesNotContain("ValueTask", display)
    }

    private class Collector[T BoundNode] : BoundTreeWalker {
        init() {
            Found = List[T]()
        }

        prop Found List[T] {
            get;
        }

        protected override func VisitAwaitExpression(node BoundAwaitExpression) {
            if node is T match {
                Found.Add(match)
            }
            base.VisitAwaitExpression(node)
        }

        protected override func VisitImportedCallExpression(node BoundImportedCallExpression) {
            if node is T match {
                Found.Add(match)
            }
            base.VisitImportedCallExpression(node)
        }
    }

    shared {
        private func Bind(source string) BoundProgram {
            let compilation = Compilation(SyntaxTree.Parse(source))
            Assert.Empty(compilation.GlobalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
            return Binder.BindProgram(compilation.GlobalScope, compilation.References ?? ReferenceResolver.Default())
        }

        private func CompileDiagnostics(source string)(
            Diagnostics ImmutableArray[Diagnostic],
            Compilation Compilation
        ) {
            let compilation = Compilation(SyntaxTree.Parse(source))
            return (EmittedOracle.CompileDiagnostics(compilation), compilation)
        }

        private func Collect[T BoundNode](body BoundStatement) List[T] {
            let collector = Adr0174SuspendFuncBindingTests.Collector[T]()
            collector.Visit(body)
            return collector.Found
        }
    }
}
