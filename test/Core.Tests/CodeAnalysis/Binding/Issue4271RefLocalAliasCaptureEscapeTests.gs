// <copyright file="Issue4271RefLocalAliasCaptureEscapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #4271: a closure (lambda or non-generic local function) that
/// captures a `ref`/`var ref` LOCAL alias of its enclosing
/// function compiled successfully and silently lost the mutation instead of
/// being rejected — the same failure mode issue #4259 fixed for
/// `ref`/`out`/`in` PARAMETERS (GS9010), but left open for
/// this distinct capture kind (a plain `LocalVariableSymbol` with
/// `RefKind != RefKind.None`, not a `ParameterSymbol` —
/// (cref:Issue4259RefParameterCaptureEscapeTests)'s own
/// `RefLocalAlias_CapturedInClosure_DoesNotReport_GS9010` test documents
/// the gap directly).
///
/// Root cause: `CaptureBoxingRewriter.IsBoxable` refuses to hoist a
/// ref-alias local into a shared box (the managed pointer in its slot would
/// be corrupted by boxing), and nothing else substitutes a correct
/// live-reference capture strategy, so the capture silently falls back to a
/// plain by-value closure-field snapshot — exactly the same silent-mutation-
/// loss bug #4259 fixed for ref parameters, for a different capture kind.
///
/// Fix: reject the capture outright with the new GS9011, mirroring C#'s own
/// rejection of a ref local captured by a lambda (CS8175) — a closure may
/// outlive the storage the alias points at (an array element, a field, a
/// stack local), so there is no CLR mechanism to keep the managed pointer
/// valid in a heap-allocated closure, and (unlike an ordinary captured
/// local) it cannot be made safe by boxing it either.
///
/// This is distinct from issue #4222's per-suspension-point liveness check
/// (GS0258): #4222 governs a ref-alias local declared and consumed entirely
/// within one async/iterator suspension segment (never captured by a
/// closure at all); this issue is specifically about capture by a nested
/// closure, a different code path (`LambdaBinder`'s capture-legality
/// checks, not `RefStructAsyncLivenessAnalyzer`).
///
/// These tests bind (but do not lower/emit) source directly via
/// (cref:GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram), mirroring
/// (cref:Issue4259RefParameterCaptureEscapeTests).
open class Issue4271RefLocalAliasCaptureEscapeTests {
    @Fact
    func RefLocalAlias_MutatedInVarBoundLambda_Reports_GS9011() {
        // The issue's own repro, verbatim.
        let source = `package P
func Foo() {
    var arr = []int32{1}
    var ref alias = arr[0]
    var f = func() { alias = alias + 1 }
    f()
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9011")
    }

    @Fact
    func RefLocalAlias_ReadOnlyCapturedInClosure_Reports_GS9011() {
        // A read-only reference (no assignment through the capture) is
        // rejected too, mirroring the GS9010 ref-parameter treatment: even a
        // stale read is unsound once the closure outlives the aliased storage.
        let source = `package P
func Foo() {
    var arr = []int32{1}
    var ref alias = arr[0]
    var f = func() int32 { return alias }
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9011")
    }

    @Fact
    func LetRefAlias_CapturedInLetBoundLocalFunction_Reports_GS9011() {
        let source = `package P
func Foo() {
    var arr = []int32{1}
    let ref alias = arr[0]
    let Bad = func() int32 {
        return alias
    }
    Bad()
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9011")
    }

    @Fact
    func RefLocalAlias_CapturedInArrowLambda_Reports_GS9011() {
        // The `() -> { ... }` arrow spelling binds through BindLambdaExpression,
        // a different call site than the `let name = func ... {...}`
        // local-function spelling — confirm it is covered too.
        let source = `package P
func Foo() {
    var arr = []int32{1}
    var ref alias = arr[0]
    var f = () -> { alias = alias + 1
        return alias }
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9011")
    }

    @Fact
    func RefLocalAlias_CapturedInGenericLocalFunction_Reports_GS9011() {
        let source = `package P
func Foo[T](seed T) T {
    var arr = []int32{1}
    var ref alias = arr[0]
    let Bad[U] = func(a U) U {
        alias = alias + 1
        return a
    }
    return Bad(seed)
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9011")
    }

    @Fact
    func RefLocalAlias_DoesNotReport_GS9010() {
        // No cross-contamination: the ref-alias local capture reports its own
        // GS9011, not the ref-parameter GS9010.
        let source = `package P
func Foo() {
    var arr = []int32{1}
    var ref alias = arr[0]
    var f = func() { alias = alias + 1 }
}`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9010")
    }

    @Fact
    func RefParameter_CapturedInClosure_StillReports_GS9010_NotGS9011() {
        // No regression: issue #4259's own check (a ref/out/in PARAMETER
        // capture) still reports GS9010, unaffected by this fix.
        let source = `package P
func Foo(ref x int32) {
    let Bad = func(a int32) int32 {
        x = x + 1
        return a
    }
    Bad(1)
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9010")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9011")
    }

    @Fact
    func OrdinaryLocal_CapturedInClosure_IsLegal() {
        // No over-rejection: an ordinary (non-ref) captured local — the #523
        // write-through-via-box mechanism — must remain unaffected.
        let source = `package P
func Foo() {
    var total = 0
    var f = func() { total = total + 1 }
    f()
}`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9011")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func RefLocalAlias_NotCapturedOnlyUsedLocally_IsLegal() {
        // Direct, non-closure mutation through the alias in the enclosing
        // function body (never referenced by a nested closure) must remain
        // unaffected — this is the issue's own "control case" that correctly
        // prints 2.
        let source = `package P
func Foo() {
    var arr = []int32{1}
    var ref alias = arr[0]
    alias = alias + 1
}`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9011")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func RefAlias_ConfinedToOneAsyncSuspensionSegment_NotCapturedByClosure_IsLegal() {
        // Issue #4222's legitimate case: a ref-alias local declared and fully
        // consumed inside a single async function, never captured by a NESTED
        // closure — a different code path (RefStructAsyncLivenessAnalyzer /
        // GS0258) from this issue's LambdaBinder capture-legality check. Must
        // remain unaffected by the GS9011 check added here.
        let source = `import System.Threading.Tasks

async func Foo() int32 {
    var arr = []int32{1}
    var ref alias = arr[0]
    alias = 42
    var captured = alias
    await Task.Delay(1)
    return captured
}`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9011")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    shared {
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
