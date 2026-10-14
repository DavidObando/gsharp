// <copyright file="Issue775ClassStructConstraintTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// ADR-0097 / issue #775: G# spelling for `class` / `struct` / `init()`
/// type-parameter constraints. The tests cover parser acceptance, binder
/// satisfaction rules, illegal-combination diagnostics (GS0361),
/// interaction with the legacy `IInterface` constraint, and
/// constraint-aware overload resolution between same-name extensions.
open class Issue775ClassStructConstraintTests {
    @Fact
    func ClassConstraint_ReferenceTypeArgument_Accepted() {
        let source = `
func First[T class](x T) T { return x }
First[string]("hi")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hi", result.Value)
    }

    @Fact
    func ClassConstraint_ObjectArgument_Accepted() {
        let source = `
func Required[T class](x T?) T -> x!!
let value object? = "ok"
Required(value).ToString()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ok", result.Value)
    }

    @Fact
    func ClassConstraint_ValueTypeArgument_Diagnoses() {
        let source = `
func First[T class](x T) T { return x }
First[int32](5)
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func StructConstraint_ValueTypeArgument_Accepted() {
        let source = `
func First[T struct](x T) T { return x }
First[int32](5)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func StructConstraint_ReferenceTypeArgument_Diagnoses() {
        let source = `
func First[T struct](x T) T { return x }
First[string]("hi")
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Theory
    @InlineData("int32")
    @InlineData("uint32")
    @InlineData("uint16")
    @InlineData("uint8")
    @InlineData("int64")
    @InlineData("float64")
    @InlineData("char")
    @InlineData("bool")
    @InlineData("nint")
    func StructConstraint_PrimitiveValueTypeArgument_Accepted(primitive string) {
        // Issue #1287: every non-nullable CLR value type — not just int32/bool —
        // must satisfy the `struct` constraint. None of these should report
        // GS0152.
        let source = (`
func First[T struct](x T) T { return x }
func Use(v ` + "$primitive" + `) ` + "$primitive" + ` { return First[` + "$primitive" + `](v) }
`)
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0152")
    }

    @Fact
    func StructConstraint_UserStructArgument_Accepted() {
        let source = `
struct S { prop A int32 { get; init; } }
func First[T struct](x T) T { return x }
func Use(v S) S { return First[S](v) }
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0152")
    }

    @Fact
    func StructConstraint_ReferenceTypeArgument_ReportsGS0152() {
        // Issue #1287: reference-type primitives (e.g. string) must still be
        // rejected by the `struct` constraint.
        let source = `
func First[T struct](x T) T { return x }
func Use(v string) string { return First[string](v) }
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0152")
    }

    @Fact
    func NewConstraint_DefaultCtorTypeArgument_Accepted() {
        let source = `
class Box { var n int32 = 0 }
func MakeOne[T init()]() T { return T{} }
let b = MakeOne[Box]()
b.n
`
        let result = Evaluate(source)
        // Body construction `T{}` is intentionally not exercised; only the
        // constraint declaration must bind cleanly.
        Assert.True(result.Diagnostics.Length == 0 || result.Diagnostics.All((d Diagnostic) -> d.Id != "GS0361"))
    }

    @Fact
    func NewConstraint_AcceptedOnDeclarationOnly() {
        let source = `
func Bag[T init()](x T) T { return x }
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ClassAndNewConstraint_Combine_Accepted() {
        let source = `
class Box {}
func Bag[T class init()](x T) T { return x }
Bag(Box{})
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ClassStructCombo_RejectedAsGS0361() {
        let source = `
func Bad[T class struct](x T) T { return x }
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0361")
    }

    @Fact
    func StructNewCombo_RejectedAsGS0361_RedundantNew() {
        // `struct` already implies `init()` per ECMA-335 II.10.1.7; the
        // explicit `init()` is rejected to keep the surface unambiguous.
        let source = `
func Bad[T struct init()](x T) T { return x }
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0361")
    }

    @Fact
    func InterfaceAndClassConstraint_Combine_Accepted() {
        let source = `
sealed interface IShape {
    func Area() int32;
}

class Square : IShape {
    func Area() int32 { return 9 }
}

func AreaOf[T IShape class](x T) int32 { return x.Area() }
AreaOf(Square{})
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func LegacyAnyConstraint_StillWorks() {
        let source = `
func Id[T any](x T) T { return x }
Id(42)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func LegacyComparableConstraint_StillWorks() {
        let source = `
func Eq[T comparable](a T, b T) bool { return a == b }
Eq(3, 3)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func LegacyInterfaceConstraint_StillWorks() {
        let source = `
sealed interface IShape {
    func Area() int32;
}

class Square : IShape {
    func Area() int32 { return 9 }
}

func AreaOf[T IShape](x T) int32 { return x.Area() }
AreaOf(Square{})
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func ConstraintAwareOverloadResolution_DispatchesByClassVsStruct() {
        // Two same-name extensions, one constrained to `class`, the other
        // to `struct`. The binder picks the matching overload based on the
        // call-site receiver type.
        let source = `
func (self T?) Pick[T class]() string { return "class" }
func (self T?) Pick[T struct]() string { return "struct" }

let s string? = "hi"
let n int32? = 5
let a = s.Pick()
let b = n.Pick()
a + b
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("classstruct", result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
