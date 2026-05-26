// <copyright file="AsyncInterpVsEmitParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Interp↔emit parity tests: each case runs the same GSharp source through
/// both the interpreter and the emitter, then asserts that both produce
/// identical stdout matching the expected golden string.
/// </summary>
public class AsyncInterpVsEmitParityTests
{
    [Fact]
    public void Parity_PureAsyncSequence_TaskFromResult()
    {
        const string Source = @"package ParityPure
import System
import System.Threading.Tasks

async func compute(n int) int {
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

async func run() int {
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

async func run() int {
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

async func run() int {
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

async func safe() int {
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

async func withFinally() int {
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

async func accum() int {
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

func nums() IEnumerable[int] {
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

func gen() IAsyncEnumerable[int] {
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
    public void AsyncIterator_InterpOnly_ProducesValues()
    {
        // Interpreter-side coverage for #138: yield + await inside an async
        // iterator function (`IAsyncEnumerable[int]`). The matching parity
        // test is skipped because the emitter does not yet implement the
        // `await for` consumer side; this test exercises the interpreter
        // alone so the producer side does not regress.
        const string Source = @"package AsyncIterInterp
import System
import System.Collections.Generic
import System.Threading.Tasks

func gen() IAsyncEnumerable[int] {
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
        Assert.Equal(Expected, RunInterpreter(Source));
    }

    [Fact]
    public void Parity_GoScope_AsyncTarget()
    {
        // Exercises the go+scope emit fix (Func<Task> path).
        const string Source = @"package ParityGoScope
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
        const string Expected = "hello\nend\n";
        AssertParity(Source, Expected, nameof(Parity_GoScope_AsyncTarget));
    }

    private static void AssertParity(string source, string expected, string contextName)
    {
        var interpOutput = RunInterpreter(source);
        var emitOutput = RunEmitter(source, contextName);

        Assert.Equal(expected, interpOutput);
        Assert.Equal(expected, emitOutput);
    }

    private static string RunInterpreter(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);

        var prevOut = Console.Out;
        var captured = new StringWriter();
        Console.SetOut(captured);
        EvaluationResult result;
        try
        {
            result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        Assert.True(
            result.Diagnostics.IsEmpty,
            "interpreter diagnostics:\n  " +
            string.Join("\n  ", result.Diagnostics.Select(d => d.ToString())));

        return captured.ToString().Replace("\r\n", "\n");
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
                var ret = entry!.Invoke(null, parameters: null);
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
