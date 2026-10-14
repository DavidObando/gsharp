// <copyright file="Issue4222RefAliasSuspensionLivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #4222: (cref:GSharp.Core.CodeAnalysis.Binding.RefStructAsyncLivenessAnalyzer)
/// replaces the blanket "no native ref alias anywhere in an async or iterator
/// function" rule (GS0258, unconditional) with the same per-local
/// await/yield-suspension liveness treatment issue #2350 gave by-ref-like
/// locals: a `let ref`/`var ref` alias is permitted in an async
/// function or an iterator as long as it is never live across an
/// `await`/`yield` suspension point.
open class Issue4222RefAliasSuspensionLivenessTests {
    @Fact
    func LetRef_ArrayElementAlias_ConsumedBeforeAwait_IsPermitted() {
        // The issue's own async repro: the alias leaves its lexical block
        // (and is fully consumed) before the await, so it never needs a
        // state-machine field.
        let source = `
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
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_ArrayElementAlias_LiveAcrossAwait_ReportsGS0258() {
        let source = `
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{10}
    var ref alias = values[0]
    await Task.Delay(1)
    alias = 42
    return values[0]
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_BaseCallAlias_LiveAcrossAwait_ReportsGS0258() {
        let source = `
import System.Threading.Tasks

open class Base {
    var values []int32 = []int32{10}
    open func At(index int32) ref int32 { return ref values[index] }
}

class Derived : Base {
    async func run() int32 {
        var ref alias = base.At(0)
        await Task.Delay(1)
        alias = 42
        return base.At(0)
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_AssignedThroughAliasAcrossAwait_ReportsGS0258() {
        // `alias = await X()` needs the alias's address AFTER the await
        // completes — the alias itself, not just a read of its pointee, is
        // what's live across the suspension.
        let source = `
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{10}
    var ref alias = values[0]
    alias = await Task.FromResult(42)
    return values[0]
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_AliasCreatedAfterAwait_ConsumedBeforeSecondAwait_IsPermitted() {
        let source = `
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{10}
    await Task.Delay(1)
    var ref alias = values[0]
    alias = 42
    await Task.Delay(1)
    return values[0]
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_LiveOnOneBranchAfterAwait_ReportsGS0258() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_PerIterationLoopReuse_DeadBeforeAwait_IsPermitted() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_UsedAfterLoopAwaitOnNextIteration_ReportsGS0258() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_ConsumedEntirelyWithinTry_NoAwaitInFinally_IsPermitted() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_AssignedBeforeAwaitInTry_ReadInFinally_ReportsGS0258() {
        // Unsafe finally interaction (mirroring Issue2350's by-ref-like
        // coverage): an exception right after the `await` transfers straight
        // to `finally`, where the alias is still read.
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_AssignedBeforeAwaitInTry_ReadInCatch_ReportsGS0258() {
        // Same "unsafe finally interaction" hazard as the finally test above,
        // but via a `catch` clause: an exception right after the `await` can
        // transfer straight into `catch`, where the alias is still read.
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_InNestedAsyncLambda_DeadBeforeOwnAwait_IsPermitted() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_InNestedAsyncLambda_LiveAcrossOwnAwait_ReportsGS0258() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func VarRef_FieldAlias_ConsumedBeforeYield_IsPermitted() {
        // The issue's own iterator repro, expressed with `var ref` (the
        // issue's `let ref`-style array-element repro is covered by
        // LetRef_IteratorArrayElementAlias_ConsumedBeforeYield_IsPermitted).
        let source = `
func gen() sequence[int32] {
    var values = []int32{10}
    {
        var ref alias = values[0]
        alias = 42
    }
    yield values[0]
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_IteratorArrayElementAlias_ConsumedBeforeYield_IsPermitted() {
        let source = `
func gen() sequence[int32] {
    var values = []int32{10}
    {
        let ref alias = values[0]
    }
    yield values[0]
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_IteratorAlias_LiveAcrossYield_ReportsGS0258() {
        let source = `
func gen() sequence[int32] {
    var values = []int32{10}
    var ref alias = values[0]
    yield 0
    alias = 42
    yield values[0]
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_IteratorAlias_UsedOnlyBetweenSuccessiveYields_IsPermitted() {
        let source = `
func gen() sequence[int32] {
    var values = []int32{10}
    yield 0
    var ref alias = values[0]
    alias = 42
    yield alias
    yield 0
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_AsyncIterator_ImplicitAsync_LiveAcrossYield_ReportsGS0258() {
        // An `IAsyncEnumerable[T]`-returning function is an implicit async
        // iterator (no `async` keyword required) — the liveness gate must
        // still catch it via Binder.IsIteratorReturnType, independent of
        // whether the binder also flips IsAsyncOrSuspending for this shape.
        let source = `
import System.Collections.Generic

func gen() IAsyncEnumerable[int32] {
    var values = []int32{10}
    var ref alias = values[0]
    yield 0
    alias = 42
    yield values[0]
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_AsyncIterator_ImplicitAsync_LiveAcrossAwait_ReportsGS0258() {
        let source = `
import System.Collections.Generic
import System.Threading.Tasks

func gen() IAsyncEnumerable[int32] {
    var values = []int32{10}
    var ref alias = values[0]
    await Task.Delay(1)
    alias = 42
    yield values[0]
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    // Negative control: the pre-existing blanket rejection of a by-ref-like
    // (`ref struct`) local in a plain (non-async) iterator is untouched by
    // this issue — #4222 is scoped to native ref-alias locals only.
    @Fact
    func SpanLocal_InPlainIterator_StillReports_GS0219() {
        let source = `
func gen(arr []int32) sequence[int32] {
    var s ReadOnlySpan[int32] = arr
    yield s.Length
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    // Negative control: a native ref alias at top level remains rejected
    // outright (no suspension-liveness question even applies there).
    @Fact
    func LetRef_AtTopLevel_StillReportsGS0258() {
        let source = `
var n int32 = 7
let ref m = n
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
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
    @Fact
    func LetRef_ReadAfterAwaitInSameBinaryExpression_ReportsGS0258() {
        let source = `
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{5}
    var ref alias = values[0]
    var total = 0
    total = await Task.FromResult(100) + alias
    return total
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_ReadAfterAwaitInVariableInitializer_ReportsGS0258() {
        let source = `
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{5}
    var ref alias = values[0]
    var total = await Task.FromResult(100) + alias
    return total
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_ReadBeforeAwaitInSameBinaryExpression_IsConservativelyRejected() {
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
        let source = `
import System.Threading.Tasks

async func run() int32 {
    var values = []int32{5}
    var ref alias = values[0]
    var total = 0
    total = alias + await Task.FromResult(100)
    return total
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        // Binds declarations and function bodies without executing them (an
        // iterator function with no caller has nothing to run).
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
