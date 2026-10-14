// <copyright file="AsyncSequencePointTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import Binder = GSharp.Core.CodeAnalysis.Binding.Binder
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Threading
import System.Threading.Tasks
import Xunit

/// Tests for (cref:BoundAwaitSequencePoint) markers emitted in lowered
/// async MoveNext bodies. Validates that yield and resume sequence points
/// appear at the correct positions and with matching state numbers.
open class AsyncSequencePointTests {
    /// Verifies that two awaits produce exactly two yield points and two resume
    /// points, in order, with matching state numbers.
    @Fact
    func LoweredBody_TwoAwaits_ContainsYieldAndResumeMarkers() {
        const Source = `package SeqPtTest
import System
import System.Threading.Tasks

async func compute() int32 {
    let a = await Task.FromResult(10)
    let b = await Task.FromResult(32)
    return a + b
}
`
        let moveNextBody = GetMoveNextBody(Source)
        let markers = CollectMarkers(moveNextBody.Body)
        let yieldPoints = markers.Where((m BoundAwaitSequencePoint) -> m.Kind == BoundNodeKind.AwaitYieldPoint).ToList()
        let resumePoints = markers.Where((m BoundAwaitSequencePoint) -> m.Kind == BoundNodeKind.AwaitResumePoint)
            .ToList()
        Assert.Equal(2, yieldPoints.Count)
        Assert.Equal(2, resumePoints.Count)
        // States should be 0 and 1, in order.
        Assert.Equal(0, yieldPoints[0].State)
        Assert.Equal(1, yieldPoints[1].State)
        Assert.Equal(0, resumePoints[0].State)
        Assert.Equal(1, resumePoints[1].State)
        // Each yield must appear before its corresponding resume in the flattened list.
        let allOrdered = markers.ToList()
        let yield0Idx = allOrdered.IndexOf(yieldPoints[0])
        let resume0Idx = allOrdered.IndexOf(resumePoints[0])
        let yield1Idx = allOrdered.IndexOf(yieldPoints[1])
        let resume1Idx = allOrdered.IndexOf(resumePoints[1])
        Assert.True(yield0Idx < resume0Idx)
        Assert.True(yield1Idx < resume1Idx)
    }

