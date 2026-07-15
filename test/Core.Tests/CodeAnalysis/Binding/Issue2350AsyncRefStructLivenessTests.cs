// <copyright file="Issue2350AsyncRefStructLivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2350: <see cref="GSharp.Core.CodeAnalysis.Binding.RefStructAsyncLivenessAnalyzer"/>
/// replaces the coarse issue-#367 rule ("no by-ref-like local anywhere in an
/// async function") with sound per-local liveness/control-flow analysis. A
/// by-ref-like (<c>ref struct</c>) local, such as <c>ReadOnlySpan[T]</c>, is
/// now permitted in an async function as long as it is never live across an
/// <c>await</c> suspension point — covering branches, loops (including
/// per-iteration reuse), multiple awaits, and try/catch/finally, while still
/// rejecting genuinely unsafe cases (live-across-suspension, capture, and
/// unsafe finally interaction).
/// </summary>
public class Issue2350AsyncRefStructLivenessTests
{
    // The exact shape reported against Oahu.Diagnostics.PipelineProbeCheck:
    // a Span[T] local is scoped to a single loop iteration and is fully
    // consumed (read) before the loop's own `await`, so its value never
    // needs to survive a suspension.
    [Fact]
    public void PipelineProbeCheck_PerIterationSpanDeadBeforeAwait_IsPermitted()
    {
        var source = @"
import System
import System.Threading.Tasks

async func PipelineProbeCheck(buffer []byte, probeCount int32) Task[int32] {
    var total = 0
    for var i = 0; i < probeCount; i++ {
        var probe ReadOnlySpan[byte] = buffer
        total = total + probe.Length
        await Task.Yield()
    }
    return total
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_UsedThenAwaitedWithNoFurtherUse_IsPermitted()
    {
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    await Task.Yield()
    return len
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_DeclaredThenAwaited_LiveAfterAwait_Reports_GS0219()
    {
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    await Task.Yield()
    return s.Length
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_ReadWithinSameAwaitExpression_Reports_GS0219()
    {
        // The read of `s` and the `await` occur in the very same statement's
        // right-hand side, but `s` is still evaluated (read) before control
        // suspends only if it appears as an argument that is itself
        // evaluated before the await; here `s.Length` feeds an async call
        // whose own await suspends with `s` still needed for the addition
        // afterward — `s` is live across the suspension.
        var source = @"
import System
import System.Threading.Tasks

async func delayAndAdd(n int32) Task[int32] {
    await Task.Yield()
    return n
}

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var extra = await delayAndAdd(1)
    return s.Length + extra
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_DeadOnOneBranchLiveOnOtherAfterAwait_Reports_GS0219()
    {
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32, flag bool) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    if flag {
        await Task.Yield()
        return s.Length
    }
    return 0
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_ConsumedBeforeBranchThatAwaits_IsPermitted()
    {
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32, flag bool) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    if flag {
        await Task.Yield()
    }
    return len
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_ReassignedBetweenTwoAwaits_IsPermitted()
    {
        // Sequential reuse: `s` is fully consumed before the first `await`,
        // then reassigned (a fresh definition kills the earlier value) and
        // consumed again before the second `await` — safe on both spans of
        // its lifetime.
        var source = @"
import System
import System.Threading.Tasks

async func f(a []int32, b []int32) Task[int32] {
    var s ReadOnlySpan[int32] = a
    var first = s.Length
    await Task.Yield()
    s = b
    var second = s.Length
    await Task.Yield()
    return first + second
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_LiveAcrossSecondOfTwoAwaits_Reports_GS0219()
    {
        var source = @"
import System
import System.Threading.Tasks

async func f(a []int32) Task[int32] {
    await Task.Yield()
    var s ReadOnlySpan[int32] = a
    await Task.Yield()
    return s.Length
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_PerIterationLoopWithReuse_ReassignedEachIteration_IsPermitted()
    {
        // Every iteration declares (or reuses) `probe` and fully consumes it
        // before that same iteration's `await` — the loop's own back-edge
        // must not be mistaken for a cross-suspension liveness path.
        var source = @"
import System
import System.Threading.Tasks

async func f(buffers []int32, count int32) Task[int32] {
    var total = 0
    for var i = 0; i < count; i++ {
        var probe ReadOnlySpan[int32] = buffers
        total = total + probe.Length
        await Task.Yield()
    }
    return total
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_UsedAfterLoopAwaitOnNextIteration_Reports_GS0219()
    {
        // `probe` is declared before the loop, consumed once, then read
        // again after the loop's `await` on a later logical use — the same
        // value must survive the suspension, which is unsafe.
        var source = @"
import System
import System.Threading.Tasks

async func f(buffers []int32, count int32) Task[int32] {
    var probe ReadOnlySpan[int32] = buffers
    var total = 0
    for var i = 0; i < count; i++ {
        await Task.Yield()
        total = total + probe.Length
    }
    return total
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_ConsumedEntirelyWithinTry_NoAwaitInFinally_IsPermitted()
    {
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var total = 0
    try {
        var s ReadOnlySpan[int32] = arr
        total = s.Length
    } finally {
        await Task.Yield()
    }
    return total
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_AssignedBeforeAwaitInTry_ReadInFinally_Reports_GS0219()
    {
        // Unsafe finally interaction: an exception thrown right after the
        // `await` inside `try` (or the `await` itself faulting) would
        // transfer control straight to `finally`, where `s` is still read —
        // `s` must be treated as live across that `await`.
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var result = 0
    try {
        await Task.Yield();
        result = 1
    } finally {
        result = result + s.Length
    }
    return result
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_AssignedBeforeAwaitInTry_ReadInCatch_Reports_GS0219()
    {
        // Same "unsafe finally interaction" hazard, but via a `catch` clause
        // instead of `finally`: an exception after the `await` can transfer
        // straight into `catch`, where `s` is still read.
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var result = 0
    try {
        await Task.Yield();
        result = 1
    } catch (e Exception) {
        result = s.Length
    }
    return result
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_DeclaredInCatchConsumedBeforeFinallyAwait_IsPermitted()
    {
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var result = 0
    try {
        result = 1
    } catch (e Exception) {
        var s ReadOnlySpan[int32] = arr
        result = s.Length
    } finally {
        await Task.Yield()
    }
    return result
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
    }

    // Negative control: capture of a by-ref-like local by a closure remains
    // rejected regardless of the async-liveness relaxation — this is
    // pre-existing, unrelated LambdaBinder machinery (issue #367) that this
    // fix must not weaken.
    [Fact]
    public void SpanLocal_CapturedByClosureInAsyncFunction_StillReports_GS0219()
    {
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var g = func() int32 { return s.Length }
    await Task.Yield()
    return g()
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    // Negative control: boxing a by-ref-like value (a general escape,
    // ADR-0058) remains rejected regardless of async context.
    [Fact]
    public void SpanLocal_BoxedToObjectInAsyncFunction_StillReports_GS0219()
    {
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32) Task[object] {
    var s ReadOnlySpan[int32] = arr
    var o object = s
    await Task.Yield()
    return o
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_InNestedAsyncLambda_DeadBeforeOwnAwait_IsPermitted()
    {
        // The by-ref-like local belongs to the nested async lambda's own
        // scope, not the (non-async) enclosing function — confirms nested
        // async function-literal scopes are discovered and independently
        // analyzed.
        var source = @"
import System
import System.Threading.Tasks

func f(arr []int32) Task[int32] {
    var g = async func() int32 {
        var s ReadOnlySpan[int32] = arr
        var len = s.Length
        await Task.Yield()
        return len
    }
    return g()
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_InNestedAsyncLambda_LiveAcrossOwnAwait_Reports_GS0219()
    {
        var source = @"
import System
import System.Threading.Tasks

func f(arr []int32) Task[int32] {
    var g = async func() int32 {
        var s ReadOnlySpan[int32] = arr
        await Task.Yield()
        return s.Length
    }
    return g()
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void SpanLocal_InOuterAsyncFunction_OuterSafeInnerLambdaCaptureStillUnsafe()
    {
        // The outer async function's own `s` is dead before its `await`
        // (safe), but a nested (non-async, ordinary) closure inside it that
        // captures `s` is still rejected by the pre-existing capture rule —
        // confirms the two mechanisms compose correctly and independently.
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    var g = func() int32 { return s.Length }
    await Task.Yield()
    return len + g()
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    // Iterators are explicitly out of scope for issue #2350 (the issue's
    // title and body are scoped to "async functions"); the pre-existing
    // coarse rejection for a by-ref-like local in an iterator must remain
    // untouched.
    [Fact]
    public void SpanLocal_InIterator_StillReports_GS0219()
    {
        var source = @"
import System
import System.Collections.Generic

func gen(arr []int32) sequence[int32] {
    var s ReadOnlySpan[int32] = arr
    yield s.Length
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    // Binds declarations and function bodies and returns the resulting
    // diagnostics without evaluating. Used for constructs (e.g. iterators)
    // that the interpreter cannot execute but whose binder diagnostics still
    // apply.
    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .ToImmutableArray();
    }
}
