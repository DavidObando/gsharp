// <copyright file="Issue1235TypeParameterClassMemberTests.cs" company="GSharp">
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

/// Issue #1235: a value whose static type is a type parameter constrained to a
/// (user) class or interface exposes that constraint's FULL instance member
/// surface — instance fields and properties, not only methods. Previously a
/// field/property read (`t.F` / `t.P`) on a constrained type
/// parameter reported GS0158 "Cannot find member" while method calls resolved
/// correctly.
open class Issue1235TypeParameterClassMemberTests {
    @Fact
    func ClassConstraint_PropertyRead_BindsAndReturnsValue() {
        let source = `
open class Base { prop P int32 { get; set; } }

func ReadP[T Base](t T) int32 { return t.P }
var b = Base()
b.P = 7
ReadP[Base](b)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func ClassConstraint_FieldRead_BindsAndReturnsValue() {
        let source = `
open class Base { var F2 int32 }

func ReadF[T Base](t T) int32 { return t.F2 }
var b = Base()
b.F2 = 13
ReadF[Base](b)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(13, result.Value)
    }

    @Fact
    func ClassConstraint_MethodCall_StillBinds() {
        let source = `
open class Base { func Hello() int32 { return 42 } }

func CallHello[T Base](t T) int32 { return t.Hello() }
CallHello[Base](Base())
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ClassConstraint_InheritedProperty_Binds() {
        let source = `
open class GrandBase { prop Inherited int32 { get; set; } }
open class Base : GrandBase { }

func ReadInherited[T Base](t T) int32 { return t.Inherited }
var b = Base()
b.Inherited = 100
ReadInherited[Base](b)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(100, result.Value)
    }

    @Fact
    func InterfaceConstraint_PropertyRead_Binds() {
        let source = `
interface IHasName { prop Name int32 { get; } }
open class Named : IHasName { prop Name int32 { get; set; } }

func ReadName[T IHasName](t T) int32 { return t.Name }
var n = Named()
n.Name = 55
ReadName[Named](n)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(55, result.Value)
    }

    @Fact
    func UnknownMemberOnTypeParameter_StillReportsGS0158() {
        let source = `
open class Base { var F2 int32 }

func Bad[T Base](t T) int32 { return t.Missing }
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
