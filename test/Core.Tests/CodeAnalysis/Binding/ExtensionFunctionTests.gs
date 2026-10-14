// <copyright file="ExtensionFunctionTests.cs" company="GSharp">
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

/// Phase 3.B.6 — extension functions per ADR-0019. Declared with a Go-style
/// receiver clause `func (recv RecvType) Name(args) ret { ... }`; called
/// as if they were instance methods on the receiver type.
open class ExtensionFunctionTests {
    @Fact
    func Extension_OnCrossPackageUserStruct_Binds_And_Dispatches() {
        let typeTree = `
package Geometry
public struct Point {
    var X int32
    var Y int32
}
`
        let extensionTree = `
package GeometryExtensions
func (p Point) SumXY() int32 {
    return p.X + p.Y
}

var p = Point{X: 3, Y: 4}
p.SumXY()
`
        let result = Evaluate(typeTree, extensionTree)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func Extension_OnClrString_Binds_And_Dispatches() {
        let source = `
import System

func (s string) Loud() string {
    return s + "!"
}

var greeting = "hi"
greeting.Loud()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hi!", result.Value)
    }

    @Fact
    func Extension_WithExtraArgs_BindsCorrectly() {
        let source = `
func (a int32) Plus(b int32) int32 {
    return a + b
}

var x = 10
x.Plus(5)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(15, result.Value)
    }

    @Fact
    func Extension_DistinctReceivers_SameName_AllowedAndDispatch() {
        let source = `
import System

func (i int32) Describe() string {
    return "int32"
}

func (s string) Describe() string {
    return "string"
}

var i = 1
i.Describe()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("int32", result.Value)
    }

    @Fact
    func Extension_DuplicateOnSameReceiver_Diagnoses() {
        let source = `
func (i int32) Foo() int32 { return 1 }
func (i int32) Foo() int32 { return 2 }
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Extension_DoesNotCollide_With_FreeFunction_OfSameName() {
        let source = `
func Foo() int32 { return 99 }
func (i int32) Foo() int32 { return i + 1 }

var n = 4
n.Foo()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func Extension_Generic_InfersTypeArgument_FromArgument() {
        let source = `
func (value int32) Echo[T](item T) T {
    return item
}

var n = 5
n.Echo(42)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func Extension_Generic_ExplicitTypeArgument_Binds() {
        let source = `
func (value int32) Echo[T](item T) T {
    return item
}

var n = 5
n.Echo[string]("hello")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hello", result.Value)
    }

    @Fact
    func Extension_Generic_MultipleTypeParameters_Bind() {
        let source = `
func (value int32) PickFirst[T, U](a T, b U) T {
    return a
}

var n = 5
n.PickFirst(99, "ignored")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(99, result.Value)
    }

    @Fact
    func Extension_Generic_WrongExplicitTypeArgumentCount_Diagnoses() {
        let source = `
func (value int32) Echo[T](item T) T {
    return item
}

var n = 5
n.Echo[int32, string](42)
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Extension_Overload_ByArity_ResolvesCorrectOverload() {
        let source = `
func (s string) Do(x int32) string {
    return "one"
}

func (s string) Do(x int32, y int32) string {
    return "two"
}

var a = "hi".Do(1)
var b = "hi".Do(1, 2)
a + b
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("onetwo", result.Value)
    }

    @Fact
    func Extension_Overload_ByParameterType_ResolvesCorrectOverload() {
        let source = `
func (s string) Tag(x int32) string {
    return "int"
}

func (s string) Tag(x string) string {
    return "str"
}

var a = "hi".Tag(1)
var b = "hi".Tag("x")
a + b
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("intstr", result.Value)
    }

    @Fact
    func Extension_Overload_GenericArityVariant_ResolvesCorrectOverload() {
        let source = `
func (s string) Pick(x int32) string {
    return "concrete"
}

func (s string) Pick[T](item T) string {
    return "generic"
}

var a = "hi".Pick(1)
var b = "hi".Pick[string]("x")
a + b
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("concretegeneric", result.Value)
    }

    @Fact
    func Extension_Overload_DifferentReceiverTypes_StayIndependent() {
        let source = `
func (s string) Kind(x int32) string {
    return "string-recv"
}

func (n int32) Kind(x int32) string {
    return "int-recv"
}

var a = "hi".Kind(1)
var b = (5).Kind(1)
a + b
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("string-recvint-recv", result.Value)
    }

    @Fact
    func Extension_Overload_SameReceiverDifferentSignatures_DeclareWithoutError() {
        let source = `
func (s string) Do(x int32) string {
    return s
}

func (s string) Do(x int32, y int32) string {
    return s
}

func (s string) Do[T](item T) string {
    return s
}

var a = "hi".Do(1)
a
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Extension_DuplicateSignature_ReportsError() {
        let source = `
func (s string) Do(x int32) string {
    return s
}

func (s string) Do(y int32) string {
    return s
}

var a = "hi".Do(1)
a
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Evaluate(sources ...string) EmittedOracleResult {
            return EmittedOracle.Evaluate(sources)
        }
    }
}
