// <copyright file="SuspensionInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding.Suspension

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0174 D4: suspension is inferred. A plain `func` that performs a
/// channel operation, or calls a function that suspends, becomes suspending
/// ((cref:SuspendingKind.Inferred)) after a fixed point over the call
/// graph; the calls to it are retyped and completed exactly like calls to a
/// declared `suspend func`. Inference stops at the ADR's boundaries and
/// does not color through a `go` operand or a `lock` body.
/// @remarks Discrimination witnesses (ADR-0154): a mutant that runs one pass instead
/// of iterating breaks (cref:MutualRecursion_Converges); a mutant that
/// colors through a `go` operand breaks (cref:GoOperand_DoesNotColorTheCaller);
/// a mutant that colors the entry point breaks (cref:EntryPoint_StaysARoot).
open class SuspensionInferenceTests {
    @Fact
    func DirectChannelOperation_ColorsTheFunction() {
        let program = Bind(`package P
func take(ch in chan[int32]) int32 {
    return <-ch
}
func send(ch out chan[int32], v int32) {
    ch <- v
}
func drain(ch in chan[int32]) int32 {
    var s = 0
    for v in ch {
        s = s + v
    }
    return s
}
func plain(x int32) int32 {
    return x + 1
}`)
        Assert.Equal(SuspendingKind.Inferred, Function(program, "take").SuspendingKind)
        Assert.Equal(SuspendingKind.Inferred, Function(program, "send").SuspendingKind)
        Assert.Equal(SuspendingKind.Inferred, Function(program, "drain").SuspendingKind)
        Assert.Equal(SuspendingKind.None, Function(program, "plain").SuspendingKind)
        Assert.True(Function(program, "take").AsyncReturnsValueTask)
        Assert.False(Function(program, "take").IsAsync)
        Assert.Equal(TypeSymbol.Int32, Function(program, "take").Type)
    }

