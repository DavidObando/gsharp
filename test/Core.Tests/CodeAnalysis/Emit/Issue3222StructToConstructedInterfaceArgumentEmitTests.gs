// <copyright file="Issue3222StructToConstructedInterfaceArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Tests
import Xunit

/// Issue #3222: a plain generic function call whose parameter is a
/// constructed user generic interface (`func Describe[T](h IHolder[T])`)
/// skipped the argument's materialized conversion whenever the declared
/// parameter type CONTAINED a type parameter — but only a BARE `!!T`
/// slot is emitter-erased; `IHolder<!!T>` is a real constructed
/// reference slot, so a value-type argument needs its `box`. The raw
/// struct on the stack where an interface reference was expected produced
/// `InvalidProgramException`. The fix narrows the skip in
/// `OverloadResolver.CallBinding` to bare type-parameter slots,
/// mirroring `BindUserInstanceCall`'s per-argument guard.
open class Issue3222StructToConstructedInterfaceArgumentEmitTests {
    @Fact
    func ImplementingStructArgument_Boxes_ToConstructedInterface() {
        // Pre-fix: InvalidProgramException (StringBox on the stack where
        // IHolder<string> was expected — no box emitted).
        let result = EmittedOracle.Evaluate(`
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
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hi", result.Value)
    }

    @Fact
    func ImplementingStructArgument_ValueTypeArgument_Boxes() {
        // Same shape at a value-type interface instantiation: the boxed
        // struct must dispatch Get() to the implementation, not to a zeroed
        // copy — pins both the box and the interface dispatch.
        let result = EmittedOracle.Evaluate(`
interface IHolder[T] {
    func Get() T;
}

struct IntBox : IHolder[int32] {
    var Value int32
    func Get() int32 { return Value }
}

func Describe[T](h IHolder[T]) T {
    return h.Get()
}

Describe(IntBox{Value: 42})
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ImplementingClassArgument_Control_StillWorks() {
        // The reference-typed implementor never needed the box; guards the
        // narrowed skip against regressing the previously-working path.
        let result = EmittedOracle.Evaluate(`
interface IHolder[T] {
    func Get() T;
}

class StringCell : IHolder[string] {
    var Value string
    func Get() string { return Value }
}

func Describe[T](h IHolder[T]) T {
    return h.Get()
}

Describe(StringCell{Value: "hi"})
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hi", result.Value)
    }

    @Fact
    func BareTypeParameterSlot_Control_KeepsErasedBoxing() {
        // A bare `x T` slot stays on the emitter's type-erasure boxing (the
        // skip the fix deliberately preserves): a value-type argument through
        // `!!T` must still work.
        let result = EmittedOracle.Evaluate(`
func Identity[T](x T) T {
    return x
}

Identity(41) + 1
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }
}
