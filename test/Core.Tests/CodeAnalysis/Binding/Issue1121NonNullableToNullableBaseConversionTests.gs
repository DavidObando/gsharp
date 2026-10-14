// <copyright file="Issue1121NonNullableToNullableBaseConversionTests.cs" company="GSharp">
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

/// Issue #1121: a non-nullable value of type `T` must be implicitly
/// convertible to `U?` when `U` is a base class or implemented
/// interface of `T` — the conversion combines a reference upcast with
/// nullable wrapping. Previously `Conversion.Classify` only accepted a
/// nullable target whose underlying type was identical to the source, so the
/// `T → U?` combination was rejected with `GS0155`.
///
/// These tests assert the positive base-class and interface cases (argument
/// passing, assignment, return, and transitive base interface), that the
/// pre-existing `T → T?` and plain `T → U` upcasts still bind, and
/// that an unrelated type to `U?` still fails with `GS0155`.
open class Issue1121NonNullableToNullableBaseConversionTests {
    @Fact
    func NonNullableClass_To_NullableInterface_AsArgument_Binds() {
        let source = `
interface IBox {}
class StsdBox : IBox {}

func TakeIface(p IBox?) {}

TakeIface(StsdBox{})
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NonNullableDerived_To_NullableBase_AsArgument_Binds() {
        let source = `
open class Base {}
class Derived : Base {}

func TakeBase(p Base?) {}

TakeBase(Derived{})
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NonNullableDerived_To_NullableBase_Assignment_Binds() {
        let source = `
open class Base {}
class Derived : Base {}

var b Base? = Derived{}
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NonNullableDerived_To_NullableBase_Return_Binds() {
        let source = `
open class Base {}
class Derived : Base {}

func Make() Base? {
    return Derived{}
}

Make()
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NonNullableClass_To_NullableTransitiveBaseInterface_Binds() {
        let source = `
interface IBase {}
interface IDerived : IBase {}
class Impl : IDerived {}

func TakeBase(p IBase?) {}

TakeBase(Impl{})
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NonNullable_To_SameNullable_StillBinds() {
        let source = `
class StsdBox {}

func Take(p StsdBox?) {}

Take(StsdBox{})
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NonNullableDerived_To_NonNullableBase_StillBinds() {
        let source = `
open class Base {}
class Derived : Base {}

func Take(p Base) {}

Take(Derived{})
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func Unrelated_To_NullableInterface_StillReportsGS0155() {
        let source = `
interface IBox {}
class Unrelated {}

var b IBox? = Unrelated{}
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot convert type"))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
