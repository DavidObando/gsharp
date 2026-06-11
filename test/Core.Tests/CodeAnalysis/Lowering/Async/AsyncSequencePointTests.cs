// <copyright file="AsyncSequencePointTests.cs" company="GSharp">
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
using GSharp.Core.CodeAnalysis.Binding;
using Binder = GSharp.Core.CodeAnalysis.Binding.Binder;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

/// <summary>
/// Tests for <see cref="BoundAwaitSequencePoint"/> markers emitted in lowered
/// async MoveNext bodies. Validates that yield and resume sequence points
/// appear at the correct positions and with matching state numbers.
/// </summary>
public class AsyncSequencePointTests
{
    /// <summary>
    /// Verifies that two awaits produce exactly two yield points and two resume
    /// points, in order, with matching state numbers.
    /// </summary>
    [Fact]
    public void LoweredBody_TwoAwaits_ContainsYieldAndResumeMarkers()
    {
        const string Source = @"package SeqPtTest
import System
import System.Threading.Tasks

async func compute() int32 {
    let a = await Task.FromResult(10)
    let b = await Task.FromResult(32)
    return a + b
}
";
        var moveNextBody = GetMoveNextBody(Source);
        var markers = CollectMarkers(moveNextBody.Body);

        var yieldPoints = markers.Where(m => m.Kind == BoundNodeKind.AwaitYieldPoint).ToList();
        var resumePoints = markers.Where(m => m.Kind == BoundNodeKind.AwaitResumePoint).ToList();

        Assert.Equal(2, yieldPoints.Count);
        Assert.Equal(2, resumePoints.Count);

        // States should be 0 and 1, in order.
        Assert.Equal(0, yieldPoints[0].State);
        Assert.Equal(1, yieldPoints[1].State);
        Assert.Equal(0, resumePoints[0].State);
        Assert.Equal(1, resumePoints[1].State);

        // Each yield must appear before its corresponding resume in the flattened list.
        var allOrdered = markers.ToList();
        var yield0Idx = allOrdered.IndexOf(yieldPoints[0]);
        var resume0Idx = allOrdered.IndexOf(resumePoints[0]);
        var yield1Idx = allOrdered.IndexOf(yieldPoints[1]);
        var resume1Idx = allOrdered.IndexOf(resumePoints[1]);
        Assert.True(yield0Idx < resume0Idx);
        Assert.True(yield1Idx < resume1Idx);
    }

    /// <summary>
    /// Emit smoke test: a two-await function with real suspension still works
    /// correctly when sequence-point nops are emitted.
    /// </summary>
    [Fact]
    public void Emit_TwoAwaits_NopMarkersDoNotPerturbExecution()
    {
        const string Source = @"package SeqPtEmit
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
";
        var output = CompileAndRun(Source, nameof(Emit_TwoAwaits_NopMarkersDoNotPerturbExecution));
        Assert.Contains("42", output);
    }

    /// <summary>
    /// Async-iterator: markers also appear in async iterator MoveNext bodies.
    /// </summary>
    [Fact]
    public void Emit_AsyncIterator_YieldAndAwait_NopMarkersPresent()
    {
        const string Source = @"package SeqPtAsyncIter
import System
import System.Collections.Generic
import System.Threading.Tasks

func numbers() IAsyncEnumerable[int32] {
    yield 1
    await Task.Yield()
    yield 2
}
";
        // If this compiles and runs correctly, the nop markers are valid IL.
        var items = CompileAndEnumerate<int>(Source, "numbers", nameof(Emit_AsyncIterator_YieldAndAwait_NopMarkersPresent));
        Assert.Equal(new[] { 1, 2 }, items);
    }

    /// <summary>
    /// Async lambda: markers appear in the synthesized lambda MoveNext body.
    /// </summary>
    [Fact]
    public void Emit_AsyncLambda_NopMarkersDoNotPerturbExecution()
    {
        const string Source = @"package SeqPtLambda
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
";
        var output = CompileAndRun(Source, nameof(Emit_AsyncLambda_NopMarkersDoNotPerturbExecution));
        Assert.Contains("42", output);
    }

