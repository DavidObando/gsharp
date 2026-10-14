// <copyright file="Issue3748SymbolicTupleBoxingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import Xunit

/// Issue #3748: a tuple always boxes implicitly to `object` /
/// `object?`. `TupleTypeSymbol.BuildClrType` deliberately leaves
/// `ClrType` null whenever an element requires symbolic projection — most
/// commonly a nullable-reference element such as `(A int32, B string?)` —
/// and the general CLR-backed boxing rule in `Conversion` requires a
/// non-null source `ClrType`, so those tuples were rejected with
/// `GS0155 Cannot convert type '(…)' to 'object?'` in every
/// `object`-typed position.
/// @remarks The reporting issue framed this as named-tuple-plus-lambda; it is neither.
/// Witness of discrimination: the same shape without the nullable element
/// (`(A int32, B string)`) boxed fine, an <em>unnamed</em> tuple with a
/// nullable element failed identically, and the lambda position was incidental.
/// The trigger is a null `ClrType` on the tuple, not its element names.
///
/// Issue #3907 is the UNBOXING direction of the same hole:
/// `cast[(A, B)](o)` was rejected as soon as one element was a
/// same-compilation type, because the value-type test in
/// `Conversion.IsValueTypeLikeFrom` also ended at a null
/// `ClrType`. Witness of discrimination:
/// `cast[(StringBuilder, string)]` — every element BCL-backed, so the
/// tuple reifies — bound and ran before the fix, and the user's own class as an
/// element is the only difference.
open class Issue3748SymbolicTupleBoxingTests {
    @Fact
    func NamedTupleWithNullableElement_BoxesToNullableObject() {
        let result = EmittedOracle.Evaluate(`
let t (A int32, B string?) = (1, "x")
let o object? = t
o!!.ToString()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("(1, x)", result.Value)
    }

    @Fact
    func UnnamedTupleWithNullableElement_BoxesToObject() {
        let result = EmittedOracle.Evaluate(`
let t (int32, string?) = (2, "y")
let o object = t
o.ToString()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("(2, y)", result.Value)
    }

    @Fact
    func NamedTupleWithNullableElement_BoxesInFuncReturnPosition() {
        let result = EmittedOracle.Evaluate(`
func Run(name string) (ExitCode int32, Stdout string?, Stderr string?) {
    return (ExitCode: 0, Stdout: name, Stderr: nil)
}

func Box() object? {
    return Run("x")
}

Box()!!.ToString()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("(0, x, )", result.Value)
    }

    @Fact
    func NamedTupleWithNullableElement_BoxesInLambdaReturnPosition() {
        // The reporting site (test/Compiler.Tests/IlVerifierTests.cs:206):
        // `Assert.Throws<XunitException>(() => IlVerifier.RunProcess(…))`.
        let result = EmittedOracle.Evaluate(`
func Run(name string) (ExitCode int32, Stdout string?, Stderr string?) {
    return (ExitCode: 9, Stdout: name, Stderr: nil)
}

func Invoke(f (() -> object?)) object? -> f()

Invoke(func () object? { return Run("z") })!!.ToString()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("(9, z, )", result.Value)
    }

    @Fact
    func NamedTupleWithNullableElement_BoxesInArgumentPosition() {
        let result = EmittedOracle.Evaluate(`
import System

func Describe(value object?) string -> string.Format("{0}", value)

let t (A int32, B string?) = (4, "q")
Describe(t)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("(4, q)", result.Value)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Issue #3907: the unboxing direction. `ArmDescriptor.cs` casts a
    // `ContinueWith` state object back to `((TaskArm, SelectWaiter))state!`.
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func SymbolicTuple_UnboxesFromObject() {
        let result = EmittedOracle.Evaluate(`
class A { var x int32 }
class B { var y int32 }

let a = A()
a.x = 41
let b = B()
b.y = 1
let boxed object = (a, b)
let t = cast[(A, B)](boxed)
t.Item1.x + t.Item2.y
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SymbolicTuple_UnboxesFromObject_AndDeconstructs() {
        // The shape the migrated channels runtime actually uses: the cast feeds
        // a deconstruction, so a failure here reads as "variable doesn't exist"
        // for every name the pattern binds.
        let result = EmittedOracle.Evaluate(`
class A { var x int32 }
class B { var y int32 }

let a = A()
a.x = 40
let b = B()
b.y = 2
let boxed object = (a, b)
let (p, q) = cast[(A, B)](boxed)
p.x + q.y
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SymbolicTuple_UnboxingWrongShape_StillThrowsAtRuntime() {
        // Widening the conversion classification must not turn a bad cast into
        // a silent default: `cast[T]` keeps C# `(T)x` semantics.
        let result = EmittedOracle.Evaluate(`
import System

class A { var x int32 }
class B { var y int32 }

let boxed object = "not a tuple"
var caught = false
try {
    let t = cast[(A, B)](boxed)
    let _ = t.Item1
} catch (e InvalidCastException) {
    caught = true
}

caught
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }
}
