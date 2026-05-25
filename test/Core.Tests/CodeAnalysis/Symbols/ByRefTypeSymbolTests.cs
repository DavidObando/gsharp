// <copyright file="ByRefTypeSymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0039: Tests for <see cref="ByRefTypeSymbol"/> — interning, equality, CLR type mapping.
/// </summary>
public class ByRefTypeSymbolTests
{
    [Fact]
    public void Get_Returns_Same_Instance_For_Same_Pointee()
    {
        var a = ByRefTypeSymbol.Get(TypeSymbol.Int);
        var b = ByRefTypeSymbol.Get(TypeSymbol.Int);
        Assert.Same(a, b);
    }

    [Fact]
    public void Get_Returns_Different_Instance_For_Different_Pointee()
    {
        var intRef = ByRefTypeSymbol.Get(TypeSymbol.Int);
        var boolRef = ByRefTypeSymbol.Get(TypeSymbol.Bool);
        Assert.NotSame(intRef, boolRef);
    }

    [Fact]
    public void PointeeType_Returns_Original()
    {
        var byRef = ByRefTypeSymbol.Get(TypeSymbol.String);
        Assert.Same(TypeSymbol.String, byRef.PointeeType);
    }

    [Fact]
    public void ClrType_Is_ByRef()
    {
        var byRef = ByRefTypeSymbol.Get(TypeSymbol.Int);
        Assert.NotNull(byRef.ClrType);
        Assert.True(byRef.ClrType.IsByRef);
        Assert.Equal(typeof(int), byRef.ClrType.GetElementType());
    }

    [Fact]
    public void Name_Has_Star_Prefix()
    {
        var byRef = ByRefTypeSymbol.Get(TypeSymbol.Int);
        Assert.Equal("*int", byRef.Name);
    }

    [Fact]
    public void PointeeType_Roundtrips()
    {
        var original = TypeSymbol.Bool;
        var byRef = ByRefTypeSymbol.Get(original);
        Assert.Same(original, byRef.PointeeType);
        Assert.Equal("*bool", byRef.Name);
    }
}
