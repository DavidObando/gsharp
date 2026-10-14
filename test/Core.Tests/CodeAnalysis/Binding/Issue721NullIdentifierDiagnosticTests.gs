// <copyright file="Issue721NullIdentifierDiagnosticTests.cs" company="GSharp">
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
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #721 / ADR-0081 — when the user writes the C# spelling
/// `null` in a value-expression position and no symbol named
/// `null` exists in scope, the binder emits the friendly
/// GS0273 "did you mean 'nil'?" diagnostic and recovers by
/// synthesising a `nil` literal so target-type contexts
/// continue to typecheck.
open class Issue721NullIdentifierDiagnosticTests {
    @Fact
    func Let_NullableString_AssignedNull_ReportsGS0273() {
        let diags = Bind("let x string? = null")
        let diag = Assert.Single(diags.Where((d Diagnostic) -> d.Id == "GS0273"))
        Assert.Contains("'null'", diag.Message)
        Assert.Contains("'nil'", diag.Message)
        Assert.Contains("Did you mean", diag.Message)
        // The diagnostic is anchored at the 'null' token.
        Assert.Equal("null", diag.Location.Text!!.ToString(diag.Location.Span))
        // No cascading "cannot convert" or "name not found" diagnostic
        // should fire — the recovery synthesises a nil literal that
        // typechecks cleanly against `string?`.
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.Id == "GS0125")
    }

    @Fact
    func Call_With_NullableParameter_AssignedNull_ReportsGS0273() {
        let diags = Bind(`func Foo(s string?) {
}

Foo(null)`)
        let diag = Assert.Single(diags.Where((d Diagnostic) -> d.Id == "GS0273"))
        Assert.Contains("'nil'", diag.Message)
        Assert.Equal("null", diag.Location.Text!!.ToString(diag.Location.Span))
        // Recovery converts nil → string? cleanly: no other diagnostic.
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(diags.Where((d Diagnostic) -> d.IsError && d.Id != "GS0273"))
    }

    @Fact
    func Equality_Against_Null_ReportsGS0273() {
        let diags = Bind("let x string? = nil\nlet same = x == null")
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0273")
        // Equality `x == nil` is well-formed for `string?` once the
        // recovery treats `null` as `nil`. The same comparison must
        // not produce a residual operator-mismatch diagnostic.
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.IsError && d.Id != "GS0273")
    }

    @Fact
    func Existing_Local_Named_Null_Resolves_Without_Diagnostic() {
        // A locally-declared `let null = "hi"` shadows the would-be
        // diagnostic. Subsequent uses of `null` resolve to the local
        // and GS0273 must not fire.
        let diags = Bind("let null = \"hi\"\nlet s = null")
        Assert.Empty(diags.Where((d Diagnostic) -> d.IsError))
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.Id == "GS0273")
    }

    @Fact
    func Existing_Function_Named_Null_Resolves_Without_Diagnostic() {
        // A free function named `null` is legal — `null` is not a
        // keyword. Calling it must not produce GS0273.
        let diags = Bind(`func null() int32 {
    return 42
}

let v = null()`)
        Assert.Empty(diags.Where((d Diagnostic) -> d.IsError))
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.Id == "GS0273")
    }

    @Fact
    func Let_Without_Target_Type_Reports_GS0273_With_Recovery() {
        // No target type is available for `let x = null`; the binder
        // still reports GS0273 (the user clearly intended nil), and
        // recovers by synthesising a nil literal so downstream
        // diagnostics about nil-typed bindings are not stacked
        // on top of a cascading "name not found" diagnostic.
        let diags = Bind("let x = null")
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0273")
        // The legacy GS0125 path is no longer reached for `null`.
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.Id == "GS0125")
    }

    @Fact
    func Null_Inside_Lambda_Body_Reports_GS0273_And_Typechecks() {
        // Inside a lambda body, the same BindNameExpression path
        // applies — GS0273 fires for the inner `null` and the
        // synthesised nil flows into the local `string?` target
        // slot, which typechecks without cascading errors.
        let diags = Bind(`let f = () -> {
    let v string? = null
    return v
}
let _ = f()`)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0273")
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.IsError && d.Id != "GS0273")
    }

    @Fact
    func NullableInt_AssignedNull_ReportsGS0273() {
        // Nullable value-type target (`int32?` is a CLR Nullable<int>).
        let diags = Bind("let n int32? = null")
        let diag = Assert.Single(diags.Where((d Diagnostic) -> d.Id == "GS0273"))
        Assert.Equal("null", diag.Location.Text!!.ToString(diag.Location.Span))
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.Id == "GS0125")
    }

    @Fact
    func Existing_Nil_Program_Still_Compiles_And_Runs() {
        // Sanity guard: the changes for #721 must not regress the
        // canonical `nil` spelling.
        let result = Evaluate("let x string? = nil\nif x == nil { 1 } else { 0 }")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            return EmittedOracle.Evaluate(source).Diagnostics
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
