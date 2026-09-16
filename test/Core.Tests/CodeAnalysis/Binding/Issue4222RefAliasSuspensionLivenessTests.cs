// <copyright file="Issue4222RefAliasSuspensionLivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4222: <see cref="GSharp.Core.CodeAnalysis.Binding.RefStructAsyncLivenessAnalyzer"/>
/// replaces the blanket "no native ref alias anywhere in an async or iterator
/// function" rule (GS0258, unconditional) with the same per-local
/// await/yield-suspension liveness treatment issue #2350 gave by-ref-like
/// locals: a <c>let ref</c>/<c>var ref</c> alias is permitted in an async
/// function or an iterator as long as it is never live across an
/// <c>await</c>/<c>yield</c> suspension point.
/// </summary>
public class Issue4222RefAliasSuspensionLivenessTests
{
    [Fact]
    public void LetRef_ArrayElementAlias_ConsumedBeforeAwait_IsPermitted()
    {
        // The issue's own async repro: the alias leaves its lexical block
        // (and is fully consumed) before the await, so it never needs a
        // state-machine field.
        var source = @"
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{10}
    {
        var ref alias = values[0]
        alias = 42
    }
    await Task.Delay(1)
    return values[0]
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_ArrayElementAlias_LiveAcrossAwait_ReportsGS0258()
    {
        var source = @"
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{10}
    var ref alias = values[0]
    await Task.Delay(1)
    alias = 42
    return values[0]
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_AssignedThroughAliasAcrossAwait_ReportsGS0258()
    {
        // `alias = await X()` needs the alias's address AFTER the await
        // completes — the alias itself, not just a read of its pointee, is
        // what's live across the suspension.
        var source = @"
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{10}
    var ref alias = values[0]
    alias = await Task.FromResult(42)
    return values[0]
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_AliasCreatedAfterAwait_ConsumedBeforeSecondAwait_IsPermitted()
    {
        var source = @"
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{10}
    await Task.Delay(1)
    var ref alias = values[0]
    alias = 42
    await Task.Delay(1)
    return values[0]
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_LiveOnOneBranchAfterAwait_ReportsGS0258()
    {
        var source = @"
import System.Threading.Tasks

async func run(flag bool) int32 {
    var values = []int32{10}
    var ref alias = values[0]
    if flag {
        await Task.Delay(1)
        alias = 42
    }
    return values[0]
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_PerIterationLoopReuse_DeadBeforeAwait_IsPermitted()
    {
        var source = @"
import System.Threading.Tasks

async func run(count int32) int32 {
    var values = []int32{1, 2, 3}
    var total = 0
    for var i = 0; i < count; i++ {
        var ref alias = values[0]
        alias = alias + 1
        total = total + alias
        await Task.Delay(1)
    }
    return total
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_UsedAfterLoopAwaitOnNextIteration_ReportsGS0258()
    {
        var source = @"
import System.Threading.Tasks

async func run(count int32) int32 {
    var values = []int32{10}
    var ref alias = values[0]
    var total = 0
    for var i = 0; i < count; i++ {
        await Task.Delay(1)
        total = total + alias
    }
    return total
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_ConsumedEntirelyWithinTry_NoAwaitInFinally_IsPermitted()
    {
        var source = @"
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{10}
    var total = 0
    try {
        var ref alias = values[0]
        alias = 42
        total = alias
    } finally {
        await Task.Delay(1)
    }
    return total
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_AssignedBeforeAwaitInTry_ReadInFinally_ReportsGS0258()
    {
        // Unsafe finally interaction (mirroring Issue2350's by-ref-like
        // coverage): an exception right after the `await` transfers straight
        // to `finally`, where the alias is still read.
        var source = @"
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{10}
    var ref alias = values[0]
    var result = 0
    try {
        await Task.Delay(1)
        result = 1
    } finally {
        result = result + alias
    }
    return result
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_AssignedBeforeAwaitInTry_ReadInCatch_ReportsGS0258()
    {
        // Same "unsafe finally interaction" hazard as the finally test above,
        // but via a `catch` clause: an exception right after the `await` can
        // transfer straight into `catch`, where the alias is still read.
        var source = @"
import System
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{10}
    var ref alias = values[0]
    var result = 0
    try {
        await Task.Delay(1);
        result = 1
    } catch (e Exception) {
        result = alias
    }
    return result
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_InNestedAsyncLambda_DeadBeforeOwnAwait_IsPermitted()
    {
        var source = @"
import System.Threading.Tasks

func f() int32 {
    var g = async func() int32 {
        var values = []int32{10}
        var ref alias = values[0]
        alias = 42
        var captured = alias
        await Task.Delay(1)
        return captured
    }
    return g().Result
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_InNestedAsyncLambda_LiveAcrossOwnAwait_ReportsGS0258()
    {
        var source = @"
import System.Threading.Tasks

func f() int32 {
    var g = async func() int32 {
        var values = []int32{10}
        var ref alias = values[0]
        await Task.Delay(1)
        return alias
    }
    return g().Result
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void VarRef_FieldAlias_ConsumedBeforeYield_IsPermitted()
    {
        // The issue's own iterator repro, expressed with `var ref` (the
        // issue's `let ref`-style array-element repro is covered by
        // LetRef_IteratorArrayElementAlias_ConsumedBeforeYield_IsPermitted).
        var source = @"
func gen() sequence[int32] {
    var values = []int32{10}
    {
        var ref alias = values[0]
        alias = 42
    }
    yield values[0]
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_IteratorArrayElementAlias_ConsumedBeforeYield_IsPermitted()
    {
        var source = @"
func gen() sequence[int32] {
    var values = []int32{10}
    {
        let ref alias = values[0]
    }
    yield values[0]
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_IteratorAlias_LiveAcrossYield_ReportsGS0258()
    {
        var source = @"
func gen() sequence[int32] {
    var values = []int32{10}
    var ref alias = values[0]
    yield 0
    alias = 42
    yield values[0]
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_IteratorAlias_UsedOnlyBetweenSuccessiveYields_IsPermitted()
    {
        var source = @"
func gen() sequence[int32] {
    var values = []int32{10}
    yield 0
    var ref alias = values[0]
    alias = 42
    yield alias
    yield 0
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_AsyncIterator_ImplicitAsync_LiveAcrossYield_ReportsGS0258()
    {
        // An `IAsyncEnumerable[T]`-returning function is an implicit async
        // iterator (no `async` keyword required) — the liveness gate must
        // still catch it via Binder.IsIteratorReturnType, independent of
        // whether the binder also flips IsAsyncOrSuspending for this shape.
        var source = @"
import System.Collections.Generic

func gen() IAsyncEnumerable[int32] {
    var values = []int32{10}
    var ref alias = values[0]
    yield 0
    alias = 42
    yield values[0]
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_AsyncIterator_ImplicitAsync_LiveAcrossAwait_ReportsGS0258()
    {
        var source = @"
import System.Collections.Generic
import System.Threading.Tasks

func gen() IAsyncEnumerable[int32] {
    var values = []int32{10}
    var ref alias = values[0]
    await Task.Delay(1)
    alias = 42
    yield values[0]
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0258");
    }

    // Negative control: the pre-existing blanket rejection of a by-ref-like
    // (`ref struct`) local in a plain (non-async) iterator is untouched by
    // this issue — #4222 is scoped to native ref-alias locals only.
    [Fact]
    public void SpanLocal_InPlainIterator_StillReports_GS0219()
    {
        var source = @"
func gen(arr []int32) sequence[int32] {
    var s ReadOnlySpan[int32] = arr
    yield s.Length
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    // Negative control: a native ref alias at top level remains rejected
    // outright (no suspension-liveness question even applies there).
    [Fact]
    public void LetRef_AtTopLevel_StillReportsGS0258()
    {
        var source = @"
var n int32 = 7
let ref m = n
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0258");
    }

    // Regression: `ApplyExpression`/the BoundVariableDeclaration case used to
    // fold an expression's own interesting-variable reads into `live` AFTER
    // checking for an unsafe crossing, so a read positioned in evaluation
    // order strictly *after* a nested `await` in the SAME expression (as
    // opposed to being the `await`'s own assignment target, already handled)
    // was invisible to that check unless something *later* also needed the
    // value. Concretely, `total = await X() + alias` reads `alias` only once
    // the `await` has resumed — the alias itself, not just its pointee value,
    // must survive that suspension — but the old ordering let this compile
    // and, at runtime, deref a never-hoisted, reset-to-default alias slot
    // (verified against this exact shape: a NullReferenceException with a
    // genuinely suspending `await`, and a silently wrong `s.Length` read of 0
    // for the equivalent by-ref-like-local shape from issue #2350). The
    // analogous `var` case (an initializer combining the two) had the same
    // gap.
    [Fact]
    public void LetRef_ReadAfterAwaitInSameBinaryExpression_ReportsGS0258()
    {
        var source = @"
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{5}
    var ref alias = values[0]
    var total = 0
    total = await Task.FromResult(100) + alias
    return total
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_ReadAfterAwaitInVariableInitializer_ReportsGS0258()
    {
        var source = @"
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{5}
    var ref alias = values[0]
    var total = await Task.FromResult(100) + alias
    return total
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_ReadBeforeAwaitInSameBinaryExpression_IsConservativelyRejected()
    {
        // Mirror of the two tests above with the operands swapped: `alias` is
        // read strictly before the `await` in evaluation order (only its
        // already-dereferenced pointee value, an ordinary int, needs to
        // survive the suspension, so this shape is actually safe to run).
        // This analyzer has no cheap way to distinguish this from the unsafe
        // "after" shape above within one expression, though, so — mirroring
        // the self-referential-redefinition case's own documented stance
        // ("evaluation order does not change which value is live entering
        // the statement") — it conservatively rejects both alike rather than
        // risk missing the unsafe one. Split the `await` onto its own
        // statement first if this legitimately needs to compile.
        var source = @"
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{5}
    var ref alias = values[0]
    var total = 0
    total = alias + await Task.FromResult(100)
    return total
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0258");
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }

    // Binds declarations and function bodies without executing them (an
    // iterator function with no caller has nothing to run).
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
