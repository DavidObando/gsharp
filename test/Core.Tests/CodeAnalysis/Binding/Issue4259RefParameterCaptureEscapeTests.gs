// <copyright file="Issue4259RefParameterCaptureEscapeTests.cs" company="GSharp">
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

/// Issue #4259: a closure (lambda or non-generic local function) that
/// captures a `ref`/`out`/`in` PARAMETER of its enclosing
/// function compiled successfully and silently lost the mutation instead of
/// being rejected — the capture would hoist a value snapshot of the
/// parameter into the closure's display class/struct, not a live reference
/// to the caller's argument, and the CLR has no mechanism to keep a managed
/// pointer alive past the enclosing call's return anyway. `LambdaBinder`
/// already rejected a `ref struct` capture (GS0219), a managed-pointer
/// capture (GS9004) and a `fixed`-pointer capture (GS9008); it now
/// rejects a by-ref PARAMETER capture the same way, with the new GS9010.
///
/// This is distinct from capturing a `ref`/`var ref` LOCAL alias
/// ((cref:RefLocalAliasingTests), (cref:Issue4222RefAliasSuspensionLivenessTests)):
/// a local alias is a plain `LocalVariableSymbol`, not a
/// `ParameterSymbol`, so it is unaffected by this check — the GS9010
/// branch matches only `ParameterSymbol` instances with
/// `RefKind.Ref`/`Out`/`In`.
///
/// These tests bind (but do not lower/emit) source directly via
/// (cref:GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram), mirroring
/// `Issue2329FixedPointerCaptureEscapeTests`.
open class Issue4259RefParameterCaptureEscapeTests {
    @Fact
    func RefParameter_MutatedInLetBoundLocalFunction_Reports_GS9010() {
        // The issue's own repro, verbatim.
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
    }

    @Fact
    func RefParameter_ReadOnlyCapturedInAnonymousLambda_Reports_GS9010() {
        // A read-only reference (no assignment through the capture) is
        // rejected too: even a stale read is unsound once the closure
        // outlives the caller's argument.
        let source = `package P
func Foo(ref x int32) {
    var f = func() int32 { return x }
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9010")
    }

    @Fact
    func OutParameter_CapturedInClosure_Reports_GS9010() {
        let source = `package P
func Foo(out x int32) {
    x = 0
    let Bad = func(a int32) int32 {
        x = x + 1
        return a
    }
    Bad(1)
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9010")
    }

    @Fact
    func InParameter_CapturedInClosure_Reports_GS9010() {
        let source = `package P
func Foo(in x int32) {
    let Bad = func(a int32) int32 { return x + a }
    Bad(1)
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9010")
    }

    @Fact
    func RefParameter_CapturedInArrowLambda_Reports_GS9010() {
        // The `(p) -> { ... }` arrow spelling binds through
        // BindLambdaExpression, a different call site than the `let name =
        // func ... {...}` local-function spelling — confirm it is covered.
        let source = `package P
func Foo(ref x int32) {
    var f = (a int32) -> { x = x + 1
        return a }
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9010")
    }

    @Fact
    func RefParameter_CapturedInGenericLocalFunction_Reports_GS9010() {
        // Issue #4259's own note: the same gap reproduces identically for a
        // generic local function (`let Name[T] = func ...`), not just an
        // ordinary closure.
        let source = `package P
func Foo[T](ref x int32, seed T) T {
    let Bad[U] = func(a U) U {
        x = x + 1
        return a
    }
    return Bad(seed)
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9010")
    }

    @Fact
    func OrdinaryByValueParameter_CapturedInClosure_IsLegal() {
        // No over-rejection: an ordinary (by-value) parameter capture must
        // remain unaffected.
        let source = `package P
func Foo(x int32) {
    var f = func() int32 { return x }
}`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9010")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func OrdinaryLocal_CapturedInClosure_IsLegal() {
        let source = `package P
func Foo() {
    var total = 0
    var f = func() { total = total + 1 }
    f()
}`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9010")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func RefParameter_NotCapturedOnlyUsedLocally_IsLegal() {
        // Using a ref parameter directly in the enclosing function body
        // (never referenced by a nested closure) must remain unaffected.
        let source = `package P
func Foo(ref x int32) {
    x = x + 1
}`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9010")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func RefLocalAlias_CapturedInClosure_DoesNotReport_GS9010() {
        // A `var ref` LOCAL alias is a distinct capture kind from a
        // ref/out/in PARAMETER (it is a plain LocalVariableSymbol, not a
        // ParameterSymbol) and must not trip the new GS9010 check, whatever
        // its own (separately handled) legality outcome is.
        let source = `package P
func Foo() {
    var arr = []int32{1}
    var ref alias = arr[0]
    var f = func() { alias = alias + 1 }
}`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9010")
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
