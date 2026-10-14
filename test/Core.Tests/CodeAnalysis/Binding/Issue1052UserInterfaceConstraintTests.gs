// <copyright file="Issue1052UserInterfaceConstraintTests.cs" company="GSharp">
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

/// Issue #1052: a USER-declared interface may be used as a generic
/// type-parameter constraint whether or not it is declared `sealed`,
/// matching imported CLR interfaces and C#'s `where T : IFoo`. The former
/// `sealed`-only gate (Phase 4.2b / ADR-0020) is removed; a constraint
/// that is not an interface is still rejected (GS0153), and a type argument
/// that does not implement the constraint is still rejected (GS0152).
open class Issue1052UserInterfaceConstraintTests {
    @Fact
    func NonSealedUserInterface_AsConstraint_Binds_NoDiagnostics() {
        let source = `
interface IShape {
    func Area() float64;
}

struct Sq : IShape {
    var S float64
    func Area() float64 { return S * S }
}

func Describe[T IShape](x T) float64 { return x.Area() }
Describe(Sq{S: 3.0})
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9.0, result.Value)
    }

    @Fact
    func NonSealedUserInterface_MemberDispatchOnT_Binds() {
        // Instance members of the constraint interface must bind on values of T.
        let source = `
interface IGreeter {
    func Greet() string;
}

struct En : IGreeter {
    func Greet() string { return "hi" }
}

func Run[T IGreeter](x T) string { return x.Greet() }
Run(En{})
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hi", result.Value)
    }

    @Fact
    func NonImplementingTypeArgument_StillReportsGS0152() {
        let source = `
interface IShape {
    func Area() float64;
}

struct NotAShape { var X int32 }

func Describe[T IShape](x T) float64 { return 0.0 }
Describe[NotAShape](NotAShape{X: 1})
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0152")
    }

    @Fact
    func NonInterfaceValueTypeConstraint_ReportsGS0153() {
        // Issue #1056: a base CLASS is now a legal constraint, but a value type
        // (a non-class struct) is still rejected — C# forbids
        // `where T : SomeStruct`.
        let source = `
struct Val { var X int32 }

func F[T Val](x T) int32 { return 0 }
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0153")
    }

    @Fact
    func BaseClassConstraint_NoLongerReportsGS0153() {
        // Issue #1056: a base class is now a legal constraint (was GS0153).
        let source = `
class Base {}

func F[T Base](x T) int32 { return 0 }
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0153")
    }

    @Fact
    func SealedUserInterface_AsConstraint_StillBinds() {
        // Control: the previously-allowed sealed form is not regressed.
        let source = `
sealed interface IShape {
    func Area() int32;
}

struct Sq : IShape {
    var S int32
    func Area() int32 { return S * S }
}

func Describe[T IShape](x T) int32 { return x.Area() }
Describe(Sq{S: 4})
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(16, result.Value)
    }

    @Fact
    func SelfReferentialUserGenericInterface_AsConstraint_Binds() {
        // Issue #1052: the `[T IFace[T]]` shape over a user-declared generic
        // interface binds and validates constraint satisfaction by
        // self-substitution.
        let source = `
interface ICmp[T] {
    func CompareTo(other T) int32;
}

struct Num : ICmp[Num] {
    var V int32
    func CompareTo(other Num) int32 { return V - other.V }
}

func Bigger[T ICmp[T]](a T, b T) int32 { return a.CompareTo(b) }
Bigger(Num{V: 7}, Num{V: 3})
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
