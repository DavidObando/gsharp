// <copyright file="ByRefPointerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit

/// ADR-0039: Tests for by-ref pointers — binder rules, lvalue classification, diagnostics.
open class ByRefPointerTests {
    @Fact
    func AddressOf_Variable_Binds_Successfully() {
        let source = `
var x = 42
var p = &x
`
        // #3215: emitted — the byref-typed top-level var stays a local slot.
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func AddressOf_Constant_Reports_GS9005() {
        let source = `
let x = 42
var p = &x
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9005")
    }

    @Fact
    func AddressOf_Literal_Reports_GS9001() {
        let source = `
var p = &42
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9001")
    }

    @Fact
    func AddressOf_BinaryExpression_Reports_GS9001() {
        let source = `
var x = 1
var y = 2
var p = &(x + y)
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9001")
    }

    @Fact
    func Dereference_NonPointer_Reports_Error() {
        let source = `
var x = 42
var y = *x
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Dereference_Pointer_Binds() {
        let source = `
var x = 42
var p = &x
var y = *p
y
`
        // #3215: emitted — dereference through the byref local round-trips.
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func IntTryParse_With_AddressOf_Binds() {
        let source = `
import System
var result = 0
var ok = Int32.TryParse("42", &result)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func IntTryParse_Without_AddressOf_Reports_GS9002() {
        let source = `
import System
var result = 0
var ok = Int32.TryParse("42", result)
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9002")
    }

    @Fact
    func Multiply_Still_Works_As_Binary() {
        let source = `
var a = 3
var b = 4
var c = a * b
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func BitwiseAnd_Still_Works_As_Binary() {
        let source = `
var a = 7
var b = 3
var c = a & b
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func PointerType_In_Variable_Annotation_Parses() {
        // Parser test: *int as a type annotation should parse without errors.
        let source = `
var x = 42
var p *int32 = &x
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func AddressOf_In_Call_Argument_Position() {
        let source = `
import System
var result = 0
var ok = Int32.TryParse("123", &result)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func AddressOf_After_Equals_Sign() {
        let source = `
var x = 10
var p = &x
`
        // #3215: emitted — same shape as AddressOf_Variable_Binds_Successfully.
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func AddressOf_In_Binary_LHS() {
        // &x is a valid expression that produces a pointer — using it
        // in binary context should produce a type error (not a parse error).
        let source = `
var x = 10
var y = &x + 1
`
        let result = Evaluate(source)
        // Should produce an error (can't add pointer + int), not a parse crash.
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