    @Fact
    func TransitiveCall_ColorsTheCaller_AndTheCallBecomesAnAwait() {
        let program = Bind(`package P
func take(ch in chan[int32]) int32 {
    return <-ch
}
func twice(ch in chan[int32]) int32 {
    return take(ch) + take(ch)
}
func thrice(ch in chan[int32]) int32 {
    return twice(ch) + take(ch)
}`)
        Assert.Equal(SuspendingKind.Inferred, Function(program, "twice").SuspendingKind)
        Assert.Equal(SuspendingKind.Inferred, Function(program, "thrice").SuspendingKind)
        let awaits = Awaits(Body(program, "twice"))
        Assert.Equal(2, awaits.Count)
        Assert.All(awaits, (a BoundAwaitExpression) -> Assert.Equal(TypeSymbol.Int32, a.Type))
        Assert.All(awaits, (a BoundAwaitExpression) -> Assert.Contains("ValueTask", a.Expression.Type.Name))
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func MutualRecursion_Converges() {
        let program = Bind(`package P
func ping(a chan[int32], b chan[int32], n int32) {
    if n == 0 {
        return
    }
    a <- n
    pong(a, b, n - 1)
}
func pong(a chan[int32], b chan[int32], n int32) {
    let v = <-a
    b <- v
    ping(a, b, n)
}
func caller(a chan[int32], b chan[int32]) {
    ping(a, b, 2)
}
func outer(a chan[int32], b chan[int32]) {
    caller(a, b)
}`)
        Assert.Equal(SuspendingKind.Inferred, Function(program, "ping").SuspendingKind)
        Assert.Equal(SuspendingKind.Inferred, Function(program, "pong").SuspendingKind)
        Assert.Equal(SuspendingKind.Inferred, Function(program, "caller").SuspendingKind)
        Assert.Equal(SuspendingKind.Inferred, Function(program, "outer").SuspendingKind)
        Assert.Single(Awaits(Body(program, "outer")))
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func GoOperand_DoesNotColorTheCaller() {
        let program = Bind(`package P
func produce(ch out chan[int32]) {
    ch <- 1
    ch.Close()
}
func spawn(ch chan[int32]) int32 {
    go produce(ch)
    return 1
}`)
        Assert.Equal(SuspendingKind.Inferred, Function(program, "produce").SuspendingKind)
        Assert.Equal(SuspendingKind.None, Function(program, "spawn").SuspendingKind)
        Assert.Empty(Awaits(Body(program, "spawn")))
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func EntryPoint_StaysARoot_AndBridgesSilently() {
        let program = Bind(`package P
func take(ch in chan[int32]) int32 {
    return <-ch
}
let ch = chan[int32](1)
ch <- 1
let v = take(ch)`)
        let entry = program.Functions.Keys.Single((f FunctionSymbol) -> f.IsTopLevelEntryPoint)
        Assert.Equal(SuspendingKind.None, entry.SuspendingKind)
        Assert.Empty(Awaits(program.Functions[entry]))
        Assert.Single(Bridges(program.Functions[entry]))
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func AsyncCaller_AwaitsTheInferredCallee() {
        let program = Bind(`package P
func take(ch in chan[int32]) int32 {
    return <-ch
}
async func run(ch chan[int32]) int32 {
    return take(ch)
}`)
        Assert.True(Function(program, "run").IsAsync)
        Assert.Equal(SuspendingKind.None, Function(program, "run").SuspendingKind)
        Assert.Single(Awaits(Body(program, "run")))
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func CallingAnAsyncFunc_DoesNotColor_ButAwaitingItDoes() {
        let program = Bind(`package P
import System.Threading.Tasks
async func work() int32 {
    await Task.Yield()
    return 1
}
func starts() Task[int32] {
    return work()
}
suspend func waits() int32 {
    return await work()
}`)
        Assert.Equal(SuspendingKind.None, Function(program, "starts").SuspendingKind)
        Assert.Equal(SuspendingKind.Declared, Function(program, "waits").SuspendingKind)
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func Boundaries_AreNotInferred_AndKeepBlocking() {
        let program = Bind(`package P
interface Source {
    func Next() int32;
}
class ChanSource : Source {
    var ch chan[int32] = chan[int32](2)
    func Next() int32 {
        return <-ch
    }
    func Fill() {
        ch <- 1
    }
}
open class Base {
    open func Read(ch chan[int32]) int32 {
        return <-ch
    }
}
func gen(ch chan[int32]) sequence[int32] {
    yield <-ch
}`)
        Assert.Equal(SuspendingKind.None, Function(program, "Next").SuspendingKind)
        Assert.Equal(SuspendingKind.Inferred, Function(program, "Fill").SuspendingKind)
        Assert.Equal(SuspendingKind.None, Function(program, "Read").SuspendingKind)
        Assert.Equal(SuspendingKind.None, Function(program, "gen").SuspendingKind)
    }

    @Fact
    func UserMain_IsTheRoot_AndFixedBodies_AreBoundaries() {
        let program = Bind(`package P
func take(ch in chan[int32]) int32 {
    return <-ch
}
func pinned(xs []int32, ch chan[int32]) int32 {
    ch <- 1
    unsafe {
        fixed p *int32 = xs {
            return *p + <-ch
        }
    }
    return 0
}
func Main() {
    let ch = chan[int32](1)
    ch <- 1
    let v = take(ch)
}`)
        Assert.Equal(SuspendingKind.None, Function(program, "Main").SuspendingKind)
        Assert.Equal(SuspendingKind.None, Function(program, "pinned").SuspendingKind)
        Assert.Equal(SuspendingKind.Inferred, Function(program, "take").SuspendingKind)
        Assert.Single(Bridges(Body(program, "Main")))
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func ResidualBridge_InABoundaryFunction_ReportsGS0558() {
        let program = Bind(`package P
func take(ch in chan[int32]) int32 {
    return <-ch
}
open class Reader {
    open func Read(ch chan[int32]) int32 {
        return take(ch)
    }
}`)
        let diagnostic = Assert.Single(program.Diagnostics)
        Assert.Equal("GS0558", diagnostic.Id)
        Assert.Contains("'take'", diagnostic.Message)
        Assert.Single(Bridges(Body(program, "Read")))
    }

    @Fact
    func DirectChannelOpsCallWithContext_DoesNotColor() {
        let program = Bind(`package P
import Gsharp.Concurrency
func send() {
    let ch = Chan[int32](1)
    ChannelOps.Send(ch, 1, Context.None)
}`)
        Assert.Equal(SuspendingKind.None, Function(program, "send").SuspendingKind)
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func DirectChannelOpsCallWithDefaultContext_DoesNotColor() {
        let program = Bind(`package P
import Gsharp.Concurrency
func send() {
    let ch = Chan[int32](1)
    ChannelOps.Send(ch, 1, default(Context))
}`)
        Assert.Equal(SuspendingKind.None, Function(program, "send").SuspendingKind)
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func DirectScopeFrameExit_DoesNotColor() {
        let program = Bind(`package P
import Gsharp.Concurrency
func finish() {
    let frame = ScopeFrame.Enter(Context.None)
    frame.Exit()
}`)
        Assert.Equal(SuspendingKind.None, Function(program, "finish").SuspendingKind)
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func ChannelOperationInsideLock_DoesNotColor() {
        let program = Bind(`package P
class Gate {
}
func guarded(ch chan[int32]) int32 {
    var v = 0
    lock gate {
        v = <-ch
    }
    return v
}
let gate = Gate()`)
        Assert.Equal(SuspendingKind.None, Function(program, "guarded").SuspendingKind)
        Assert.Empty(program.Diagnostics)
    }

    @Fact
    func LambdaBody_CallingAnInferredFunction_IsBridged() {
        let program = Bind(`package P
func take(ch in chan[int32]) int32 {
    return <-ch
}
func build(ch chan[int32]) (int32) -> int32 {
    return (x) -> take(ch) + x
}`)
        Assert.Equal(SuspendingKind.None, Function(program, "build").SuspendingKind)
        let literals = Literals(Body(program, "build"))
        let literal = Assert.Single(literals)
        Assert.Single(Bridges(literal.Body))
        let diagnostic = Assert.Single(program.Diagnostics)
        Assert.Equal("GS0558", diagnostic.Id)
    }

    private class Collector : BoundTreeWalker {
        init() {
            Awaits = List[BoundAwaitExpression]()
            Bridges = List[BoundImportedCallExpression]()
            Literals = List[BoundFunctionLiteralExpression]()
        }

        prop Awaits List[BoundAwaitExpression] {
            get;
        }

        prop Bridges List[BoundImportedCallExpression] {
            get;
        }

        prop Literals List[BoundFunctionLiteralExpression] {
            get;
        }

        protected override func VisitAwaitExpression(node BoundAwaitExpression) {
            Awaits.Add(node)
            base.VisitAwaitExpression(node)
        }

        protected override func VisitImportedCallExpression(node BoundImportedCallExpression) {
            if node
                .Function
                .Name == "Wait" &&
                node
                .Function
                .ImportedClass
                .ClassType
                .FullName == "Gsharp.Concurrency.Blocking" {
                Bridges.Add(node)
            }
            base.VisitImportedCallExpression(node)
        }

        override func VisitExpression(node BoundExpression) {
            if node is BoundFunctionLiteralExpression literal {
                Literals.Add(literal)
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

        private func Function(program BoundProgram, name string) FunctionSymbol -> program
            .Functions
            .Keys
            .Single((f FunctionSymbol) -> f.Name == name)

        private func Body(program BoundProgram, name string) BoundBlockStatement -> program
            .Functions
            .Single((p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name == name)
            .Value

        private func Awaits(body BoundStatement) List[BoundAwaitExpression] {
            let collector = SuspensionInferenceTests.Collector()
            collector.Visit(body)
            return collector.Awaits
        }

        private func Bridges(body BoundStatement) List[BoundImportedCallExpression] {
            let collector = SuspensionInferenceTests.Collector()
            collector.Visit(body)
            return collector.Bridges
        }

        private func Literals(body BoundStatement) List[BoundFunctionLiteralExpression] {
            let collector = SuspensionInferenceTests.Collector()
            collector.Visit(body)
            return collector.Literals
        }
    }
}
