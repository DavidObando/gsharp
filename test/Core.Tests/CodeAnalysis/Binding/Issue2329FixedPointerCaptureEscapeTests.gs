// <copyright file="Issue2329FixedPointerCaptureEscapeTests.cs" company="GSharp">
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

/// Issue #2329 (deferred audit item) / ADR-0125: a `fixed` statement's
/// unmanaged `*T` pointer variable (`PointerTypeSymbol`, distinct
/// from the ordinary `*T`/`&`/`ByRefTypeSymbol` "managed
/// pointer" already guarded by GS9004/GS9006 — see
/// `RefSafeEscapeTests`) was reachably captured by a nested closure with
/// no diagnostic at all: `LambdaBinder`'s capture-escape checks covered
/// by-ref-like (`ref struct`) and `ByRefTypeSymbol` locals, but not
/// `PointerTypeSymbol` locals. The capture then flowed unchecked into
/// `CaptureBoxingRewriter`, which has no allocation/seed path for a
/// `fixed` pointer variable (it, like a catch-clause variable, is
/// "declaration-less" — bound directly by `BoundFixedStatement`, not a
/// `BoundVariableDeclaration`) — crashing emit with
/// `GS9998: Variable has no local slot`.
///
/// Rather than implement an unsafe lowering that boxes a raw unmanaged
/// pointer past the lifetime of its pin (the pinned handle is released when
/// the enclosing `fixed` block exits, so any closure invoked after that
/// point — or, for a heap-escaping closure, at an arbitrary later time —
/// would dereference a pointer that is no longer guaranteed pinned/valid),
/// the fix rejects the escape during binding: `LambdaBinder` now
/// reports `GS9008` for any `PointerTypeSymbol` variable found in a
/// function-literal's captured-variable set, before lowering/emission ever
/// runs. This mirrors the existing GS9004 rejection for by-ref-like/managed
/// pointer captures, just for an additional variable kind.
///
/// These tests bind (but do not lower/emit) source directly via
/// (cref:GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram), the
/// same lightweight pattern `RefSafeEscapeTests` uses for GS9004/GS9006.
open class Issue2329FixedPointerCaptureEscapeTests {
    @Fact
    func FixedPointer_ReadCapturedInLambda_Reports_GS9008_NotGS9998() {
        // The reachable gap from the audit: a lambda declared inside a
        // `fixed` block reads the pinned pointer variable.
        let source = `package P
unsafe func run() {
    var buf = []uint8{uint8(1), uint8(2), uint8(3)}
    fixed pD *uint8 = buf {
        var f = func() uint8 { return pD[0] }
    }
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9008")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func FixedPointer_WriteCapturedInLambda_Reports_GS9008() {
        // Issue #567/#618-style write-only capture: the LHS of an assignment
        // is a use that must also be checked (mirrors the existing GS9004
        // by-ref write-capture coverage).
        let source = `package P
unsafe func run() {
    var buf = []uint8{uint8(1), uint8(2), uint8(3)}
    fixed pD *uint8 = buf {
        var f = func() { pD[0] = uint8(9) }
    }
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9008")
    }

    @Fact
    func FixedPointer_CapturedInLetBoundLambda_Reports_GS9008() {
        // The `let name = func() {...}` local-function-style spelling goes
        // through the same BindFunctionLiteral path as an anonymous lambda —
        // confirm it is covered too.
        let source = `package P
unsafe func run() {
    var buf = []uint8{uint8(1), uint8(2), uint8(3)}
    fixed pD *uint8 = buf {
        let log = func() uint8 { return pD[0] }
    }
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9008")
    }

    @Fact
    func FixedPointer_NonCapturingUsage_IsLegal() {
        // The overwhelmingly common case — using the pointer only inside the
        // `fixed` block itself, never inside a nested closure — must remain
        // unaffected.
        let source = `package P
unsafe func run() {
    var buf = []uint8{uint8(1), uint8(2), uint8(3)}
    fixed pD *uint8 = buf {
        pD[0] = uint8(9)
    }
}`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9008")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func FixedPointer_NestedInsideLambdaBody_NotCapturedOutward_IsLegal() {
        // The inverse (#1437-analogous) shape: the ENTIRE `fixed` statement —
        // pin, pointer variable, and all uses — is declared inside the lambda
        // body. The pointer variable is local to that body, not captured
        // from an enclosing scope, so no GS9008 applies.
        let source = `package P
unsafe func run() {
    var f = func() uint8 {
        var buf = []uint8{uint8(1), uint8(2), uint8(3)}
        fixed pD *uint8 = buf {
            return pD[0]
        }
    }
}`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9008")
    }

    @Fact
    func NonPointerLocal_CapturedInLambdaInsideFixedBlock_IsLegal() {
        // A lambda inside a `fixed` block that captures a different,
        // ordinary (non-pointer) outer local must still box normally — the
        // GS9008 rejection is specific to the pointer variable itself.
        let source = `package P
unsafe func run() {
    var buf = []uint8{uint8(1), uint8(2), uint8(3)}
    var total = 0
    fixed pD *uint8 = buf {
        pD[0] = uint8(9)
        var f = func() { total = total + 1 }
    }
}`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9008")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
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
