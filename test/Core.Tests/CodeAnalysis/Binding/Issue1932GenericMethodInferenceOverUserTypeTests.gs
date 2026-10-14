// <copyright file="Issue1932GenericMethodInferenceOverUserTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import Xunit

/// Issue #1932: generic-method type-argument inference must unify a
/// parameter over a USER-DEFINED generic type (a G# `struct`/`class`
/// -> (cref:StructSymbol), or `interface` ->
/// (cref:InterfaceSymbol)) against a constructed argument of that same
/// type, the same way it already does for imported CLR generics such as
/// `List[T]` (issue #313). Previously only the CLR-generic path was
/// handled in `Binder.InferTypeArguments`, so calling a generic function
/// with a user generic struct/class/interface argument required an explicit
/// type argument.
open class Issue1932GenericMethodInferenceOverUserTypeTests {
    @Fact
    func GenericStructArgument_InfersTypeArgument_NoExplicitTypeArgNeeded() {
        let source = `
struct Pair[T] {
    var First T
    var Second T
}

func Swap[T](p Pair[T]) Pair[T] {
    return Pair[T]{First: p.Second, Second: p.First}
}

var pair = Pair[string]{First: "a", Second: "b"}
var swapped = Swap(pair)
swapped.First + "," + swapped.Second
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("b,a", result.Value)
    }

    @Fact
    func GenericClassArgument_InfersTypeArgument() {
        let source = `
class Box[T] {
    var Value T
}

func Unwrap[T](b Box[T]) T {
    return b.Value
}

var box = Box[int32]{Value: 42}
Unwrap(box)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func GenericInterfaceParameter_InfersTypeArgument_FromImplementingArgument() {
        // A user struct implementing a user generic interface must also
        // unify: parameter `IHolder[T]` against an argument whose static type
        // implements `IHolder[string]` (not `IHolder[T]` itself).
        let source = `
interface IHolder[T] {
    func Get() T;
}

struct StringBox : IHolder[string] {
    var Value string
    func Get() string { return Value }
}

func Describe[T](h IHolder[T]) T {
    return h.Get()
}

Describe(StringBox{Value: "hi"})
`
        // #3222: the emitted oracle now materializes the implementing struct's
        // `box StringBox → IHolder<string>` conversion at the plain-call
        // argument site.
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hi", result.Value)
    }

    @Fact
    func ExplicitTypeArgument_StillWorks_ControlCase() {
        let source = `
struct Pair[T] {
    var First T
    var Second T
}

func Swap[T](p Pair[T]) Pair[T] {
    return Pair[T]{First: p.Second, Second: p.First}
}

var pair = Pair[string]{First: "a", Second: "b"}
var swapped = Swap[string](pair)
swapped.First
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("b", result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
