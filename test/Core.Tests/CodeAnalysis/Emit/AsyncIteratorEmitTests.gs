// <copyright file="AsyncIteratorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
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

/// End-to-end emit tests for async iterator functions (IAsyncEnumerable/IAsyncEnumerator with yield +
/// await).
/// Tests consume the produced stream via C# reflection; the consumer-side `await for` lowering is
/// exercised
/// by (cref:AsyncEmitGoldenTests).
open class AsyncIteratorEmitTests {
    @Fact
    func AsyncIterator_YieldOnly_ProducesValues() {
        const Source = `package AsyncIterYield
import System
import System.Collections.Generic
import System.Threading.Tasks

func numbers() IAsyncEnumerable[int32] {
    yield 1
    yield 2
    yield 3
}
`
        let items = CompileAndEnumerate[int32](Source, "numbers", "AsyncIterator_YieldOnly_ProducesValues")
        Assert.Equal([]int32{1, 2, 3}, items)
    }

    @Fact
    func AsyncIterator_YieldWithAwait_ProducesValues() {
        const Source = `package AsyncIterYieldAwait
import System
import System.Collections.Generic
import System.Threading.Tasks

func numbers() IAsyncEnumerable[int32] {
    yield 10
    await Task.Yield()
    yield 20
    await Task.Yield()
    yield 30
}
`
        let items = CompileAndEnumerate[int32](Source, "numbers", "AsyncIterator_YieldWithAwait_ProducesValues")
        Assert.Equal([]int32{10, 20, 30}, items)
    }

    @Fact
    func AsyncIterator_Empty_ProducesNoValues() {
        const Source = `package AsyncIterEmpty
import System
import System.Collections.Generic
import System.Threading.Tasks

func empty() IAsyncEnumerable[int32] {
    if false {
        yield 0
    }
}
`
        let items = CompileAndEnumerate[int32](Source, "empty", "AsyncIterator_Empty_ProducesNoValues")
        Assert.Empty(items)
    }

    @Fact
    func AsyncIterator_WithParameters_CapturesArguments() {
        // Note: `range` is a reserved keyword (used in `for x := range expr`), so the
        // function is named `myRange` here. See issue #147.
        const Source = `package AsyncIterParams
import System
import System.Collections.Generic
import System.Threading.Tasks

func myRange(start int32, count int32) IAsyncEnumerable[int32] {
    var i = 0
    for i < count {
        yield start + i
        i = i + 1
    }
}
`
        let items = CompileAndEnumerateWithArgs[int32](
            Source,
            "myRange",
            []object{5, 3},
            "AsyncIterator_WithParameters_CapturesArguments"
        )
        Assert.Equal([]int32{5, 6, 7}, items)
    }