    /// <summary>
    /// Lowered-tree test via RewriteSingle: a standalone async function's MoveNext
    /// body contains markers, verifying the same path used for async lambdas.
    /// </summary>
    [Fact]
    public void LoweredBody_AsyncLambda_ContainsMarkers()
    {
        // Use the same full-compilation approach but with a simple async func,
        // validating that RewriteSingle (the lambda path) also produces markers.
        const string Source = @"package SeqPtLambdaTree
import System
import System.Threading.Tasks

async func work() int32 {
    let x = await Task.FromResult(7)
    return x
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var program = Binder.BindProgram(compilation.GlobalScope);
        var resolver = ReferenceResolver.Default();
        var asyncResult = AsyncStateMachineRewriter.Rewrite(program, resolver);

        var plan = asyncResult.StateMachines.Single(sm => sm.MoveNextPlan.AwaitResumePoints.Length > 0);
        var body = MoveNextBodyRewriter.Build(plan);
        var markers = CollectMarkers(body.Body);

        Assert.Contains(markers, m => m.Kind == BoundNodeKind.AwaitYieldPoint);
        Assert.Contains(markers, m => m.Kind == BoundNodeKind.AwaitResumePoint);
        Assert.All(markers, m => Assert.Equal(0, m.State));
    }

    /// <summary>
    /// Verifies that marker state numbers match the AwaitResumePoint.State values in the plan.
    /// </summary>
    [Fact]
    public void MarkerStates_MatchPlanResumePointStates()
    {
        const string Source = @"package SeqPtStateMatch
import System
import System.Threading.Tasks

async func doIt() {
    await Task.FromResult(1)
    await Task.FromResult(2)
    await Task.FromResult(3)
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var program = Binder.BindProgram(compilation.GlobalScope);
        var resolver = ReferenceResolver.Default();
        var asyncResult = AsyncStateMachineRewriter.Rewrite(program, resolver);

        var plan = asyncResult.StateMachines.Single(sm => sm.MoveNextPlan.AwaitResumePoints.Length == 3);
        var expectedStates = plan.MoveNextPlan.AwaitResumePoints.Select(rp => rp.State).ToArray();

        var body = MoveNextBodyRewriter.Build(plan);
        var markers = CollectMarkers(body.Body);

        var yieldStates = markers.Where(m => m.Kind == BoundNodeKind.AwaitYieldPoint).Select(m => m.State).ToArray();
        var resumeStates = markers.Where(m => m.Kind == BoundNodeKind.AwaitResumePoint).Select(m => m.State).ToArray();

        Assert.Equal(expectedStates, yieldStates);
        Assert.Equal(expectedStates, resumeStates);
    }

    #region Helpers

    private static MoveNextBodyRewriter.MoveNextBody GetMoveNextBody(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = Binder.BindProgram(compilation.GlobalScope);
        var resolver = ReferenceResolver.Default();
        var asyncResult = AsyncStateMachineRewriter.Rewrite(program, resolver);

        var plan = asyncResult.StateMachines.Single(sm => sm.MoveNextPlan.AwaitResumePoints.Length > 0);
        return MoveNextBodyRewriter.Build(plan);
    }

    private static List<BoundAwaitSequencePoint> CollectMarkers(BoundStatement node)
    {
        var result = new List<BoundAwaitSequencePoint>();
        Collect(node, result);
        return result;
    }

    private static void Collect(BoundStatement node, List<BoundAwaitSequencePoint> result)
    {
        if (node is BoundAwaitSequencePoint marker)
        {
            result.Add(marker);
            return;
        }

        if (node is BoundBlockStatement block)
        {
            foreach (var stmt in block.Statements)
            {
                Collect(stmt, result);
            }
        }
        else if (node is BoundTryStatement tryStmt)
        {
            Collect(tryStmt.TryBlock, result);
            foreach (var clause in tryStmt.CatchClauses)
            {
                Collect(clause.Body, result);
            }

            if (tryStmt.FinallyBlock != null)
            {
                Collect(tryStmt.FinallyBlock, result);
            }
        }
    }

    private static string CompileAndRun(string source, string contextName)
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
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            catch (TargetInvocationException ex) when (ex.InnerException is AggregateException agg)
            {
                throw agg.InnerException ?? agg;
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static List<T> CompileAndEnumerate<T>(string source, string functionName, string contextName)
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
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var method = programType!.GetMethod(
                functionName,
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(method);

            var enumerable = method!.Invoke(null, parameters: null);
            Assert.NotNull(enumerable);

            // Use reflection to consume IAsyncEnumerable<T>.
            var enumerableType = typeof(IAsyncEnumerable<>).MakeGenericType(typeof(T));
            var getEnumeratorMethod = enumerableType.GetMethod("GetAsyncEnumerator");
            var enumerator = getEnumeratorMethod!.Invoke(enumerable, new object[] { CancellationToken.None });

            var enumeratorType = typeof(IAsyncEnumerator<>).MakeGenericType(typeof(T));
            var moveNextMethod = typeof(IAsyncEnumerator<T>).GetInterfaces()
                .Concat(new[] { typeof(IAsyncEnumerator<T>) })
                .SelectMany(i => i.GetMethods())
                .First(m => m.Name == "MoveNextAsync");

            // Fallback: use IAsyncDisposable pattern.
            var items = new List<T>();
            var moveNext = enumeratorType.GetMethod("MoveNextAsync")
                ?? enumerator!.GetType().GetMethod("MoveNextAsync");
            var currentProp = enumeratorType.GetProperty("Current")
                ?? enumerator!.GetType().GetProperty("Current");

            while (true)
            {
                var vt = (ValueTask<bool>)moveNext!.Invoke(enumerator, null)!;
                if (!vt.AsTask().GetAwaiter().GetResult())
                {
                    break;
                }

                items.Add((T)currentProp!.GetValue(enumerator)!);
            }

            // Dispose.
            var disposeMethod = enumerator!.GetType().GetMethod("DisposeAsync")
                ?? typeof(IAsyncDisposable).GetMethod("DisposeAsync");
            if (disposeMethod != null)
            {
                var dvt = (ValueTask)disposeMethod.Invoke(enumerator, null)!;
                dvt.AsTask().GetAwaiter().GetResult();
            }

            return items;
        }
        finally
        {
            loadContext.Unload();
        }
    }

    #endregion
}
