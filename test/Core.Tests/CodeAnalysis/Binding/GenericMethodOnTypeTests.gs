// <copyright file="GenericMethodOnTypeTests.cs" company="GSharp">
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

/// Issue #312 — generic methods declared as members of a user-defined type.
/// A `func` with its own `[T]` type-parameter list inside a
/// `class`/`shared` body must introduce its type parameters into the
/// binding scope of the member so that parameter types, return types, locals,
/// and the body can reference `T`, and so call sites resolve via inference
/// or explicit type arguments.
open class GenericMethodOnTypeTests {
    @Fact
    func GenericInstanceMethod_DeclarationBinds_NoDiagnostics() {
        // The repro from the issue: the method's `T` used to fail with GS0113.
        let source = `
class Box {
    func Wrap[T](item T) T { return item }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GenericInstanceMethod_InferredFromIntArgument_ReturnsInt() {
        let source = `
class Box {
    func Wrap[T](item T) T { return item }
}
var b = Box{}
b.Wrap(5)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func GenericInstanceMethod_InferredFromStringArgument_ReturnsString() {
        let source = `
class Box {
    func Wrap[T](item T) T { return item }
}
var b = Box{}
b.Wrap("hi")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hi", result.Value)
    }

    @Fact
    func GenericInstanceMethod_ExplicitTypeArgument_ReturnsInt() {
        let source = `
class Box {
    func Wrap[T](item T) T { return item }
}
var b = Box{}
b.Wrap[int32](7)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func GenericInstanceMethod_TypeParameterUsableInLocal() {
        let source = `
class Box {
    func Wrap[T](item T) T {
        var local T = item
        return local
    }
}
var b = Box{}
b.Wrap(11)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.Value)
    }

    @Fact
    func GenericInstanceMethod_TwoTypeParameters_FirstWins() {
        let source = `
class Box {
    func Pair[T, U](a T, b U) T { return a }
}
var b = Box{}
b.Pair(10, "ignored")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func GenericInstanceMethod_WrongExplicitArity_Diagnoses() {
        let source = `
class Box {
    func Wrap[T](item T) T { return item }
}
var b = Box{}
b.Wrap[int32, string](5)
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func GenericInstanceMethod_ComparableConstraint_NonComparableArg_Diagnoses() {
        let source = `
class Box {
    func Eq[T comparable](a T, b T) bool { return a == b }
}
var b = Box{}
b.Eq[[]int32]([]int32{1}, []int32{1})
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func GenericStaticMethod_InferredFromArgument_ReturnsInt() {
        let source = `
class Util {
    shared {
        func Identity[T](x T) T { return x }
    }
}
Util.Identity(3)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func GenericMethod_OnGenericClass_OwnTypeParameter_Binds() {
        let source = `
class Container[T] {
    var Value T
    func GetOr[U](other U) U { return other }
}
var c = Container[int32]{Value: 1}
c.GetOr("x")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("x", result.Value)
    }

    @Fact
    func GenericMethod_OnGenericClass_ClassTypeParameter_UsableInBody() {
        let source = `
class Container[T] {
    var Value T
    func Echo(x T) T { return x }
}
var c = Container[int32]{Value: 1}
c.Echo(9)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
