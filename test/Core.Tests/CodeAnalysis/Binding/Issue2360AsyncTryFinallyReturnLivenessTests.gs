// <copyright file="Issue2360AsyncTryFinallyReturnLivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #2360: an async function containing both a by-ref-like (`ref
/// struct`) local — legalized per-scope by issue #2350's
/// (cref:GSharp.Core.CodeAnalysis.Binding.RefStructAsyncLivenessAnalyzer)
/// — and a `return` lexically inside a `try` whose statement has a
/// `finally` (or `catch`) crashed the compiler with GS9998
/// (`KeyNotFoundException: The given key 'Label1' was not present in the
/// dictionary`) instead of binding cleanly.
/// @remarks Root cause: (cref:GSharp.Core.CodeAnalysis.Lowering.Lowerer) rewrites
/// a `return` lexically inside a protected (try) region into a
/// store-to-temp + `goto` to a synthesized method-exit label placed
/// <em>after</em> the entire lowered try statement (see
/// `Lowerer.RewriteReturnStatement`/`WrapWithMethodExitEpilogue`).
/// (cref:GSharp.Core.CodeAnalysis.Binding.RefStructAsyncLivenessAnalyzer)'s
/// `ProcessTryBackward` then builds a (cref:GSharp.Core.CodeAnalysis.Binding.ControlFlowGraph)
/// scoped to just the try body's own statements (issue #1642's opaque-compound-
/// statement pattern, shared with (cref:GSharp.Core.CodeAnalysis.Binding.DefiniteAssignmentAnalyzer))
/// — but the synthesized `goto`'s target label lives outside that scoped
/// region, so the old, unguarded `blockFromLabel[gs.Label]` lookup in
/// `ControlFlowGraph.GraphBuilder.Build` threw. The fix makes that lookup
/// tolerant of an escaping label, routing it to the region's `end` block
/// exactly like a `return`/`throw` already does — the generalized,
/// case-agnostic invariant the fix relies on. These tests exercise that fix
/// purely at the binder level (fast, no emit); see
/// `Issue2360AsyncTryFinallyReturnEmitTests` for full compile+run coverage.
open class Issue2360AsyncTryFinallyReturnLivenessTests {
    // The exact minimal repro from issue #2360: no await anywhere in the
    // function, so the by-ref-like local is trivially dead across every
    // suspension point (there are none) — this must bind cleanly with no
    // GS0219 and, crucially, must not throw GS9998 while doing so.
    @Fact
    func SpanLocal_ReturnInsideTryFinally_NoAwait_MinimalRepro_IsPermitted() {
        let source = `
import System
import System.IO
import System.Threading.Tasks

async func f(arr []byte) Task[int32] {
    var span ReadOnlySpan[byte] = arr
    var len = span.Length
    var ms = MemoryStream()
    try {
        return len
    } finally {
        ms.Dispose()
    }
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    // A `finally` with no `catch` — the shape closest to a `using`
    // desugaring (see Issue2360AsyncTryFinallyReturnEmitTests for the actual
    // `using let` end-to-end coverage) but expressed directly as try/finally.
    @Fact
    func SpanLocal_ReturnInsideTryFinally_WithRealAwaitElsewhere_SpanDeadBeforeReturn_IsPermitted() {
        let source = `
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    await Task.Yield();
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    try {
        return len
    } finally {
        Console.WriteLine("cleanup")
    }
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func SpanLocal_ReturnInsideTryCatchFinally_NoAwait_IsPermitted() {
        let source = `
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    try {
        return len
    } catch (e Exception) {
        return -1
    } finally {
        Console.WriteLine("cleanup")
    }
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    // The escaping-goto shape can arise inside a `catch` clause's own body
    // just as easily as inside `try` — ProcessTryBackward re-analyzes catch
    // bodies through the same region-scoped AnalyzeRegion path.
    @Fact
    func SpanLocal_ReturnInsideCatchClause_NoAwait_IsPermitted() {
        let source = `
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    try {
        DoWork()
    } catch (e Exception) {
        return len
    } finally {
        Console.WriteLine("cleanup")
    }
    return 0
}

func DoWork() {
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func SpanLocal_MultipleReturnsInSeparateTryFinallyBlocks_IsPermitted() {
        let source = `
import System
import System.Threading.Tasks

async func f(arr []int32, flag bool) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    if flag {
        try {
            return len
        } finally {
            Console.WriteLine("first")
        }
    }

    try {
        return len + 1
    } finally {
        Console.WriteLine("second")
    }
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func SpanLocal_NestedTryFinally_ReturnInInnermostTry_IsPermitted() {
        let source = `
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    try {
        try {
            return len
        } finally {
            Console.WriteLine("inner")
        }
    } finally {
        Console.WriteLine("outer")
    }
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func SpanLocal_ReturnInsideNestedTryFinally_AwaitInOutermostFinally_IsPermitted() {
        let source = `
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    try {
        try {
            return len
        } finally {
            Console.WriteLine("inner")
        }
    } finally {
        await Task.Yield()
    }
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    // Negative control #1: the fix must not make the analysis blind to a
    // genuinely unsafe interior await — `s` is still read in `finally`
    // *after* an `await` that could resume with an exception in flight, so
    // this must keep reporting GS0219 exactly as the pre-existing
    // (non-try-return) unsafe-finally-interaction tests in
    // Issue2350AsyncRefStructLivenessTests do.
    @Fact
    func SpanLocal_ReturnInsideTryFinally_LiveAcrossAwaitInFinally_StillReports_GS0219() {
        let source = `
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    try {
        return 0
    } finally {
        await Task.Yield();
        Console.WriteLine(s.Length)
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    // Negative control #2: `s` is read after an `await` inside the try body
    // itself, ahead of the funneled return — still unsafe.
    @Fact
    func SpanLocal_ReturnInsideTryFinally_LiveAcrossAwaitBeforeReturn_StillReports_GS0219() {
        let source = `
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    try {
        await Task.Yield();
        return s.Length
    } finally {
        Console.WriteLine("cleanup")
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    // The exact shape reported against Oahu.Diagnostics.PipelineProbeCheck:
    // a Span[T] local dies before a try/finally whose try funnels a `return`
    // out through a resource-cleanup finally, with no await anywhere in the
    // function.
    @Fact
    func PipelineProbeCheck_ReturnInsideTryFinally_ExactOahuShape_IsPermitted() {
        let source = `
import System
import System.IO
import System.Threading.Tasks

async func PipelineProbeCheck(buffer []byte) Task[int32] {
    var span ReadOnlySpan[byte] = buffer
    var probeLength = span.Length
    var stream = MemoryStream()
    try {
        return probeLength
    } finally {
        stream.Dispose()
    }
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
