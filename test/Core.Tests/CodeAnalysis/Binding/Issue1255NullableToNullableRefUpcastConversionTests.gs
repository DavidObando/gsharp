// <copyright file="Issue1255NullableToNullableRefUpcastConversionTests.cs" company="GSharp">
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

/// Issue #1255: a nullable value of type `T?` must be implicitly convertible
/// to `U?` when `U` is a base class or implemented interface of `T`
/// — the lifted reference upcast maps null to null and reference-upcasts a
/// non-null value (representation-preserving). Previously `Conversion.Classify`
/// only lifted the non-null source case (`T → U?`, issue #1121) and rejected
/// `T? → U?` with `GS0155` (`GS0154` in argument position).
///
/// These tests assert the positive base-class and interface cases in both
/// argument and let-target positions, that the narrowing `T? → U`
/// (non-nullable target) still errors, that the #1121 `T → U?` control still
/// binds, and that an unrelated `T? → U?` still fails.
open class Issue1255NullableToNullableRefUpcastConversionTests {
    @Fact
    func NullableDerived_To_NullableBase_AsArgument_Binds() {
        let source = `
open class Base {}
class Derived : Base {}

func TakeBase(p Base?) {}

func F(x Derived?) { TakeBase(x) }
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NullableConcrete_To_NullableInterface_AsArgument_Binds() {
        let source = `
interface IBox {}
class AppleListBox : IBox {}

func Take(parent IBox?) {}

func F(x AppleListBox?) { Take(x) }
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NullableDerived_To_NullableBase_LetTarget_Binds() {
        let source = `
open class Base {}
class Derived : Base {}

func F(x Derived?) {
    let b Base? = x
}
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NullableConcrete_To_NullableInterface_LetTarget_Binds() {
        let source = `
interface IBox {}
class AppleListBox : IBox {}

func F(x AppleListBox?) {
    let b IBox? = x
}
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NullableConcrete_To_NullableTransitiveBaseInterface_Binds() {
        let source = `
interface IBase {}
interface IDerived : IBase {}
class Impl : IDerived {}

func TakeBase(p IBase?) {}

func F(x Impl?) { TakeBase(x) }
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NullableDerived_To_NonNullableBase_StillReportsGS0155() {
        let source = `
open class Base {}
class Derived : Base {}

func TakeBase(p Base) {}

func F(x Derived?) { TakeBase(x) }
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert") || d.Message.Contains("requires a value of type")
        )
    }

    @Fact
    func NonNullableDerived_To_NullableBase_StillBinds_Control() {
        let source = `
open class Base {}
class Derived : Base {}

func TakeBase(p Base?) {}

TakeBase(Derived{})
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func UnrelatedNullable_To_NullableInterface_StillReportsGS0155() {
        let source = `
interface IBox {}
class Unrelated {}

func F(x Unrelated?) {
    let b IBox? = x
}
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot convert"))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
