// <copyright file="Issue3222StructToConstructedInterfaceArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3222: a plain generic function call whose parameter is a
/// constructed user generic interface (<c>func Describe[T](h IHolder[T])</c>)
/// skipped the argument's materialized conversion whenever the declared
/// parameter type CONTAINED a type parameter — but only a BARE <c>!!T</c>
/// slot is emitter-erased; <c>IHolder&lt;!!T&gt;</c> is a real constructed
/// reference slot, so a value-type argument needs its <c>box</c>. The raw
/// struct on the stack where an interface reference was expected produced
/// <c>InvalidProgramException</c>. The fix narrows the skip in
/// <c>OverloadResolver.CallBinding</c> to bare type-parameter slots,
/// mirroring <c>BindUserInstanceCall</c>'s per-argument guard.
/// </summary>
public class Issue3222StructToConstructedInterfaceArgumentEmitTests
{
    [Fact]
    public void ImplementingStructArgument_Boxes_ToConstructedInterface()
    {
        // Pre-fix: InvalidProgramException (StringBox on the stack where
        // IHolder<string> was expected — no box emitted).
        var result = EmittedOracle.Evaluate(@"
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

Describe(StringBox{Value: ""hi""})
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void ImplementingStructArgument_ValueTypeArgument_Boxes()
    {
        // Same shape at a value-type interface instantiation: the boxed
        // struct must dispatch Get() to the implementation, not to a zeroed
        // copy — pins both the box and the interface dispatch.
        var result = EmittedOracle.Evaluate(@"
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
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ImplementingClassArgument_Control_StillWorks()
    {
        // The reference-typed implementor never needed the box; guards the
        // narrowed skip against regressing the previously-working path.
        var result = EmittedOracle.Evaluate(@"
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

Describe(StringCell{Value: ""hi""})
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void BareTypeParameterSlot_Control_KeepsErasedBoxing()
    {
        // A bare `x T` slot stays on the emitter's type-erasure boxing (the
        // skip the fix deliberately preserves): a value-type argument through
        // `!!T` must still work.
        var result = EmittedOracle.Evaluate(@"
func Identity[T](x T) T {
    return x
}

Identity(41) + 1
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }
}
