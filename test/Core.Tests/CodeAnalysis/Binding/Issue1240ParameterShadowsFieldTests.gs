// <copyright file="Issue1240ParameterShadowsFieldTests.cs" company="GSharp">
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

/// Issue #1240: a method/constructor parameter whose name collides with an
/// instance field (or property) must shadow that member for unqualified (bare)
/// references inside the body — matching C# semantics and the
/// `parameter > instance member > static member` precedence already
/// enforced for static members. The member remains reachable via `this.`.
///
/// Before the fix, the field's pseudo-variable was seeded into the method scope
/// first and `TryDeclareVariable` silently dropped the later parameter, so
/// the parameter was wrongly ignored — a latent correctness bug that also
/// surfaced as a spurious GS0129 when field and parameter types differed (e.g.
/// non-nullable field vs nullable parameter).
open class Issue1240ParameterShadowsFieldTests {
    @Fact
    func Constructor_NullableParam_ShadowsNonNullableField_NoDiagnostics() {
        // Faithful repro from the issue: the field is non-nullable []uint8 while
        // the parameter is nullable []?uint8. Bare `iv` must bind to the
        // PARAMETER, so `iv == nil` typechecks; binding to the field would emit
        // GS0129 ('==' not defined for '[]uint8' and 'nil').
        let source = `
package p
class C {
    private let iv []uint8
    init(iv []?uint8) {
        if iv == nil { throw System.ArgumentException("x") }
        this.iv = iv!!
    }
    func M(iv []?uint8) bool {
        return iv == nil
    }
}
`
        // Issue #3501: the throw-guard narrows the parameter, so the kept
        // `!!` now draws GS0536 (warning) — only errors gate this test.
        Assert.DoesNotContain(Bind(source), (d Diagnostic) -> d.IsError)
    }

    @Fact
    func Method_Param_ShadowsField_ParameterValueUsed() {
        // Same-type field and parameter so the body compiles either way; the
        // returned value proves the PARAMETER (7), not the field (100), is read.
        let source = `
class C {
    var iv int32
    init() {
        iv = 100
    }
    func M(iv int32) int32 {
        return iv
    }
}

var c = C()
var r = c.M(7)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(7, result.Value)
    }

    @Fact
    func Method_QualifiedThisField_StillResolvesToField() {
        // `this.iv` is unaffected by parameter shadowing: it reads the field
        // (100) while bare `iv` reads the parameter (7) → 107.
        let source = `
class C {
    var iv int32
    init() {
        iv = 100
    }
    func M(iv int32) int32 {
        return this.iv + iv
    }
}

var c = C()
var r = c.M(7)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(107, result.Value)
    }

    @Fact
    func Constructor_Param_ShadowsField_AssignsFieldFromParameter() {
        // `this.iv = iv` writes the field from the parameter; a later read of
        // `this.iv` returns the stored field value (the parameter that was
        // passed in), proving the bare `iv` on the right-hand side was the
        // PARAMETER, not the (default-zero) field.
        let source = `
class C {
    var iv int32
    init(iv int32) {
        this.iv = iv
    }
    func Get() int32 {
        return this.iv
    }
}

var c = C(5)
var r = c.Get()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(5, result.Value)
    }

    @Fact
    func Method_Param_ShadowsProperty_ParameterValueUsed() {
        // Parameters must shadow instance properties too (not just fields).
        let source = `
class C {
    var _v int32
    prop Value int32 {
        get { return _v }
        set(x) { _v = x }
    }
    init() {
        _v = 100
    }
    func M(Value int32) int32 {
        return Value
    }
}

var c = C()
var r = c.M(42)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
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
