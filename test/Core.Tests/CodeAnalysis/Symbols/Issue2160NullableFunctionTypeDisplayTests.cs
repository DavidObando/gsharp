// <copyright file="Issue2160NullableFunctionTypeDisplayTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #2160: a nullable function type must render with the <c>?</c> wrapping
/// the whole arrow shape (<c>((int32) -> void)?</c>), not bound to the return
/// type (<c>(int32) -> void?</c>). Covers both the hover formatter
/// (<see cref="SymbolDisplay"/>) and the raw <see cref="TypeSymbol.Name"/> used
/// by diagnostics (e.g. GS0155).
/// </summary>
public class Issue2160NullableFunctionTypeDisplayTests
{
    private static FunctionTypeSymbol Func(TypeSymbol returnType, params TypeSymbol[] parameterTypes)
        => FunctionTypeSymbol.Get(ImmutableArray.Create(parameterTypes), returnType);

    private static string Render(TypeSymbol type)
    {
        var local = new LocalVariableSymbol("v", isReadOnly: true, type);
        return SymbolDisplay.ToDisplayString(local, SymbolDisplayFormat.Hover);
    }

    [Fact]
    public void NullableVoidReturningFunction_ParenthesizesWholeFunctionType()
    {
        var type = NullableTypeSymbol.Get(Func(TypeSymbol.Void, TypeSymbol.Int32));

        Assert.Equal("(local variable) v ((int32) -> void)?", Render(type));
        Assert.Equal("((int32) -> void)?", type.Name);
    }

    [Fact]
    public void NullableStringReturningFunction_ParenthesizesWholeFunctionType()
    {
        var type = NullableTypeSymbol.Get(Func(TypeSymbol.String, TypeSymbol.Int32));

        Assert.Equal("(local variable) v ((int32) -> string)?", Render(type));
        Assert.Equal("((int32) -> string)?", type.Name);
    }

    [Fact]
    public void NonNullableFunction_RendersWithoutExtraParentheses()
    {
        var type = Func(TypeSymbol.Void, TypeSymbol.Int32);

        Assert.Equal("(local variable) v (int32) -> void", Render(type));
    }

    [Fact]
    public void PlainNullablePrimitive_IsUnchanged()
    {
        Assert.Equal("(local variable) v string?", Render(NullableTypeSymbol.Get(TypeSymbol.String)));
        Assert.Equal("(local variable) v int32?", Render(NullableTypeSymbol.Get(TypeSymbol.Int32)));
    }

    [Fact]
    public void SliceOfNullableFunction_ParenthesizesNestedFunctionType()
    {
        var type = SliceTypeSymbol.Get(NullableTypeSymbol.Get(Func(TypeSymbol.Void, TypeSymbol.Int32)));

        Assert.Equal("(local variable) v []((int32) -> void)?", Render(type));
    }
}
