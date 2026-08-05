// <copyright file="AsyncInterpVsEmitParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Async/iterator emit golden tests: each case runs GSharp source through the
/// emitter and asserts stdout against the expected golden string. Historically
/// a dual-engine interp↔emit parity harness; the interpreter arm retired with
/// the tree-walking evaluator in ADR-0156 Phase 3c (#3176) — the goldens were
/// the cross-checked parity values and are preserved verbatim.
/// </summary>
public class AsyncInterpVsEmitParityTests
{
    [Fact]
    public void Parity_PureAsyncSequence_TaskFromResult()
    {
        const string Source = @"package ParityPure
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
";
        const string Expected = "6\n15\n";
        AssertParity(Source, Expected, nameof(Parity_PureAsyncSequence_TaskFromResult));
    }

    [Fact]
    public void Parity_RealSuspension_TaskDelay()
    {
        const string Source = @"package ParityDelay
import System
import System.Threading.Tasks

async func run() {
    Console.WriteLine(""A"")
    await Task.Delay(1)
    Console.WriteLine(""B"")
    await Task.Delay(1)
    Console.WriteLine(""C"")
}

run().Wait()
";
        const string Expected = "A\nB\nC\n";
        AssertParity(Source, Expected, nameof(Parity_RealSuspension_TaskDelay));
    }

    [Fact]
    public void Parity_AsyncWithMultipleAwaitsInTry()
    {
        const string Source = @"package ParityMultiAwaitTry
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
    } catch(ex) {
        s = -1
    }
    return s
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
";
        const string Expected = "7\n";
        AssertParity(Source, Expected, nameof(Parity_AsyncWithMultipleAwaitsInTry));
    }

    [Fact]
    public void Parity_AsyncWithNestedTryAroundAwait()
    {
        const string Source = @"package ParityNestedTry
import System
import System.Threading.Tasks

async func run() int32 {
    var s = 0
    try {
        await Task.Delay(1)
        try {
            await Task.Delay(1)
            s = s + 10
        } catch(inner) {
            s = -2
        }
        s = s + 1
    } catch(ex) {
        s = -1
    }
    return s
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
";
        const string Expected = "11\n";
        AssertParity(Source, Expected, nameof(Parity_AsyncWithNestedTryAroundAwait));
    }

    [Fact]
    public void Parity_AsyncTryFinally_RunsOnceOnNormalCompletion()
    {
        // Regression for #137: with the IL `leave` fix, the finally must run
        // exactly once (after the try body completes), not on every async
        // suspension.
        const string Source = @"package ParityFinallyOnce
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
";
        const string Expected = "1\n";
        AssertParity(Source, Expected, nameof(Parity_AsyncTryFinally_RunsOnceOnNormalCompletion));
    }

    [Fact]
    public void Parity_AsyncWithTryCatch_AroundAwait()
    {
        const string Source = @"package ParityTryCatch
import System
import System.Threading.Tasks

async func safe() int32 {
    var result = 0
    try {
        await Task.Delay(1)
        result = 42
    } catch(ex) {
        result = -1
    }
    return result
}

var t = safe()
t.Wait()
Console.WriteLine(t.Result)
";
        const string Expected = "42\n";
        AssertParity(Source, Expected, nameof(Parity_AsyncWithTryCatch_AroundAwait));
    }

    [Fact]
    public void Parity_AsyncWithTryFinally_AroundAwait()
    {
        const string Source = @"package ParityTryFinally
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
";
        const string Expected = "11\n";
        AssertParity(Source, Expected, nameof(Parity_AsyncWithTryFinally_AroundAwait));
    }

    [Fact]
    public void Parity_AsyncAccumulator_MultipleAwaits()
    {
        const string Source = @"package ParityAccum
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
";
        const string Expected = "30\n";
        AssertParity(Source, Expected, nameof(Parity_AsyncAccumulator_MultipleAwaits));
    }

    [Fact]
    public void Parity_SyncIterator_Sequence()
    {
        const string Source = @"package ParitySyncIter
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
";
        const string Expected = "1\n2\n3\n";
        AssertParity(Source, Expected, nameof(Parity_SyncIterator_Sequence));
    }

    [Fact]
    public void Parity_AsyncIterator_YieldWithAwait()
    {
        const string Source = @"package ParityAsyncIter
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
";
        const string Expected = "10\n20\n30\n";
        AssertParity(Source, Expected, nameof(Parity_AsyncIterator_YieldWithAwait));
    }

    [Fact]
    public void AsyncIterator_TopLevelAwaitFor_ProducesValues()
    {
        // Coverage for #138: yield + await inside an async iterator function
        // (`IAsyncEnumerable[int]`) consumed by a TOP-LEVEL `await for`.
        // Historically interpreter-only (the emitter lacked the top-level
        // `await for` consumer); runs emitted since the evaluator retired in
        // ADR-0156 Phase 3c (#3176).
        const string Source = @"package AsyncIterInterp
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
";
        const string Expected = "10\n20\n30\n";
        Assert.Equal(Expected, RunEmitter(Source, nameof(AsyncIterator_TopLevelAwaitFor_ProducesValues)));
    }

    [Fact]
    public void Parity_GoScope_AsyncTarget()
    {
        // Exercises the go+scope emit fix (Func<Task> path).
        const string Source = @"package ParityGoScope
import System
import System.Threading.Tasks
import Gsharp.Extensions.Go

async func work() {
    await Task.Delay(1)
    Console.WriteLine(""hello"")
}

scope {
    go work()
}
Console.WriteLine(""end"")
";
        const string Expected = "hello\nend\n";
        AssertParity(Source, Expected, nameof(Parity_GoScope_AsyncTarget));
    }

    private static void AssertParity(string source, string expected, string contextName)
    {
        var emitOutput = RunEmitter(source, contextName);

        Assert.Equal(expected, emitOutput);
    }

    private static string RunEmitter(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "emit diagnostics:\n  " +
            string.Join("\n  ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                var ret = entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
                if (ret is Task task)
                {
                    task.Wait(TimeSpan.FromSeconds(30));
                }
            }
            catch (TargetInvocationException ex) when (ex.InnerException is AggregateException agg)
            {
                throw agg.InnerException ?? agg;
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString().Replace("\r\n", "\n");
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
