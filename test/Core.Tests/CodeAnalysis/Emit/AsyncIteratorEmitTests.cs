// <copyright file="AsyncIteratorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// End-to-end emit tests for async iterator functions (IAsyncEnumerable/IAsyncEnumerator with yield + await).
/// Tests consume the produced stream via C# reflection; the consumer-side `await for` lowering is exercised
/// by <see cref="AsyncInterpVsEmitParityTests"/>.
/// </summary>
public class AsyncIteratorEmitTests
{
    [Fact]
    public void AsyncIterator_YieldOnly_ProducesValues()
    {
        const string Source = @"package AsyncIterYield
import System
import System.Collections.Generic
import System.Threading.Tasks

func numbers() IAsyncEnumerable[int32] {
    yield 1
    yield 2
    yield 3
}
";
        var items = CompileAndEnumerate<int>(Source, "numbers", nameof(AsyncIterator_YieldOnly_ProducesValues));
        Assert.Equal(new[] { 1, 2, 3 }, items);
    }

    [Fact]
    public void AsyncIterator_YieldWithAwait_ProducesValues()
    {
        const string Source = @"package AsyncIterYieldAwait
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
";
        var items = CompileAndEnumerate<int>(Source, "numbers", nameof(AsyncIterator_YieldWithAwait_ProducesValues));
        Assert.Equal(new[] { 10, 20, 30 }, items);
    }

    [Fact]
    public void AsyncIterator_Empty_ProducesNoValues()
    {
        const string Source = @"package AsyncIterEmpty
import System
import System.Collections.Generic
import System.Threading.Tasks

func empty() IAsyncEnumerable[int32] {
    if false {
        yield 0
    }
}
";
        var items = CompileAndEnumerate<int>(Source, "empty", nameof(AsyncIterator_Empty_ProducesNoValues));
        Assert.Empty(items);
    }

    [Fact]
    public void AsyncIterator_WithParameters_CapturesArguments()
    {
        // Note: `range` is a reserved keyword (used in `for x := range expr`), so the
        // function is named `myRange` here. See issue #147.
        const string Source = @"package AsyncIterParams
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
";
        var items = CompileAndEnumerateWithArgs<int>(Source, "myRange", new object[] { 5, 3 }, nameof(AsyncIterator_WithParameters_CapturesArguments));
        Assert.Equal(new[] { 5, 6, 7 }, items);
    }

    [Fact]
    public void AsyncIterator_MultipleEnumerations_AreIndependent()
    {
        const string Source = @"package AsyncIterMulti
import System
import System.Collections.Generic
import System.Threading.Tasks

func nums() IAsyncEnumerable[int32] {
    yield 1
    yield 2
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncIterator_MultipleEnumerations_AreIndependent));
        try
        {
            var enumerable = InvokeFunction(asm, "nums", null);
            var items1 = ConsumeAsyncEnumerable<int>(enumerable);
            var items2 = ConsumeAsyncEnumerable<int>(enumerable);
            Assert.Equal(new[] { 1, 2 }, items1);
            Assert.Equal(new[] { 1, 2 }, items2);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void AsyncIterator_YieldAwaitYield_ConsumedByReflection_Works()
    {
        // The headline use case: yield, genuine async suspension, yield.
        const string Source = @"package AsyncIterHeadline
import System
import System.Collections.Generic
import System.Threading.Tasks

func GetItemsAsync() IAsyncEnumerable[int32] {
    yield 1
    await Task.Yield()
    yield 2
}
";
        var items = CompileAndEnumerate<int>(Source, "GetItemsAsync", nameof(AsyncIterator_YieldAwaitYield_ConsumedByReflection_Works));
        Assert.Equal(new[] { 1, 2 }, items);
    }

    [Fact]
    public void AsyncIterator_YieldWithTaskDelay_SuspendsAndResumes()
    {
        // Genuine suspension via Task.Delay between yields.
        const string Source = @"package AsyncIterDelay
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
";
        var items = CompileAndEnumerate<int>(Source, "delayed", nameof(AsyncIterator_YieldWithTaskDelay_SuspendsAndResumes));
        Assert.Equal(new[] { 100, 200, 300 }, items);
    }

    [Fact]
    public async Task AsyncIterator_EnumeratorCancellation_RuntimeTokenIsThreaded()
    {
        // Issue #180 / ADR-0040: a CancellationToken parameter annotated
        // @EnumeratorCancellation on an `async sequence` receives the token
        // supplied at GetAsyncEnumerator(ct) time. We verify by passing
        // an already-cancelled token; the iterator's first await on
        // Task.Delay(token) must observe the cancellation and throw.
        const string Source = @"package AsyncIterEC
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
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncIterator_EnumeratorCancellation_RuntimeTokenIsThreaded));
        try
        {
            // Kickoff with default token; runtime token comes via GetAsyncEnumerator.
            var enumerable = (IAsyncEnumerable<int>)InvokeFunction(asm, "numbers", new object[] { default(CancellationToken) });

            using var cts = new CancellationTokenSource();
            cts.Cancel();

            var enumerator = enumerable.GetAsyncEnumerator(cts.Token);
            try
            {
                // First MoveNextAsync should produce the first yielded value.
                Assert.True(await enumerator.MoveNextAsync());
                Assert.Equal(1, enumerator.Current);

                // Second MoveNextAsync awaits Task.Delay(..., ct); since the
                // runtime-supplied token (already cancelled) was threaded into
                // the user parameter, the delay throws OperationCanceledException.
                await Assert.ThrowsAnyAsync<OperationCanceledException>(
                    async () => await enumerator.MoveNextAsync());
            }
            finally
            {
                await enumerator.DisposeAsync();
            }
        }
        finally
        {
            ctx.Unload();
        }
    }

    private static List<T> CompileAndEnumerate<T>(string source, string functionName, string contextName)
    {
        return CompileAndEnumerateWithArgs<T>(source, functionName, null, contextName);
    }

    private static List<T> CompileAndEnumerateWithArgs<T>(string source, string functionName, object[] args, string contextName)
    {
        var (asm, ctx) = CompileToAssembly(source, contextName);
        try
        {
            var enumerable = InvokeFunction(asm, functionName, args);
            return ConsumeAsyncEnumerable<T>(enumerable);
        }
        finally
        {
            ctx.Unload();
        }
    }

    private static (Assembly asm, AssemblyLoadContext ctx) CompileToAssembly(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        var asm = loadContext.LoadFromStream(peStream);
        return (asm, loadContext);
    }

    private static object InvokeFunction(Assembly asm, string functionName, object[] args)
    {
        // GSharp emits package-level functions as static methods on the <Program> type.
        var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
        Assert.NotNull(programType);
        var method = programType!.GetMethod(
            functionName,
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return method!.Invoke(null, args);
    }

    private static List<T> ConsumeAsyncEnumerable<T>(object enumerable)
    {
        // The object should implement IAsyncEnumerable<T>.
        var asyncEnumerable = (IAsyncEnumerable<T>)enumerable;
        var enumerator = asyncEnumerable.GetAsyncEnumerator(CancellationToken.None);
        var items = new List<T>();
        try
        {
            while (enumerator.MoveNextAsync().AsTask().GetAwaiter().GetResult())
            {
                items.Add(enumerator.Current);
            }
        }
        finally
        {
            enumerator.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }

        return items;
    }
}
