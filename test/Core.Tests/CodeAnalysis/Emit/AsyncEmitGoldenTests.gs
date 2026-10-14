// <copyright file="AsyncEmitGoldenTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Threading.Tasks
import Xunit

/// Async/iterator emit golden tests: each case runs GSharp source through the
/// emitter and asserts stdout against the expected golden string. Historically
/// a dual-engine interp↔emit parity harness; the interpreter arm retired with
/// the tree-walking evaluator in ADR-0156 Phase 3c (#3176) — the goldens were
/// the cross-checked parity values and are preserved verbatim.
open class AsyncEmitGoldenTests {
    @Fact
    func Emit_PureAsyncSequence_TaskFromResult() {
        const Source = `package AsyncEmitPure
import System
import System.Threading.Tasks

async func compute(n int32) int32 {
    await Task.FromResult(0)
    return n * 3
}

var t1 = compute(2)
t1.Wait()
Console.WriteLine(t1.Result)
var t2 = compute(5)
t2.Wait()
Console.WriteLine(t2.Result)
`
        let Expected = "6${Environment.NewLine}15${Environment.NewLine}"
        AssertEmitOutput(Source, Expected, "Emit_PureAsyncSequence_TaskFromResult")
    }

    @Fact
    func Emit_RealSuspension_TaskDelay() {
        const Source = `package AsyncEmitDelay
import System
import System.Threading.Tasks

async func run() {
    Console.WriteLine("A")
    await Task.Delay(1)
    Console.WriteLine("B")
    await Task.Delay(1)
    Console.WriteLine("C")
}

run().Wait()
`
        let Expected = "A${Environment.NewLine}B${Environment.NewLine}C${Environment.NewLine}"
        AssertEmitOutput(Source, Expected, "Emit_RealSuspension_TaskDelay")
    }

