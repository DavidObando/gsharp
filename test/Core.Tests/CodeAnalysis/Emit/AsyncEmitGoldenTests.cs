// <copyright file="AsyncEmitGoldenTests.cs" company="GSharp">
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
public class AsyncEmitGoldenTests
{
    [Fact]
    public void Emit_PureAsyncSequence_TaskFromResult()
    {
        const string Source = @"package AsyncEmitPure
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
        string Expected = $"6{Environment.NewLine}15{Environment.NewLine}";
        AssertEmitOutput(Source, Expected, nameof(Emit_PureAsyncSequence_TaskFromResult));
    }

    [Fact]
    public void Emit_RealSuspension_TaskDelay()
    {
        const string Source = @"package AsyncEmitDelay
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
        string Expected = $"A{Environment.NewLine}B{Environment.NewLine}C{Environment.NewLine}";
        AssertEmitOutput(Source, Expected, nameof(Emit_RealSuspension_TaskDelay));
    }

    [Fact]
    public void Emit_AsyncWithMultipleAwaitsInTry()
    {
        const string Source = @"package AsyncEmitMultiAwaitTry
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
";
        string Expected = $"7{Environment.NewLine}";
        AssertEmitOutput(Source, Expected, nameof(Emit_AsyncWithMultipleAwaitsInTry));
    }

    [Fact]
    public void Emit_AsyncWithNestedTryAroundAwait()
    {
        const string Source = @"package AsyncEmitNestedTry
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
";
        string Expected = $"11{Environment.NewLine}";
        AssertEmitOutput(Source, Expected, nameof(Emit_AsyncWithNestedTryAroundAwait));
    }

    [Fact]
    public void Emit_AsyncTryFinally_RunsOnceOnNormalCompletion()
    {
        // Regression for #137: with the IL `leave` fix, the finally must run
        // exactly once (after the try body completes), not on every async
        // suspension.
        const string Source = @"package AsyncEmitFinallyOnce
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
        string Expected = $"1{Environment.NewLine}";
        AssertEmitOutput(Source, Expected, nameof(Emit_AsyncTryFinally_RunsOnceOnNormalCompletion));
    }

    [Fact]
    public void Emit_AsyncWithTryCatch_AroundAwait()
    {
        const string Source = @"package AsyncEmitTryCatch
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
";
        string Expected = $"42{Environment.NewLine}";
        AssertEmitOutput(Source, Expected, nameof(Emit_AsyncWithTryCatch_AroundAwait));
    }

    [Fact]
    public void Emit_AsyncWithTryFinally_AroundAwait()
    {
        const string Source = @"package AsyncEmitTryFinally
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
        string Expected = $"11{Environment.NewLine}";
        AssertEmitOutput(Source, Expected, nameof(Emit_AsyncWithTryFinally_AroundAwait));
    }

    [Fact]
    public void Emit_AsyncAccumulator_MultipleAwaits()
    {
        const string Source = @"package AsyncEmitAccum
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
        string Expected = $"30{Environment.NewLine}";
        AssertEmitOutput(Source, Expected, nameof(Emit_AsyncAccumulator_MultipleAwaits));
    }

    [Fact]
    public void Emit_SyncIterator_Sequence()
    {
        const string Source = @"package AsyncEmitSyncIter
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
        string Expected = $"1{Environment.NewLine}2{Environment.NewLine}3{Environment.NewLine}";
        AssertEmitOutput(Source, Expected, nameof(Emit_SyncIterator_Sequence));
    }

    [Fact]
    public void Emit_AsyncIterator_YieldWithAwait()
    {
        const string Source = @"package AsyncEmitAsyncIter
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
        string Expected = $"10{Environment.NewLine}20{Environment.NewLine}30{Environment.NewLine}";
        AssertEmitOutput(Source, Expected, nameof(Emit_AsyncIterator_YieldWithAwait));
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
        string Expected = $"10{Environment.NewLine}20{Environment.NewLine}30{Environment.NewLine}";
        Assert.Equal(Expected, RunEmitter(Source, nameof(AsyncIterator_TopLevelAwaitFor_ProducesValues)));
    }

    [Fact]
    public void Emit_GoScope_AsyncTarget()
    {
        // Exercises the go+scope emit fix (Func<Task> path).
        const string Source = @"package AsyncEmitGoScope
import System
import System.Threading.Tasks

async func work() {
    await Task.Delay(1)
    Console.WriteLine(""hello"")
}

scope {
    go work()
}
Console.WriteLine(""end"")
";
        string Expected = $"hello{Environment.NewLine}end{Environment.NewLine}";
        AssertEmitOutput(Source, Expected, nameof(Emit_GoScope_AsyncTarget));
    }

    private static void AssertEmitOutput(string source, string expected, string contextName)
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

            return captured.ToString().ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
