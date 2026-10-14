// <copyright file="GenericFunctionTests.cs" company="GSharp">
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

/// Emitted-oracle coverage for generic function.
/// Traceability: ADR-0020.
open class GenericFunctionTests {
    @Fact
    func GenericIdentity_InferredFromIntArgument_ReturnsInt() {
        let source = `
func Identity[T any](x T) T { return x }
Identity(5)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func GenericIdentity_ExplicitTypeArgument_ReturnsString() {
        let source = `
func Identity[T any](x T) T { return x }
Identity[string]("hi")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hi", result.Value)
    }

    @Fact
    func GenericTwoParameters_Inferred_FirstWins() {
        let source = `
func First[T any, U any](a T, b U) T { return a }
First(10, "ignored")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func GenericExplicitArgs_Wrong_Arity_Diagnoses() {
        let source = `
func Identity[T any](x T) T { return x }
Identity[int32, string](5)
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func GenericNoArgs_CannotInfer_Diagnoses() {
        let source = `
func Make[T any]() T { return Make[T]() }
Make()
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func TypeParameter_ShadowsBuiltinName_DoesNotConflict() {
        // `T` is freshly introduced and must not be confused with `int`/`string`.
        let source = `
func Echo[T any](x T) T { return x }
Echo("abc")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("abc", result.Value)
    }

    @Fact
    func GenericComparable_EqualsOperator_OnInt_Works() {
        let source = `
func Eq[T comparable](a T, b T) bool { return a == b }
Eq(3, 3)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func GenericComparable_NotEqualsOperator_OnString_Works() {
        let source = `
func Neq[T comparable](a T, b T) bool { return a != b }
Neq("hi", "bye")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func GenericAny_EqualsOperator_RejectedByBinder() {
        let source = `
func Eq[T any](a T, b T) bool { return a == b }
Eq(3, 3)
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func GenericComparable_NonComparableTypeArg_Diagnoses() {
        // Slices are not comparable.
        let source = `
func Eq[T comparable](a T, b T) bool { return a == b }
Eq[[]int32]([]int32{1}, []int32{1})
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func GenericComparable_InferredNonComparableTypeArg_Diagnoses() {
        let source = `
func Eq[T comparable](a T, b T) bool { return a == b }
Eq([]int32{1}, []int32{2})
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func GenericInterfaceConstraint_Dispatch_OnImplementor_Works() {
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
    func GenericInterfaceConstraint_NonImplementor_Diagnoses() {
        let source = `
sealed interface IShape {
    func Area() int32;
}

class NotAShape {}

func AreaOf[T IShape](x T) int32 { return x.Area() }
AreaOf[NotAShape](NotAShape{})
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func GenericConstraint_OnNonSealedInterface_IsAllowed() {
        // Issue #1052: a non-sealed user-declared interface is now a legal
        // generic constraint (matching imported CLR interfaces and C#'s
        // `where T : IFoo`). Instance members of the constraint bind on `T`.
        let source = `
interface IShape {
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
    func GenericConstraint_NonInterfaceType_Diagnoses() {
        // Issue #1056: a base CLASS is now a legal constraint, but a value type
        // (a non-class struct) is still rejected with GS0153 (repurposed
        // message) — C# forbids `where T : SomeStruct`.
        let source = `
struct Val { var X int32 }

func F[T Val](x T) int32 { return 0 }
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0153")
    }

    @Fact
    func GenericConstraint_BaseClassType_Binds() {
        // Issue #1056: a base class is a legal constraint (mirrors C#'s
        // `where T : BaseClass`); the former GS0153 rejection is removed.
        let source = `
class Base {}

func F[T Base](x T) int32 { return 0 }
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0153")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
