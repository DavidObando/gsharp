// <copyright file="Issue1182ValueTypeDefaultOptionalParameterTests.cs" company="GSharp">
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
import Xunit

/// Issue #1182 — a value-type `default(T)` (and the equivalent zero-value
/// `T()` form) is a valid compile-time constant and must be accepted as an
/// optional-parameter default, materializing the type's all-zero value when the
/// argument is omitted at a call site (matching C#). Previously rejected with
/// GS0265. Covers BCL value types (`TimeSpan`), primitives
/// (`default(int32)`), user `data struct`s, the existing accepted
/// controls (numeric literal, `nil`), and a type-mismatch rejection.
open class Issue1182ValueTypeDefaultOptionalParameterTests {
    @Fact
    func BclValueType_DefaultOf_AcceptedAsOptionalDefault() {
        let source = `
import System
class C { init(t TimeSpan = default(TimeSpan)) {} }
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func BclValueType_ZeroValueConstructorForm_AcceptedAsOptionalDefault() {
        let source = `
import System
class C { init(t TimeSpan = TimeSpan()) {} }
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Primitive_DefaultOf_AcceptedAsOptionalDefault() {
        let source = `
func F(x int32 = default(int32)) int32 { return x }
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func UserStruct_DefaultOf_AcceptedAsOptionalDefault() {
        let source = `
data struct Point { var X int32 var Y int32 }
func F(p Point = default(Point)) int32 { return p.X }
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Primitive_DefaultOf_OmittedAtCallSite_MaterializesZero() {
        let source = `
func F(x int32 = default(int32)) int32 { return x }
let r = F()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func UserStruct_DefaultOf_OmittedAtCallSite_MaterializesAllZero() {
        let source = `
data struct Point { var X int32 var Y int32 }
func F(p Point = default(Point)) int32 { return p.X + p.Y }
let r = F()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func Primitive_DefaultOf_SuppliedAtCallSite_OverridesDefault() {
        let source = `
func F(x int32 = default(int32)) int32 { return x }
let r = F(7)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func TypeMismatchedValueTypeDefault_DiagnosesGS0265() {
        let source = `
import System
class C { init(t TimeSpan = default(int32)) {} }
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0265")
    }

    @Fact
    func NumericLiteralDefault_StillAccepted() {
        let source = `
func F(x int32 = 5) int32 { return x }
let r = F()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func NilDefault_StillAccepted() {
        let source = `
class C { init(s string? = nil) {} }
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NonConstantValueTypeExpressionDefault_StillDiagnosesGS0265() {
        // A real parameterless construction with side effects is not a constant.
        let source = `
func F(x int32 = 1 + 2) int32 { return x }
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0265")
    }

    shared {
        private func AssertHasDiagnosticId(diagnostics ImmutableArray[Diagnostic], id string) {
            Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == id)
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
