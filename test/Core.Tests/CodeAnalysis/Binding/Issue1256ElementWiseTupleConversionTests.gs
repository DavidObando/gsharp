// <copyright file="Issue1256ElementWiseTupleConversionTests.cs" company="GSharp">
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

/// Issue #1256: a tuple type `(T1, …, Tn)` must be implicitly convertible to
/// `(U1, …, Un)` when both are tuple types of the SAME arity and EACH element
/// `Ti → Ui` has an implicit conversion (identity, reference/interface upcast,
/// nullable-reference upcast, numeric widening, …). Previously
/// `Conversion.Classify` treated the tuple as a single nominal type requiring
/// exact element identity, so `(A, Derived) → (A, Base)` failed with
/// `GS0155` (`GS0154` in argument position).
///
/// These tests assert the positive base-class, interface, 3-element-mixed, and
/// nullable-reference element cases across argument, let-target, and return
/// positions; and that downcasts, no-conversion element pairs, and arity
/// mismatches still error exactly as C# requires.
open class Issue1256ElementWiseTupleConversionTests {
    @Fact
    func DerivedElement_To_BaseElement_AsArgument_Binds() {
        let source = `
class A {}
open class Base {}
class Derived : Base {}

func Take(t (A, Base)) {}

func F(a A, d Derived) { Take((a, d)) }
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func ConcreteElement_To_InterfaceElement_AsArgument_Binds() {
        let source = `
class A {}
interface IFace {}
class Concrete : IFace {}

func Take(t (A, IFace)) {}

func F(a A, c Concrete) { Take((a, c)) }
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func DerivedElement_To_BaseElement_LetTarget_Binds() {
        let source = `
open class Base {}
class Derived : Base {}

func F(d Derived) {
    let t (Base, int32) = (d, 1)
}
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func DerivedElement_To_BaseElement_ReturnPosition_Binds() {
        let source = `
class A {}
open class Base {}
class Derived : Base {}

func Make(a A, d Derived) (A, Base) {
    return (a, d)
}
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func ThreeElementMixed_IdentityUpcastAndWidening_Binds() {
        let source = `
class A {}
open class Base {}
class Derived : Base {}

func Take(t (A, Base, int64)) {}

func F(a A, d Derived, n int32) { Take((a, d, n)) }
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NullableDerivedElement_To_NullableBaseElement_Binds() {
        let source = `
class A {}
open class Base {}
class Derived : Base {}

func Take(t (A, Base?)) {}

func F(a A, d Derived?) { Take((a, d)) }
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func IdenticalElementTypes_AsArgument_StillBinds_Control() {
        let source = `
func Take(t ([]int32, int32)) {}

func F(arr []int32) { Take((arr, 3)) }
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func BaseElement_To_DerivedElement_Downcast_StillReportsError() {
        let source = `
class A {}
open class Base {}
class Derived : Base {}

func Take(t (A, Derived)) {}

func F(a A, b Base) { Take((a, b)) }
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert") || d.Message.Contains("requires a value of type")
        )
    }

    @Fact
    func NoElementConversion_IntToString_StillReportsError() {
        let source = `
class A {}

func Take(t (A, string)) {}

func F(a A, n int32) { Take((a, n)) }
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert") || d.Message.Contains("requires a value of type")
        )
    }

    @Fact
    func ArityMismatch_StillReportsError() {
        let source = `
class A {}
open class Base {}
class Derived : Base {}

func Take(t (A, Base)) {}

func F(a A, d Derived) { Take((a, d, a)) }
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert") || d.Message.Contains("requires a value of type")
        )
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
