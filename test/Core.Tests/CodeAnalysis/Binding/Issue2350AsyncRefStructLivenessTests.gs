// <copyright file="Issue2350AsyncRefStructLivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #2350: (cref:GSharp.Core.CodeAnalysis.Binding.RefStructAsyncLivenessAnalyzer)
/// replaces the coarse issue-#367 rule ("no by-ref-like local anywhere in an
/// async function") with sound per-local liveness/control-flow analysis. A
/// by-ref-like (`ref struct`) local, such as `ReadOnlySpan[T]`, is
/// now permitted in an async function as long as it is never live across an
/// `await` suspension point — covering branches, loops (including
/// per-iteration reuse), multiple awaits, and try/catch/finally, while still
/// rejecting genuinely unsafe cases (live-across-suspension, capture, and
/// unsafe finally interaction).
open class Issue2350AsyncRefStructLivenessTests {
    @Theory
    @InlineData("pending Task[int32]", "await pending")
    @InlineData("ch chan[int32]", "<-ch")
    func SpillTemporaryDiagnosticRetainsSuspensionSourceRange(parameter string, suspension string) {
        let source = `
import System
import System.Threading.Tasks
func Consume(value ReadOnlySpan[byte], extra int32) int32 -> value.Length + extra
async func Read(PARAMETER) Task[int32] -> Consume(ReadOnlySpan[byte]([]byte{65}), SUSPENSION)
`.Replace("PARAMETER", parameter).Replace("SUSPENSION", suspension)
        let text = SourceText.From(source)
        let tree = SyntaxTree.Parse(text)
        let compilation = Compilation(tree)
        let program = Binder.BindProgram(compilation.GlobalScope, compilation.References)
        let diagnostic = Assert.Single(program.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0219"))
        Assert.Same(text, diagnostic.Location.Text)
        Assert.Equal(source.IndexOf(suspension, StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.Equal(suspension.Length, diagnostic.Location.Span.Length)
    }

    // The exact shape reported against Oahu.Diagnostics.PipelineProbeCheck:
    // a Span[T] local is scoped to a single loop iteration and is fully
    // consumed (read) before the loop's own `await`, so its value never
    // needs to survive a suspension.
    @Fact
    func PipelineProbeCheck_PerIterationSpanDeadBeforeAwait_IsPermitted() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_UsedThenAwaitedWithNoFurtherUse_IsPermitted() {
        let source = `
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    await Task.Yield()
    return len
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_DeclaredThenAwaited_LiveAfterAwait_Reports_GS0219() {
        let source = `
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    await Task.Yield()
    return s.Length
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_ReadWithinSameAwaitExpression_Reports_GS0219() {
        // The read of `s` and the `await` occur in the very same statement's
        // right-hand side, but `s` is still evaluated (read) before control
        // suspends only if it appears as an argument that is itself
        // evaluated before the await; here `s.Length` feeds an async call
        // whose own await suspends with `s` still needed for the addition
        // afterward — `s` is live across the suspension.
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_DeadOnOneBranchLiveOnOtherAfterAwait_Reports_GS0219() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_ConsumedBeforeBranchThatAwaits_IsPermitted() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_ReassignedBetweenTwoAwaits_IsPermitted() {
        // Sequential reuse: `s` is fully consumed before the first `await`,
        // then reassigned (a fresh definition kills the earlier value) and
        // consumed again before the second `await` — safe on both spans of
        // its lifetime.
        let source = `
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
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_LiveAcrossSecondOfTwoAwaits_Reports_GS0219() {
        let source = `
import System
import System.Threading.Tasks

async func f(a []int32) Task[int32] {
    await Task.Yield()
    var s ReadOnlySpan[int32] = a
    await Task.Yield()
    return s.Length
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_PerIterationLoopWithReuse_ReassignedEachIteration_IsPermitted() {
        // Every iteration declares (or reuses) `probe` and fully consumes it
        // before that same iteration's `await` — the loop's own back-edge
        // must not be mistaken for a cross-suspension liveness path.
        let source = `
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
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_UsedAfterLoopAwaitOnNextIteration_Reports_GS0219() {
        // `probe` is declared before the loop, consumed once, then read
        // again after the loop's `await` on a later logical use — the same
        // value must survive the suspension, which is unsafe.
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_ConsumedEntirelyWithinTry_NoAwaitInFinally_IsPermitted() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_AssignedBeforeAwaitInTry_ReadInFinally_Reports_GS0219() {
        // Unsafe finally interaction: an exception thrown right after the
        // `await` inside `try` (or the `await` itself faulting) would
        // transfer control straight to `finally`, where `s` is still read —
        // `s` must be treated as live across that `await`.
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_AssignedBeforeAwaitInTry_ReadInCatch_Reports_GS0219() {
        // Same "unsafe finally interaction" hazard, but via a `catch` clause
        // instead of `finally`: an exception after the `await` can transfer
        // straight into `catch`, where `s` is still read.
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_DeclaredInCatchConsumedBeforeFinallyAwait_IsPermitted() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    // Negative control: capture of a by-ref-like local by a closure remains
    // rejected regardless of the async-liveness relaxation — this is
    // pre-existing, unrelated LambdaBinder machinery (issue #367) that this
    // fix must not weaken.
    @Fact
    func SpanLocal_CapturedByClosureInAsyncFunction_StillReports_GS0219() {
        let source = `
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var g = func() int32 { return s.Length }
    await Task.Yield()
    return g()
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    // Negative control: boxing a by-ref-like value (a general escape,
    // ADR-0058) remains rejected regardless of async context.
    @Fact
    func SpanLocal_BoxedToObjectInAsyncFunction_StillReports_GS0219() {
        let source = `
import System
import System.Threading.Tasks

async func f(arr []int32) Task[object] {
    var s ReadOnlySpan[int32] = arr
    var o object = s
    await Task.Yield()
    return o
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_InNestedAsyncLambda_DeadBeforeOwnAwait_IsPermitted() {
        // The by-ref-like local belongs to the nested async lambda's own
        // scope, not the (non-async) enclosing function — confirms nested
        // async function-literal scopes are discovered and independently
        // analyzed.
        let source = `
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
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_InNestedAsyncLambda_LiveAcrossOwnAwait_Reports_GS0219() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func SpanLocal_InOuterAsyncFunction_OuterSafeInnerLambdaCaptureStillUnsafe() {
        // The outer async function's own `s` is dead before its `await`
        // (safe), but a nested (non-async, ordinary) closure inside it that
        // captures `s` is still rejected by the pre-existing capture rule —
        // confirms the two mechanisms compose correctly and independently.
        let source = `
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    var g = func() int32 { return s.Length }
    await Task.Yield()
    return len + g()
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    // Iterators are explicitly out of scope for issue #2350 (the issue's
    // title and body are scoped to "async functions"); the pre-existing
    // coarse rejection for a by-ref-like local in an iterator must remain
    // untouched.
    @Fact
    func SpanLocal_InIterator_StillReports_GS0219() {
        let source = `
import System
import System.Collections.Generic

func gen(arr []int32) sequence[int32] {
    var s ReadOnlySpan[int32] = arr
    yield s.Length
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        // Binds declarations and function bodies without executing them. Used when
        // binder diagnostics, rather than runtime behavior, are the test subject.
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let program = Binder.BindProgram(compilation.GlobalScope, compilation.References)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(program.Diagnostics)
                .ToImmutableArray()
        }
    }
}
