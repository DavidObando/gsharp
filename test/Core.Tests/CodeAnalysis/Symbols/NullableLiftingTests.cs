// <copyright file="NullableLiftingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// PR N-1 / bug-overview §6.1: the <see cref="NullableLifting"/> facade
/// collects every <c>Nullable&lt;T&gt;</c> probe / constructor-projection
/// helper that the binder and emitter rely on. These tests pin the
/// behavioural contract of the facade so subsequent PRs (N-2/N-3/N-4) that
/// plug new logic into the same seam cannot regress the pre-existing
/// callers silently.
/// </summary>
public class NullableLiftingTests
{
    [Fact]
    public void IsValueTypeNullable_Returns_True_For_Value_Type_Nullable()
    {
        var sym = NullableTypeSymbol.Get(TypeSymbol.Int32);
        Assert.True(NullableLifting.IsValueTypeNullable(sym));
    }

    [Fact]
    public void IsValueTypeNullable_Returns_False_For_Reference_Type_Nullable()
    {
        var sym = NullableTypeSymbol.Get(TypeSymbol.String);
        Assert.False(NullableLifting.IsValueTypeNullable(sym));
    }

    [Fact]
    public void IsValueTypeNullable_Returns_False_For_Null_Argument()
    {
        Assert.False(NullableLifting.IsValueTypeNullable(null!));
    }

    [Fact]
    public void IsValueTypeNullableClr_Returns_True_For_Constructed_Nullable_Of_Int()
    {
        Assert.True(NullableLifting.IsValueTypeNullableClr(typeof(int?)));
    }

    [Fact]
    public void IsValueTypeNullableClr_Returns_False_For_Open_Nullable_Definition()
    {
        Assert.False(NullableLifting.IsValueTypeNullableClr(typeof(Nullable<>)));
    }

    [Fact]
    public void IsValueTypeNullableClr_Returns_False_For_Non_Generic_Type()
    {
        Assert.False(NullableLifting.IsValueTypeNullableClr(typeof(int)));
        Assert.False(NullableLifting.IsValueTypeNullableClr(typeof(string)));
    }

    [Fact]
    public void IsValueTypeNullableClr_Returns_False_For_Null_Argument()
    {
        Assert.False(NullableLifting.IsValueTypeNullableClr(null!));
    }

    [Fact]
    public void GetEffectiveClrType_Returns_Nullable_For_ValueType_Wrapper()
    {
        var sym = NullableTypeSymbol.Get(TypeSymbol.Int32);
        var clr = NullableLifting.GetEffectiveClrType(sym);
        Assert.Equal(typeof(int?), clr);
    }

    [Fact]
    public void GetEffectiveClrType_Returns_Underlying_For_ReferenceType_Wrapper()
    {
        var sym = NullableTypeSymbol.Get(TypeSymbol.String);
        var clr = NullableLifting.GetEffectiveClrType(sym);
        Assert.Equal(typeof(string), clr);
    }

    [Fact]
    public void GetEffectiveClrType_Returns_Underlying_For_NonNullable()
    {
        var clr = NullableLifting.GetEffectiveClrType(TypeSymbol.Int32);
        Assert.Equal(typeof(int), clr);
    }

    [Fact]
    public void GetEffectiveClrType_Returns_Null_For_Null_Argument()
    {
        Assert.Null(NullableLifting.GetEffectiveClrType(null!));
    }

    [Fact]
    public void TryConstructNullable_Succeeds_With_Default_References()
    {
        var refs = ReferenceResolver.Default();
        var ok = NullableLifting.TryConstructNullable(refs, typeof(int), out var constructed);
        Assert.True(ok);
        Assert.Equal(typeof(int?), constructed);
    }

    [Fact]
    public void TryConstructNullable_Returns_False_For_Null_Underlying()
    {
        var refs = ReferenceResolver.Default();
        var ok = NullableLifting.TryConstructNullable(refs, null!, out var constructed);
        Assert.False(ok);
        Assert.Null(constructed);
    }

    [Fact]
    public void TryConstructNullable_Returns_Nullable_For_TimeSpan()
    {
        var refs = ReferenceResolver.Default();
        var ok = NullableLifting.TryConstructNullable(refs, typeof(TimeSpan), out var constructed);
        Assert.True(ok);
        Assert.Equal(typeof(TimeSpan?), constructed);
    }

    [Fact]
    public void ResolveClrTypeForGenericArg_Returns_Nullable_For_ValueType_NullableTypeSymbol()
    {
        var refs = ReferenceResolver.Default();
        var sym = NullableTypeSymbol.Get(TypeSymbol.Int32);
        var clr = NullableLifting.ResolveClrTypeForGenericArg(refs, sym);
        Assert.Equal(typeof(int?), clr);
    }

    [Fact]
    public void ResolveClrTypeForGenericArg_Returns_Underlying_For_ReferenceType_NullableTypeSymbol()
    {
        var refs = ReferenceResolver.Default();
        var sym = NullableTypeSymbol.Get(TypeSymbol.String);
        var clr = NullableLifting.ResolveClrTypeForGenericArg(refs, sym);

        // Reference-type nullability has no CLR counterpart: contract documented
        // at Binder.cs:2387 says the result is the bare underlying reference type.
        Assert.Equal(typeof(string), clr);
    }

    [Fact]
    public void ResolveClrTypeForGenericArg_Returns_Mapped_Type_For_NonNullable_Imported_Type()
    {
        var refs = ReferenceResolver.Default();
        var clr = NullableLifting.ResolveClrTypeForGenericArg(refs, TypeSymbol.Int32);
        Assert.Equal(typeof(int), clr);
    }

    [Fact]
    public void ResolveClrTypeForGenericArg_Returns_Null_For_TypeSymbol_With_No_ClrType()
    {
        var refs = ReferenceResolver.Default();
        var userStruct = new StructSymbol(
            "MyStruct",
            ImmutableArray<FieldSymbol>.Empty,
            Accessibility.Public,
            declaration: null!,
            packageName: "test");
        Assert.Null(userStruct.ClrType);

        var clr = NullableLifting.ResolveClrTypeForGenericArg(refs, userStruct);
        Assert.Null(clr);
    }
}
