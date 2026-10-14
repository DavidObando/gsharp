// <copyright file="Adr0174ScopeLoweringTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0174 D5/D6: `scope { … }` is lowered by the binder onto the runtime's
/// `ScopeFrame` — `Enter`, an implicit `ctx` of type `Context`,
/// the body in a try whose catch records the body's exception and whose finally
/// calls `Exit` — and every `go` inside it carries the frame as its
/// completion sink. A function containing a scope suspends (the join is a
/// suspension point), so inside its state machine the exit is an awaited
/// `ExitAsync`; at the root it blocks.
/// @remarks Discrimination witness (ADR-0154): a mutant that hands every `go` a
/// `null` sink (never registering with the enclosing frame; run while
/// landing P3-5) breaks
/// (cref:Go_InsideScope_ReportsToTheFrame_AndOutsideToNoSink), and the
/// emitted failure tests then die with the runtime's free-goroutine fail-fast.
open class Adr0174ScopeLoweringTests {
    @Fact
    func Scope_LowersToScopeFrameEnterTryFinallyExit_WithCtx() {
        let program = Bind(`package P
func work(ch out chan[int32]) {
    ch <- 1
}
func run() int32 {
    let ch = chan[int32](1)
    scope {
        go work(ch)
    }
    return <-ch
}`)
        let run = Body(program, "run")
        let calls = Collect[BoundImportedCallExpression](run)
        Assert.Contains(
            calls,
            (c BoundImportedCallExpression) -> c
                .Function
                .Name == "Enter" &&
                c
                .Function
                .ImportedClass
                .ClassType
                .FullName == "Gsharp.Concurrency.ScopeFrame"
        )
        let tries = Collect[BoundTryStatement](run)
        let scopeTry = Assert.Single(tries)
        Assert.Single(scopeTry.CatchClauses)
        Assert.NotNull(scopeTry.FinallyBlock)
        let exits = Collect[BoundImportedInstanceCallExpression](run).Where(ChannelRuntimeBinder.IsScopeExit).ToList()
        Assert.Single(exits)
        let ctx = Collect[BoundVariableDeclaration](run).Single(
            (d BoundVariableDeclaration) -> d.Variable.Name == "ctx"
        )
        Assert.Equal("Gsharp.Concurrency.Context", ctx.Variable.Type.ClrType?.FullName)
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func NestedScope_EntersUnderTheEnclosingCtx_OutermostUnderTheCallersContext() {
        let program = Bind(`package P
func run() {
    scope {
        scope {
        }
    }
}`)
        let run = program.Functions.Single((p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "run")
        let enters = Collect[BoundImportedCallExpression](run.Value).Where(
            (c BoundImportedCallExpression) -> c.Function.Name == "Enter"
        )
            .ToList()
        Assert.Equal(2, enters.Count)
        // A function containing a scope suspends, so its outermost block enters
        // under the hidden context its caller supplies (ADR-0174 D7) — that is
        // what makes cancelling the caller collapse this block.
        let hidden = Assert.IsType[ParameterSymbol](run.Key.HiddenContextParameter)
        Assert.Same(hidden, Assert.IsType[BoundVariableExpression](Assert.Single(enters[0].Arguments)).Variable)
        let inner = Assert.IsType[BoundClrPropertyAccessExpression](Assert.Single(enters[1].Arguments))
        Assert.Equal("Context", inner.Member.Name)
        let outerFrame = Assert.IsType[BoundVariableExpression](inner.Receiver).Variable
        Assert.StartsWith("<scope$$frame$$", outerFrame.Name)
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func Go_InsideScope_ReportsToTheFrame_AndOutsideToNoSink() {
        let program = Bind(`package P
func work(ch out chan[int32]) {
    ch <- 1
}
func run() int32 {
    let ch = chan[int32](2)
    go work(ch)
    scope {
        go work(ch)
    }
    return <-ch + <-ch
}`)
        let gos = Collect[BoundGoStatement](Body(program, "run"))
        Assert.Equal(2, gos.Count)
        Assert.Null(gos[0].Sink)
        let sink = Assert.IsType[BoundVariableExpression](gos[1].Sink)
        Assert.Equal("Gsharp.Concurrency.ScopeFrame", sink.Variable.Type.ClrType?.FullName)
    }

    @Fact
    func Scope_IsASuspensionPoint_AndTheEntryPointStaysARoot() {
        let program = Bind(`package P
func work(ch out chan[int32]) {
    ch <- 1
}
func join(ch chan[int32]) {
    scope {
        go work(ch)
    }
}
let ch = chan[int32](1)
scope {
    go work(ch)
}
let v = <-ch`)
        Assert.Equal(
            SuspendingKind.Inferred,
            program.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "join").SuspendingKind
        )
        let entry = program.Functions.Keys.Single((f FunctionSymbol) -> f.IsTopLevelEntryPoint)
        Assert.Equal(SuspendingKind.None, entry.SuspendingKind)
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func GoOperand_YieldingAValue_IsShapedToDiscard() {
        let program = Bind(`package P
func compute(ch out chan[int32]) int32 {
    ch <- 1
    return 1
}
func run() int32 {
    let ch = chan[int32](1)
    go compute(ch)
    return <-ch
}`)
        let go_ = Assert.Single(Collect[BoundGoStatement](Body(program, "run")))
        Assert.Equal("System.Threading.Tasks.ValueTask", go_.Expression.Type?.ClrType?.FullName)
        let discard = Assert.IsType[BoundImportedCallExpression](go_.Expression)
        Assert.Equal("Discard", discard.Function.Name)
    }

    private class Collector[T BoundNode] : BoundTreeWalker {
        init() {
            Found = List[T]()
        }

        prop Found List[T] {
            get;
        }

        override func VisitStatement(node BoundStatement) {
            if node is T match {
                Found.Add(match)
            }
            base.VisitStatement(node)
        }

        override func VisitExpression(node BoundExpression) {
            if node is T match {
                Found.Add(match)
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private func Bind(source string) BoundProgram {
            let compilation = Compilation(SyntaxTree.Parse(source))
            Assert.Empty(compilation.GlobalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
            let program = Binder.BindProgram(
                compilation.GlobalScope,
                compilation.References ?? ReferenceResolver.Default()
            )
            Assert.Empty(program.Diagnostics.Where((d Diagnostic) -> d.IsError).Select((d Diagnostic) -> d.Message))
            return program
        }

        private func Body(program BoundProgram, name string) BoundBlockStatement -> program
            .Functions
            .Single((p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == name)
            .Value

        private func Collect[T BoundNode](body BoundStatement) List[T] {
            let collector = Adr0174ScopeLoweringTests.Collector[T]()
            collector.Visit(body)
            return collector.Found
        }
    }
}
