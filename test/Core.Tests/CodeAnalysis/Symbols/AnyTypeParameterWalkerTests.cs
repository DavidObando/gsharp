// <copyright file="AnyTypeParameterWalkerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #1481 — the single canonical structural type-parameter walk
/// (<see cref="TypeSymbol.AnyTypeParameter"/>) and its two public wrappers
/// (<see cref="TypeSymbol.ContainsTypeParameter"/> and
/// <see cref="TypeSymbol.ContainsOuterMethodTypeParameter"/>). These replace
/// three previously hand-copied, divergent recursions; the two emit-layer
/// copies omitted <see cref="MapTypeSymbol"/> / <see cref="FunctionTypeSymbol"/>
/// (and one also omitted <see cref="StructSymbol"/> arguments), erasing
/// generic iterator element types. The walker must descend into every
/// composite kind that can structurally carry a type parameter.
/// </summary>
public class AnyTypeParameterWalkerTests
{
    private static TypeParameterSymbol Tp(string name, int ordinal = 0)
        => new(name, ordinal, TypeParameterConstraint.Any, TypeParameterVariance.None);

    [Fact]
    public void ContainsTypeParameter_BareTypeParameter_True()
    {
        Assert.True(TypeSymbol.ContainsTypeParameter(Tp("T")));
    }

    [Fact]
    public void ContainsTypeParameter_NoTypeParameter_False()
    {
        Assert.False(TypeSymbol.ContainsTypeParameter(TypeSymbol.Int32));
        Assert.False(TypeSymbol.ContainsTypeParameter(MapTypeSymbol.Get(TypeSymbol.String, TypeSymbol.Int32)));
        Assert.False(TypeSymbol.ContainsTypeParameter(null));
    }

    [Fact]
    public void ContainsTypeParameter_MapKeyOrValue_True()
    {
        // The two emit-layer copies omitted MapTypeSymbol entirely — this is
        // the core regression the consolidation fixes.
        var t = Tp("T");
        Assert.True(TypeSymbol.ContainsTypeParameter(MapTypeSymbol.Get(TypeSymbol.String, t)));
        Assert.True(TypeSymbol.ContainsTypeParameter(MapTypeSymbol.Get(t, TypeSymbol.String)));
    }

    [Fact]
    public void ContainsTypeParameter_FunctionParamOrReturn_True()
    {
        // Also omitted by both emit copies.
        var t = Tp("T");
        var paramOpen = FunctionTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(t), TypeSymbol.Int32);
        var returnOpen = FunctionTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.Int32), t);
        Assert.True(TypeSymbol.ContainsTypeParameter(paramOpen));
        Assert.True(TypeSymbol.ContainsTypeParameter(returnOpen));
    }

    [Fact]
    public void ContainsTypeParameter_SequenceAndAsyncSequence_True()
    {
        var t = Tp("T");
        Assert.True(TypeSymbol.ContainsTypeParameter(SequenceTypeSymbol.Get(t)));
        Assert.True(TypeSymbol.ContainsTypeParameter(AsyncSequenceTypeSymbol.Get(t)));
    }

    [Fact]
    public void ContainsTypeParameter_NestedComposite_True()
    {
        // sequence[map[string, (T) -> int32]] — every wrapper kind nested.
        var t = Tp("T");
        var fn = FunctionTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(t), TypeSymbol.Int32);
        var map = MapTypeSymbol.Get(TypeSymbol.String, fn);
        var seq = SequenceTypeSymbol.Get(map);
        Assert.True(TypeSymbol.ContainsTypeParameter(seq));
    }

    [Fact]
    public void ContainsTypeParameter_SliceArrayNullableTuple_True()
    {
        var t = Tp("T");
        Assert.True(TypeSymbol.ContainsTypeParameter(SliceTypeSymbol.Get(t)));
        Assert.True(TypeSymbol.ContainsTypeParameter(ArrayTypeSymbol.Get(t, 3)));
        Assert.True(TypeSymbol.ContainsTypeParameter(NullableTypeSymbol.Get(t)));
        Assert.True(TypeSymbol.ContainsTypeParameter(
            TupleTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.Int32, (TypeSymbol)t))));
    }

    [Fact]
    public void AnyTypeParameter_LeafPredicate_OnlyMatchesPredicate()
    {
        // The leaf predicate must be consulted per referenced parameter.
        var t = Tp("T", 0);
        var u = Tp("U", 1);
        var map = MapTypeSymbol.Get(t, u);

        Assert.True(TypeSymbol.AnyTypeParameter(map, tp => tp == t));
        Assert.True(TypeSymbol.AnyTypeParameter(map, tp => tp == u));
        Assert.False(TypeSymbol.AnyTypeParameter(map, _ => false));
        Assert.True(TypeSymbol.AnyTypeParameter(map, _ => true));
    }

    [Fact]
    public void ContainsOuterMethodTypeParameter_OnlyMatchesSuppliedParameters()
    {
        // The StateMachineEmitter copy used membership in the outer-method
        // parameter set rather than "is any type parameter". A type parameter
        // that is NOT in the supplied set must not match — and, unlike the old
        // copy, map / function composites must now be descended into.
        var outer = Tp("T", 0);
        var unrelated = Tp("X", 5);
        var outerSet = ImmutableArray.Create(outer);

        var mapWithOuter = MapTypeSymbol.Get(TypeSymbol.String, outer);
        var mapWithUnrelated = MapTypeSymbol.Get(TypeSymbol.String, unrelated);
        var funcWithOuter = FunctionTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(outer), TypeSymbol.Int32);

        Assert.True(TypeSymbol.ContainsOuterMethodTypeParameter(mapWithOuter, outerSet));
        Assert.True(TypeSymbol.ContainsOuterMethodTypeParameter(funcWithOuter, outerSet));
        Assert.False(TypeSymbol.ContainsOuterMethodTypeParameter(mapWithUnrelated, outerSet));
    }

    [Fact]
    public void ContainsOuterMethodTypeParameter_EmptyOrDefaultSet_False()
    {
        var t = Tp("T");
        Assert.False(TypeSymbol.ContainsOuterMethodTypeParameter(t, ImmutableArray<TypeParameterSymbol>.Empty));
        Assert.False(TypeSymbol.ContainsOuterMethodTypeParameter(t, default));
    }
}
