// <copyright file="Adr0174AmbientContextTests.cs" company="GSharp">
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

/// ADR-0174 D7: a channel operation observes the innermost enclosing scope's
/// context, so cancelling that block unblocks operations parked inside it.
/// Every operation shape carries the context — the single-value receive, the
/// two-value receive, a channel `for … in` loop, and a send — and an
/// operation outside every scope keeps the uncancellable default.
/// @remarks Discrimination witness (ADR-0154): a mutant that binds every operation
/// against the default token (the shape before D7 landed) breaks every fact
/// here that expects `Gsharp.Concurrency.Context`, and at runtime leaves a
/// parked receive in a cancelled scope hanging forever — see
/// `Adr0174CancellationEmitTests`.
open class Adr0174AmbientContextTests {
    @Fact
    func ReceiveAndSend_InsideAScope_ParkOnTheBlocksContext() {
        let calls = ChannelOpCalls(`package P
func f() {
    let ch = chan[int32](1)
    scope {
        let v = <-ch
        ch <- 1
    }
}`)
        Assert.Equal(2, calls.Count)
        Assert.All(
            calls,
            (call BoundImportedCallExpression) -> Assert.Equal("Gsharp.Concurrency.Context", ContextArgumentType(call))
        )
        Assert.All(
            calls,
            (call BoundImportedCallExpression) -> Assert.IsType[BoundVariableExpression](call.Arguments[^1])
        )
        Assert.All(
            calls,
            (call BoundImportedCallExpression) -> Assert.Equal(
                "ctx",
                (cast[BoundVariableExpression](call.Arguments[^1])).Variable.Name
            )
        )
    }