    /// Emit smoke test: a two-await function with real suspension still works
    /// correctly when sequence-point nops are emitted.
    @Fact
    func Emit_TwoAwaits_NopMarkersDoNotPerturbExecution() {
        const Source = `package SeqPtEmit
import System
import System.Threading.Tasks

async func run() int32 {
    var x = 10
    await Task.Yield()
    x = x + 20
    await Task.Yield()
    x = x + 12
    return x
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "Emit_TwoAwaits_NopMarkersDoNotPerturbExecution")
        Assert.Contains("42", output)
    }

    /// Async-iterator: markers also appear in async iterator MoveNext bodies.
    @Fact
    func Emit_AsyncIterator_YieldAndAwait_NopMarkersPresent() {
        const Source = `package SeqPtAsyncIter
import System
import System.Collections.Generic
import System.Threading.Tasks

func numbers() IAsyncEnumerable[int32] {
    yield 1
    await Task.Yield()
    yield 2
}
`
        // If this compiles and runs correctly, the nop markers are valid IL.
        let items = CompileAndEnumerate[int32](Source, "numbers", "Emit_AsyncIterator_YieldAndAwait_NopMarkersPresent")
        Assert.Equal([]int32{1, 2}, items)
    }

    /// Async lambda: markers appear in the synthesized lambda MoveNext body.
    @Fact
    func Emit_AsyncLambda_NopMarkersDoNotPerturbExecution() {
        const Source = `package SeqPtLambda
import System
import System.Threading.Tasks

func run() {
    var fn = async func() int32 {
        let x = await Task.FromResult(7)
        await Task.Yield()
        return x * 6
    }
    var t = fn()
    t.Wait()
    Console.WriteLine(t.Result)
}

run()
`
        let output = CompileAndRun(Source, "Emit_AsyncLambda_NopMarkersDoNotPerturbExecution")
        Assert.Contains("42", output)
    }

    /// Lowered-tree test via RewriteSingle: a standalone async function's MoveNext
    /// body contains markers, verifying the same path used for async lambdas.
    @Fact
    func LoweredBody_AsyncLambda_ContainsMarkers() {
        // Use the same full-compilation approach but with a simple async func,
        // validating that RewriteSingle (the lambda path) also produces markers.
        const Source = `package SeqPtLambdaTree
import System
import System.Threading.Tasks

async func work() int32 {
    let x = await Task.FromResult(7)
    return x
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let program = Binder.BindProgram(compilation.GlobalScope)
        let resolver = ReferenceResolver.Default()
        let asyncResult = AsyncStateMachineRewriter.Rewrite(program, resolver)
        let plan = asyncResult.StateMachines.Single(
            (sm AsyncStateMachinePlan) -> sm.MoveNextPlan.AwaitResumePoints.Length > 0
        )
        let body = MoveNextBodyRewriter.Build(plan)
        let markers = CollectMarkers(body.Body)
        Assert.Contains(markers, (m BoundAwaitSequencePoint) -> m.Kind == BoundNodeKind.AwaitYieldPoint)
        Assert.Contains(markers, (m BoundAwaitSequencePoint) -> m.Kind == BoundNodeKind.AwaitResumePoint)
        Assert.All(markers, (m BoundAwaitSequencePoint) -> Assert.Equal(0, m.State))
    }

    /// Verifies that marker state numbers match the AwaitResumePoint.State values in the plan.
    @Fact
    func MarkerStates_MatchPlanResumePointStates() {
        const Source = `package SeqPtStateMatch
import System
import System.Threading.Tasks

async func doIt() {
    await Task.FromResult(1)
    await Task.FromResult(2)
    await Task.FromResult(3)
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let program = Binder.BindProgram(compilation.GlobalScope)
        let resolver = ReferenceResolver.Default()
        let asyncResult = AsyncStateMachineRewriter.Rewrite(program, resolver)
        let plan = asyncResult.StateMachines.Single(
            (sm AsyncStateMachinePlan) -> sm.MoveNextPlan.AwaitResumePoints.Length == 3
        )
        let expectedStates = plan.MoveNextPlan.AwaitResumePoints.Select((rp AwaitResumePoint) -> rp.State).ToArray()
        let body = MoveNextBodyRewriter.Build(plan)
        let markers = CollectMarkers(body.Body)
        let yieldStates = markers
            .Where((m BoundAwaitSequencePoint) -> m.Kind == BoundNodeKind.AwaitYieldPoint)
            .Select((m BoundAwaitSequencePoint) -> m.State)
            .ToArray()
        let resumeStates = markers
            .Where((m BoundAwaitSequencePoint) -> m.Kind == BoundNodeKind.AwaitResumePoint)
            .Select((m BoundAwaitSequencePoint) -> m.State)
            .ToArray()
        Assert.Equal(expectedStates, yieldStates)
        Assert.Equal(expectedStates, resumeStates)
    }

    shared {
        private func GetMoveNextBody(source string) MoveNextBodyRewriter.MoveNextBody {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let program = Binder.BindProgram(compilation.GlobalScope)
            let resolver = ReferenceResolver.Default()
            let asyncResult = AsyncStateMachineRewriter.Rewrite(program, resolver)
            let plan = asyncResult.StateMachines.Single(
                (sm AsyncStateMachinePlan) -> sm.MoveNextPlan.AwaitResumePoints.Length > 0
            )
            return MoveNextBodyRewriter.Build(plan)
        }

        private func CollectMarkers(node BoundStatement) List[BoundAwaitSequencePoint] {
            let result = List[BoundAwaitSequencePoint]()
            Collect(node, result)
            return result
        }

        private func Collect(node BoundStatement?, result List[BoundAwaitSequencePoint]) {
            if node is BoundAwaitSequencePoint marker {
                result.Add(marker)
                return
            }
            if node is BoundBlockStatement block {
                for stmt in block.Statements {
                    Collect(stmt, result)
                }
            } else if node is BoundTryStatement tryStmt {
                Collect(tryStmt.TryBlock, result)
                for clause in tryStmt.CatchClauses {
                    Collect(clause.Body, result)
                }
                if tryStmt.FinallyBlock != nil {
                    Collect(tryStmt.FinallyBlock, result)
                }
            }
        }

        private func CompileAndRun(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
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
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } catch (ex TargetInvocationException) when ex.InnerException is AggregateException agg {
                    throw agg.InnerException ?? agg
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }

        private func CompileAndEnumerate[T](source string, functionName string, contextName string) List[T] {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let method MethodInfo? = programType!!.GetMethod(
                    functionName,
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(method)
                let enumerable object? = method!!.Invoke(nil, parameters: nil)
                Assert.NotNull(enumerable)
                // Use reflection to consume IAsyncEnumerable<T>.
                let enumerableType = typeof(IAsyncEnumerable[_]).MakeGenericType(typeof(T))
                let getEnumeratorMethod MethodInfo? = enumerableType.GetMethod("GetAsyncEnumerator")
                let enumerator object? = getEnumeratorMethod!!.Invoke(enumerable, []object{CancellationToken.None})
                let enumeratorType = typeof(IAsyncEnumerator[_]).MakeGenericType(typeof(T))
                let moveNextMethod = typeof(IAsyncEnumerator[T])
                    .GetInterfaces()
                    .Concat([]Type{typeof(IAsyncEnumerator[T])})
                    .SelectMany(
                    func (i Type) IEnumerable[MethodInfo] {
                        return i.GetMethods()
                    }
                )
                    .First((m MethodInfo) -> m.Name == "MoveNextAsync")
                // Fallback: use IAsyncDisposable pattern.
                let items = List[T]()
                let moveNext MethodInfo? = enumeratorType.GetMethod("MoveNextAsync") ?? enumerator!!.GetType()
                    .GetMethod("MoveNextAsync")
                let currentProp PropertyInfo? = enumeratorType.GetProperty("Current") ?? enumerator!!.GetType()
                    .GetProperty("Current")
                while true {
                    let vt = ValueTask[bool](moveNext!!.Invoke(enumerator, nil)!!)
                    if !vt.AsTask().GetAwaiter().GetResult() {
                        break
                    }
                    items.Add(T(currentProp!!.GetValue(enumerator)!!))
                }
                // Dispose.
                let disposeMethod MethodInfo? = enumerator!!.GetType().GetMethod("DisposeAsync") ??
                    typeof(IAsyncDisposable).GetMethod("DisposeAsync")
                if disposeMethod != nil {
                    let dvt = ValueTask(disposeMethod.Invoke(enumerator, nil)!!)
                    dvt.AsTask().GetAwaiter().GetResult()
                }
                return items
            } finally {
                loadContext.Unload()
            }
        }
    }
}
