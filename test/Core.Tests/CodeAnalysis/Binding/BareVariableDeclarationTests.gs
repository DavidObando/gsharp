// <copyright file="BareVariableDeclarationTests.cs" company="GSharp">
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
import Xunit

/// Tests for `var` declarations that omit their initializer (e.g. `var x int32`).
/// Such declarations are valid when an explicit type clause is present and take
/// the type's default (zero) value. `let`/`const` remain initializer-required.
open class BareVariableDeclarationTests {
    @Fact
    func BareVarDeclaration_Int32_DefaultsToZero() {
        let source = `
var x int32
x
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func BareVarDeclaration_Bool_DefaultsToFalse() {
        let source = `
var b bool
b
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(false, result.Value)
    }

    @Fact
    func BareVarDeclaration_String_TopLevel_DefaultsToNil() {
        // ADR-0100 / issue #795: `default(T)` aligned the interpreter
        // with the IL emit path. Reference types (including `string`)
        // default to `nil` rather than the Go-style empty value. Both
        // bare `var s string` (which lowers to `BoundDefaultExpression`)
        // and explicit `default(string)` now produce the same value.
        //
        // Issue #3324 (ADR-0008): this pin is specifically for a TOP-LEVEL
        // `var s string` — a top-level declaration binds a
        // GlobalVariableSymbol (emitted as a static field), which keeps the
        // CLR-default `null` by the same already-settled contract as
        // class/struct fields (issue #1714 / PR #2788 /
        // Issue1714StringZeroValueEmitTests). A genuine function-local
        // `var s string` now zero-inits to `""` per ADR-0008's documented
        // Go-style string zero value — see the `EndToEnd_LocalString*` facts
        // in Issue1714StringZeroValueEmitTests for that (different,
        // local-only) contract.
        let source = `
var s string
s
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.Value)
    }

    @Fact
    func BareVarDeclaration_ThenAssignment_UsesAssignedValue() {
        let source = `
var x int32
x = 42
x
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func BareLetDeclaration_WithoutInitializer_ReportsDiagnostic() {
        let source = `
let x int32
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func BareConstDeclaration_WithoutInitializer_ReportsDiagnostic() {
        let source = `
const x int32
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func BareVarDeclaration_WithoutTypeClause_ReportsDiagnostic() {
        let source = `
var x
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