    @Fact
    func Operations_OutsideEveryScope_ParkOnTheFunctionsHiddenContext() {
        // No lexical scope encloses these, so they observe whatever context the
        // caller passed in — the hidden parameter D7 gives every suspending
        // function. A caller inside a `scope` therefore cancels them too.
        let program = Bind(`package P
func f() {
    let ch = chan[int32](1)
    ch <- 1
    let v = <-ch
}`)
        let function = program
            .Functions
            .Single((p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "f")
            .Key
        Assert.True(function.IsSuspending)
        let hidden = Assert.IsType[ParameterSymbol](function.HiddenContextParameter)
        Assert.Equal("<>ctx", hidden.Name)
        // The hidden parameter is emit-only: it leads the CLR signature and is
        // absent from the parameters overload resolution, hover and signature
        // help see — binding runs again on every keystroke, and a shifted
        // parameter list would break every call site the second time around.
        Assert.Same(hidden, function.EmittedParameters[0])
        Assert.DoesNotContain(hidden, function.Parameters)
        let calls = ChannelOps(
            program.Functions.Single((p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "f").Value
        )
        Assert.Equal(2, calls.Count)
        Assert.All(
            calls,
            (call BoundImportedCallExpression) -> Assert.Equal("Gsharp.Concurrency.Context", ContextArgumentType(call))
        )
        Assert.All(
            calls,
            (call BoundImportedCallExpression) -> Assert.Same(
                hidden,
                Assert.IsType[BoundVariableExpression](call.Arguments[^1]).Variable
            )
        )
    }

    @Fact
    func Operations_InABoundaryFunction_KeepTheUncancellableDefault() {
        // An `open` method cannot be inferred suspending (its signature is a
        // contract), so it never gains a hidden context and its operations stay
        // uncancellable — the shape every channel operation had before D7.
        let program = Bind(`package P
open class Reader {
    open func Take(ch chan[int32]) int32 {
        return <-ch
    }
}`)
        let take = program.Functions.Single(
            (p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "Take"
        )
        Assert.False(take.Key.IsSuspending)
        Assert.Null(take.Key.HiddenContextParameter)
        let call = Assert.Single(ChannelOps(take.Value))
        Assert.Equal("System.Threading.CancellationToken", ContextArgumentType(call))
        Assert.IsType[BoundDefaultExpression](call.Arguments[^1])
    }

    @Fact
    func TwoValueReceive_AndChannelLoop_CarryTheContextToo() {
        let calls = ChannelOpCalls(`package P
func f() {
    let ch = chan[int32](1)
    scope {
        let (v, ok) = <-ch
        for item in ch {
            let unused = item
        }
    }
}`)
        Assert.Equal(2, calls.Count)
        Assert.All(calls, (call BoundImportedCallExpression) -> Assert.Equal("Receive2", call.Function.Name))
        Assert.All(
            calls,
            (call BoundImportedCallExpression) -> Assert.Equal("Gsharp.Concurrency.Context", ContextArgumentType(call))
        )
    }

    @Fact
    func ADeclaredContextParameter_IsUsedInsteadOfAddingAHiddenOne() {
        // ADR-0174 D7: an author who writes `ctx Context` has said how the
        // context arrives. The signature stays exactly as written — visible,
        // and callable from C# — and the operations park on their parameter.
        let program = Bind(`package P
import Gsharp.Concurrency
func worker(ch in chan[int32], ctx Context) int32 {
    return <-ch
}`)
        let worker = program.Functions.Single(
            (p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "worker"
        )
        Assert.True(worker.Key.IsSuspending)
        Assert.Null(worker.Key.HiddenContextParameter)
        Assert.Equal(worker.Key.Parameters.Length, worker.Key.EmittedParameters.Length)
        let declared = worker.Key.Parameters.Single((p ParameterSymbol) -> p.Name == "ctx")
        Assert.Same(declared, worker.Key.AmbientContextParameter)
        let call = Assert.Single(ChannelOps(worker.Value))
        Assert.Same(declared, Assert.IsType[BoundVariableExpression](call.Arguments[^1]).Variable)
    }

    @Fact
    func AVariadicFunction_CarriesNoContext_BecauseItsLastParameterMustStayLast() {
        // The context is appended, and `...T` must be positionally last, so a
        // variadic suspending function keeps its signature and runs its
        // operations uncancelled rather than gaining a broken one.
        let program = Bind(`package P
func sumAll(ch in chan[int32], extras ...int32) int32 {
    var total = <-ch
    for e in extras {
        total = total + e
    }

    return total
}`)
        let sumAll = program.Functions.Single(
            (p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "sumAll"
        )
        Assert.True(sumAll.Key.IsSuspending)
        Assert.Null(sumAll.Key.HiddenContextParameter)
        Assert.Null(sumAll.Key.AmbientContextParameter)
        Assert.Equal(sumAll.Key.Parameters.Length, sumAll.Key.EmittedParameters.Length)
        let call = Assert.Single(ChannelOps(sumAll.Value))
        Assert.Equal("System.Threading.CancellationToken", ContextArgumentType(call))
    }

    @Fact
    func NestedScope_BindsTheInnermostContext() {
        let program = Bind(`package P
func f() {
    let ch = chan[int32](1)
    scope {
        scope {
            let v = <-ch
        }
    }
}`)
        let body = program
            .Functions
            .Single((p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "f")
            .Value
        let contexts = Collect[BoundVariableDeclaration](body)
            .Where((d BoundVariableDeclaration) -> d.Variable.Name == "ctx")
            .Select((d BoundVariableDeclaration) -> d.Variable)
            .ToList()
        Assert.Equal(2, contexts.Count)
        let receive = Assert.Single(ChannelOps(body))
        let used = Assert.IsType[BoundVariableExpression](receive.Arguments[^1]).Variable
        Assert.Same(contexts[1], used)
        Assert.NotSame(contexts[0], used)
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
        private func ContextArgumentType(call BoundImportedCallExpression) string -> call
            .Arguments[^1]
            .Type
            ?.ClrType
            ?.FullName ??
            "?"

        private func ChannelOpCalls(source string) List[BoundImportedCallExpression] {
            let program = Bind(source)
            Assert.DoesNotContain(program.Diagnostics, (d Diagnostic) -> d.IsError)
            return ChannelOps(
                program
                    .Functions
                    .Single((p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == "f")
                    .Value
            )
        }

        private func ChannelOps(body BoundStatement) List[BoundImportedCallExpression] -> Collect[
            BoundImportedCallExpression
        ](body).Where((c BoundImportedCallExpression) -> c.Function.ImportedClass.ClassType.Name == "ChannelOps")
            .ToList()

        private func Bind(source string) BoundProgram {
            let compilation = Compilation(SyntaxTree.Parse(source))
            return Binder.BindProgram(compilation.GlobalScope, compilation.References ?? ReferenceResolver.Default())
        }

        private func Collect[T BoundNode](body BoundStatement) List[T] {
            let collector = Adr0174AmbientContextTests.Collector[T]()
            collector.Visit(body)
            return collector.Found
        }
    }
}
