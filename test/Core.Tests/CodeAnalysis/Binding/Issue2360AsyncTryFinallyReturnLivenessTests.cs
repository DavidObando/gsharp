// <copyright file="Issue2360AsyncTryFinallyReturnLivenessTests.cs" company="GSharp">
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
/// Issue #2360: an async function containing both a by-ref-like (<c>ref
/// struct</c>) local — legalized per-scope by issue #2350's
/// <see cref="GSharp.Core.CodeAnalysis.Binding.RefStructAsyncLivenessAnalyzer"/>
/// — and a <c>return</c> lexically inside a <c>try</c> whose statement has a
/// <c>finally</c> (or <c>catch</c>) crashed the compiler with GS9998
/// (<c>KeyNotFoundException: The given key 'Label1' was not present in the
/// dictionary</c>) instead of binding cleanly.
/// </summary>
/// <remarks>
/// Root cause: <see cref="GSharp.Core.CodeAnalysis.Lowering.Lowerer"/> rewrites
/// a <c>return</c> lexically inside a protected (try) region into a
/// store-to-temp + <c>goto</c> to a synthesized method-exit label placed
/// <em>after</em> the entire lowered try statement (see
/// <c>Lowerer.RewriteReturnStatement</c>/<c>WrapWithMethodExitEpilogue</c>).
/// <see cref="GSharp.Core.CodeAnalysis.Binding.RefStructAsyncLivenessAnalyzer"/>'s
/// <c>ProcessTryBackward</c> then builds a <see cref="GSharp.Core.CodeAnalysis.Binding.ControlFlowGraph"/>
/// scoped to just the try body's own statements (issue #1642's opaque-compound-
/// statement pattern, shared with <see cref="GSharp.Core.CodeAnalysis.Binding.RefKindDefiniteAssignmentAnalyzer"/>)
/// — but the synthesized <c>goto</c>'s target label lives outside that scoped
/// region, so the old, unguarded <c>blockFromLabel[gs.Label]</c> lookup in
/// <c>ControlFlowGraph.GraphBuilder.Build</c> threw. The fix makes that lookup
/// tolerant of an escaping label, routing it to the region's <c>end</c> block
/// exactly like a <c>return</c>/<c>throw</c> already does — the generalized,
/// case-agnostic invariant the fix relies on. These tests exercise that fix
/// purely at the binder level (fast, no emit); see
/// <c>Issue2360AsyncTryFinallyReturnEmitTests</c> for full compile+run coverage.
/// </remarks>
public class Issue2360AsyncTryFinallyReturnLivenessTests
{
    // The exact minimal repro from issue #2360: no await anywhere in the
    // function, so the by-ref-like local is trivially dead across every
    // suspension point (there are none) — this must bind cleanly with no
    // GS0219 and, crucially, must not throw GS9998 while doing so.
    [Fact]
    public void SpanLocal_ReturnInsideTryFinally_NoAwait_MinimalRepro_IsPermitted()
    {
        var source = @"
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
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    // A `finally` with no `catch` — the shape closest to a `using`
    // desugaring (see Issue2360AsyncTryFinallyReturnEmitTests for the actual
    // `using let` end-to-end coverage) but expressed directly as try/finally.
    [Fact]
    public void SpanLocal_ReturnInsideTryFinally_WithRealAwaitElsewhere_SpanDeadBeforeReturn_IsPermitted()
    {
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    await Task.Yield();
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    try {
        return len
    } finally {
        Console.WriteLine(""cleanup"")
    }
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    [Fact]
    public void SpanLocal_ReturnInsideTryCatchFinally_NoAwait_IsPermitted()
    {
        var source = @"
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
        Console.WriteLine(""cleanup"")
    }
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    // The escaping-goto shape can arise inside a `catch` clause's own body
    // just as easily as inside `try` — ProcessTryBackward re-analyzes catch
    // bodies through the same region-scoped AnalyzeRegion path.
    [Fact]
    public void SpanLocal_ReturnInsideCatchClause_NoAwait_IsPermitted()
    {
        var source = @"
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
        Console.WriteLine(""cleanup"")
    }
    return 0
}

func DoWork() {
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    [Fact]
    public void SpanLocal_MultipleReturnsInSeparateTryFinallyBlocks_IsPermitted()
    {
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32, flag bool) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    if flag {
        try {
            return len
        } finally {
            Console.WriteLine(""first"")
        }
    }

    try {
        return len + 1
    } finally {
        Console.WriteLine(""second"")
    }
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    [Fact]
    public void SpanLocal_NestedTryFinally_ReturnInInnermostTry_IsPermitted()
    {
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    try {
        try {
            return len
        } finally {
            Console.WriteLine(""inner"")
        }
    } finally {
        Console.WriteLine(""outer"")
    }
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    [Fact]
    public void SpanLocal_ReturnInsideNestedTryFinally_AwaitInOutermostFinally_IsPermitted()
    {
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    var len = s.Length
    try {
        try {
            return len
        } finally {
            Console.WriteLine(""inner"")
        }
    } finally {
        await Task.Yield()
    }
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    // Negative control #1: the fix must not make the analysis blind to a
    // genuinely unsafe interior await — `s` is still read in `finally`
    // *after* an `await` that could resume with an exception in flight, so
    // this must keep reporting GS0219 exactly as the pre-existing
    // (non-try-return) unsafe-finally-interaction tests in
    // Issue2350AsyncRefStructLivenessTests do.
    [Fact]
    public void SpanLocal_ReturnInsideTryFinally_LiveAcrossAwaitInFinally_StillReports_GS0219()
    {
        var source = @"
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
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    // Negative control #2: `s` is read after an `await` inside the try body
    // itself, ahead of the funneled return — still unsafe.
    [Fact]
    public void SpanLocal_ReturnInsideTryFinally_LiveAcrossAwaitBeforeReturn_StillReports_GS0219()
    {
        var source = @"
import System
import System.Threading.Tasks

async func f(arr []int32) Task[int32] {
    var s ReadOnlySpan[int32] = arr
    try {
        await Task.Yield();
        return s.Length
    } finally {
        Console.WriteLine(""cleanup"")
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0219");
    }

    // The exact shape reported against Oahu.Diagnostics.PipelineProbeCheck:
    // a Span[T] local dies before a try/finally whose try funnels a `return`
    // out through a resource-cleanup finally, with no await anywhere in the
    // function.
    [Fact]
    public void PipelineProbeCheck_ReturnInsideTryFinally_ExactOahuShape_IsPermitted()
    {
        var source = @"
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
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0219");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