    @Fact
    func Emit_AsyncWithMultipleAwaitsInTry() {
        const Source = `package AsyncEmitMultiAwaitTry
import System
import System.Threading.Tasks

async func run() int32 {
    var s = 0
    try {
        await Task.Delay(1)
        s = s + 1
        await Task.Delay(1)
        s = s + 2
        await Task.Delay(1)
        s = s + 4
    } catch (ex Exception) {
        s = -1
    }
    return s
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let Expected = "7${Environment.NewLine}"
        AssertEmitOutput(Source, Expected, "Emit_AsyncWithMultipleAwaitsInTry")
    }

    @Fact
    func Emit_AsyncWithNestedTryAroundAwait() {
        const Source = `package AsyncEmitNestedTry
import System
import System.Threading.Tasks

async func run() int32 {
    var s = 0
    try {
        await Task.Delay(1)
        try {
            await Task.Delay(1)
            s = s + 10
        } catch (inner Exception) {
            s = -2
        }
        s = s + 1
    } catch (ex Exception) {
        s = -1
    }
    return s
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let Expected = "11${Environment.NewLine}"
        AssertEmitOutput(Source, Expected, "Emit_AsyncWithNestedTryAroundAwait")
    }

    @Fact
    func Emit_AsyncTryFinally_RunsOnceOnNormalCompletion() {
        // Regression for #137: with the IL `leave` fix, the finally must run
        // exactly once (after the try body completes), not on every async
        // suspension.
        const Source = `package AsyncEmitFinallyOnce
import System
import System.Threading.Tasks

async func run() int32 {
    var count = 0
    try {
        await Task.Delay(1)
        await Task.Delay(1)
        await Task.Delay(1)
    } finally {
        count = count + 1
    }
    return count
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let Expected = "1${Environment.NewLine}"
        AssertEmitOutput(Source, Expected, "Emit_AsyncTryFinally_RunsOnceOnNormalCompletion")
    }

    @Fact
    func Emit_AsyncWithTryCatch_AroundAwait() {
        const Source = `package AsyncEmitTryCatch
import System
import System.Threading.Tasks

async func safe() int32 {
    var result = 0
    try {
        await Task.Delay(1)
        result = 42
    } catch (ex Exception) {
        result = -1
    }
    return result
}

var t = safe()
t.Wait()
Console.WriteLine(t.Result)
`
        let Expected = "42${Environment.NewLine}"
        AssertEmitOutput(Source, Expected, "Emit_AsyncWithTryCatch_AroundAwait")
    }

    @Fact
    func Emit_AsyncWithTryFinally_AroundAwait() {
        const Source = `package AsyncEmitTryFinally
import System
import System.Threading.Tasks

async func withFinally() int32 {
    var x = 0
    try {
        await Task.Delay(1)
        x = 10
    } finally {
        x = x + 1
    }
    return x
}

var t = withFinally()
t.Wait()
Console.WriteLine(t.Result)
`
        let Expected = "11${Environment.NewLine}"
        AssertEmitOutput(Source, Expected, "Emit_AsyncWithTryFinally_AroundAwait")
    }

    @Fact
    func Emit_AsyncAccumulator_MultipleAwaits() {
        const Source = `package AsyncEmitAccum
import System
import System.Threading.Tasks

async func accum() int32 {
    var sum = 0
    await Task.Delay(1)
    sum = sum + 10
    await Task.Delay(1)
    sum = sum + 20
    return sum
}

var t = accum()
t.Wait()
Console.WriteLine(t.Result)
`
        let Expected = "30${Environment.NewLine}"
        AssertEmitOutput(Source, Expected, "Emit_AsyncAccumulator_MultipleAwaits")
    }

    @Fact
    func Emit_SyncIterator_Sequence() {
        const Source = `package AsyncEmitSyncIter
import System
import System.Collections.Generic

func nums() IEnumerable[int32] {
    yield 1
    yield 2
    yield 3
}

for x in nums() {
    Console.WriteLine(x)
}
`
        let Expected = "1${Environment.NewLine}2${Environment.NewLine}3${Environment.NewLine}"
        AssertEmitOutput(Source, Expected, "Emit_SyncIterator_Sequence")
    }

    @Fact
    func Emit_AsyncIterator_YieldWithAwait() {
        const Source = `package AsyncEmitAsyncIter
import System
import System.Collections.Generic
import System.Threading.Tasks

func gen() IAsyncEnumerable[int32] {
    yield 10
    await Task.Delay(1)
    yield 20
    await Task.Delay(1)
    yield 30
}

async func consume() {
    await for x in gen() {
        Console.WriteLine(x)
    }
}

consume().Wait()
`
        let Expected = "10${Environment.NewLine}20${Environment.NewLine}30${Environment.NewLine}"
        AssertEmitOutput(Source, Expected, "Emit_AsyncIterator_YieldWithAwait")
    }

    @Fact
    func AsyncIterator_TopLevelAwaitFor_ProducesValues() {
        // Coverage for #138: yield + await inside an async iterator function
        // (`IAsyncEnumerable[int]`) consumed by a TOP-LEVEL `await for`.
        // Historically interpreter-only (the emitter lacked the top-level
        // `await for` consumer); runs emitted since the evaluator retired in
        // ADR-0156 Phase 3c (#3176).
        const Source = `package AsyncIterInterp
import System
import System.Collections.Generic
import System.Threading.Tasks

func gen() IAsyncEnumerable[int32] {
    yield 10
    await Task.Delay(1)
    yield 20
    await Task.Delay(1)
    yield 30
}

await for x in gen() {
    Console.WriteLine(x)
}
`
        let Expected = "10${Environment.NewLine}20${Environment.NewLine}30${Environment.NewLine}"
        Assert.Equal(Expected, RunEmitter(Source, "AsyncIterator_TopLevelAwaitFor_ProducesValues"))
    }

    @Fact
    func Emit_GoScope_AsyncTarget() {
        // Exercises the go+scope emit fix (Func<Task> path).
        const Source = `package AsyncEmitGoScope
import System
import System.Threading.Tasks

async func work() {
    await Task.Delay(1)
    Console.WriteLine("hello")
}

scope {
    go work()
}
Console.WriteLine("end")
`
        let Expected = "hello${Environment.NewLine}end${Environment.NewLine}"
        AssertEmitOutput(Source, Expected, "Emit_GoScope_AsyncTarget")
    }

    shared {
        private func AssertEmitOutput(source string, expected string, contextName string) {
            let emitOutput = RunEmitter(source, contextName)
            Assert.Equal(expected, emitOutput)
        }

        private func RunEmitter(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "emit diagnostics:\n  " + string.Join("\n  ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    let ret object? = entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                    if ret is Task task {
                        task.Wait(TimeSpan.FromSeconds(30))
                    }
                } catch (ex TargetInvocationException) when ex.InnerException is AggregateException agg {
                    throw agg.InnerException ?? agg
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString().ReplaceLineEndings(Environment.NewLine)
            } finally {
                loadContext.Unload()
            }
        }
    }
}