    @Fact
    func AsyncIterator_MultipleEnumerations_AreIndependent() {
        const Source = `package AsyncIterMulti
import System
import System.Collections.Generic
import System.Threading.Tasks

func nums() IAsyncEnumerable[int32] {
    yield 1
    yield 2
}
`
        let (asm, ctx) = CompileToAssembly(Source, "AsyncIterator_MultipleEnumerations_AreIndependent")
        try {
            let enumerable object? = InvokeFunction(asm, "nums", nil)
            let items1 = ConsumeAsyncEnumerable[int32](enumerable)
            let items2 = ConsumeAsyncEnumerable[int32](enumerable)
            Assert.Equal([]int32{1, 2}, items1)
            Assert.Equal([]int32{1, 2}, items2)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func AsyncIterator_YieldAwaitYield_ConsumedByReflection_Works() {
        // The headline use case: yield, genuine async suspension, yield.
        const Source = `package AsyncIterHeadline
import System
import System.Collections.Generic
import System.Threading.Tasks

func GetItemsAsync() IAsyncEnumerable[int32] {
    yield 1
    await Task.Yield()
    yield 2
}
`
        let items = CompileAndEnumerate[int32](
            Source,
            "GetItemsAsync",
            "AsyncIterator_YieldAwaitYield_ConsumedByReflection_Works"
        )
        Assert.Equal([]int32{1, 2}, items)
    }

    @Fact
    func AsyncIterator_YieldWithTaskDelay_SuspendsAndResumes() {
        // Genuine suspension via Task.Delay between yields.
        const Source = `package AsyncIterDelay
import System
import System.Collections.Generic
import System.Threading.Tasks

func delayed() IAsyncEnumerable[int32] {
    yield 100
    await Task.Delay(1)
    yield 200
    await Task.Delay(1)
    yield 300
}
`
        let items = CompileAndEnumerate[int32](Source, "delayed", "AsyncIterator_YieldWithTaskDelay_SuspendsAndResumes")
        Assert.Equal([]int32{100, 200, 300}, items)
    }

    @Fact
    async func AsyncIterator_EnumeratorCancellation_RuntimeTokenIsThreaded() {
        // Issue #180 / ADR-0040: a CancellationToken parameter annotated
        // @EnumeratorCancellation on an `async sequence` receives the token
        // supplied at GetAsyncEnumerator(ct) time. We verify by passing
        // an already-cancelled token; the iterator's first await on
        // Task.Delay(token) must observe the cancellation and throw.
        const Source = `package AsyncIterEC
import System
import System.Collections.Generic
import System.Runtime.CompilerServices
import System.Threading
import System.Threading.Tasks

func numbers(@EnumeratorCancellation ct CancellationToken) IAsyncEnumerable[int32] {
    yield 1
    await Task.Delay(1000, ct)
    yield 2
}
`
        let (asm, ctx) = CompileToAssembly(Source, "AsyncIterator_EnumeratorCancellation_RuntimeTokenIsThreaded")
        try {
            // Kickoff with default token; runtime token comes via GetAsyncEnumerator.
            let enumerable IAsyncEnumerable[int32]? = cast[IAsyncEnumerable[int32]](
                InvokeFunction(asm, "numbers", []object? {default(CancellationToken)})
            )
            using let cts = CancellationTokenSource()
            cts.Cancel()
            let enumerator = enumerable!!.GetAsyncEnumerator(cts.Token)
            try {
                // First MoveNextAsync should produce the first yielded value.
                Assert.True(await enumerator.MoveNextAsync())
                Assert.Equal(1, enumerator.Current)
                // Second MoveNextAsync awaits Task.Delay(..., ct); since the
                // runtime-supplied token (already cancelled) was threaded into
                // the user parameter, the delay throws OperationCanceledException.
                await Assert.ThrowsAnyAsync[OperationCanceledException](async () -> await enumerator.MoveNextAsync())
            } finally {
                await enumerator.DisposeAsync()
            }
        } finally {
            ctx.Unload()
        }
    }

    shared {
        private func CompileAndEnumerate[T](source string, functionName string, contextName string) List[T] {
            return CompileAndEnumerateWithArgs[T](source, functionName, nil, contextName)
        }

        private func CompileAndEnumerateWithArgs[T](
            source string,
            functionName string,
            args[]?object,
            contextName string
        ) List[T] {
            let (asm, ctx) = CompileToAssembly(source, contextName)
            try {
                let enumerable object? = InvokeFunction(asm, functionName, args)
                return ConsumeAsyncEnumerable[T](enumerable)
            } finally {
                ctx.Unload()
            }
        }

        private func CompileToAssembly(source string, contextName string)(asm Assembly, ctx AssemblyLoadContext) {
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
            let asm = loadContext.LoadFromStream(peStream)
            return (asm, loadContext)
        }

        private func InvokeFunction(asm Assembly, functionName string, args[]?object) object? {
            // GSharp emits package-level functions as static methods on the <Program> type.
            let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            let method MethodInfo? = programType!!.GetMethod(
                functionName,
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(method)
            return method!!.Invoke(nil, args)
        }

        private func ConsumeAsyncEnumerable[T](enumerable object?) List[T] {
            // The object should implement IAsyncEnumerable<T>.
            let asyncEnumerable IAsyncEnumerable[T]? = cast[IAsyncEnumerable[T]](enumerable)
            let enumerator = asyncEnumerable!!.GetAsyncEnumerator(CancellationToken.None)
            let items = List[T]()
            try {
                while enumerator.MoveNextAsync().AsTask().GetAwaiter().GetResult() {
                    items.Add(enumerator.Current)
                }
            } finally {
                enumerator.DisposeAsync().AsTask().GetAwaiter().GetResult()
            }
            return items
        }
    }
}
