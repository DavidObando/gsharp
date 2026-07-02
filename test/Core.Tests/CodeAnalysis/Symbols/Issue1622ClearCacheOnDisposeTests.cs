// <copyright file="Issue1622ClearCacheOnDisposeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #1622 regression coverage: <see cref="ReferenceResolver.Dispose"/> only
/// cleared <see cref="ImportedTypeSymbol"/> and <see cref="FunctionTypeSymbol"/>'s
/// process-wide interning caches, leaving every other type-symbol cache
/// (<see cref="NullableTypeSymbol"/>, <see cref="SliceTypeSymbol"/>,
/// <see cref="MapTypeSymbol"/>, <see cref="PointerTypeSymbol"/>,
/// <see cref="ByRefTypeSymbol"/>, <see cref="ArrayTypeSymbol"/>,
/// <see cref="SequenceTypeSymbol"/>, <see cref="AsyncSequenceTypeSymbol"/>,
/// <see cref="ChannelTypeSymbol"/>, <see cref="TupleTypeSymbol"/>,
/// <see cref="FunctionPointerTypeSymbol"/>, <see cref="StructSymbol"/>,
/// <see cref="InterfaceSymbol"/>, <see cref="DelegateTypeSymbol"/>) to leak
/// entries — and the disposed <c>MetadataLoadContext</c> object graph they
/// pin — for the process lifetime. Each test below populates a cache with an
/// entry keyed on a stable singleton (e.g. <see cref="TypeSymbol.Int32"/>),
/// clears the cache, and asserts a fresh lookup produces a NEW instance
/// instead of the one cached before the clear.
/// </summary>
public class Issue1622ClearCacheOnDisposeTests
{
    [Fact]
    public void ArrayTypeSymbol_ClearCache_EvictsEntries()
    {
        var before = ArrayTypeSymbol.Get(TypeSymbol.Int32, 4);
        ArrayTypeSymbol.ClearCache();
        var after = ArrayTypeSymbol.Get(TypeSymbol.Int32, 4);
        Assert.NotSame(before, after);
    }

    [Fact]
    public void AsyncSequenceTypeSymbol_ClearCache_EvictsEntries()
    {
        var before = AsyncSequenceTypeSymbol.Get(TypeSymbol.Int32);
        AsyncSequenceTypeSymbol.ClearCache();
        var after = AsyncSequenceTypeSymbol.Get(TypeSymbol.Int32);
        Assert.NotSame(before, after);
    }

    [Fact]
    public void ByRefTypeSymbol_ClearCache_EvictsEntries()
    {
        var before = ByRefTypeSymbol.Get(TypeSymbol.Int32);
        ByRefTypeSymbol.ClearCache();
        var after = ByRefTypeSymbol.Get(TypeSymbol.Int32);
        Assert.NotSame(before, after);
    }

    [Fact]
    public void ChannelTypeSymbol_ClearCache_EvictsEntries()
    {
        var before = ChannelTypeSymbol.Get(TypeSymbol.Int32);
        ChannelTypeSymbol.ClearCache();
        var after = ChannelTypeSymbol.Get(TypeSymbol.Int32);
        Assert.NotSame(before, after);
    }

    [Fact]
    public void MapTypeSymbol_ClearCache_EvictsEntries()
    {
        var before = MapTypeSymbol.Get(TypeSymbol.Int32, TypeSymbol.String);
        MapTypeSymbol.ClearCache();
        var after = MapTypeSymbol.Get(TypeSymbol.Int32, TypeSymbol.String);
        Assert.NotSame(before, after);
    }

    [Fact]
    public void NullableTypeSymbol_ClearCache_EvictsEntries()
    {
        var before = NullableTypeSymbol.Get(TypeSymbol.Int32);
        NullableTypeSymbol.ClearCache();
        var after = NullableTypeSymbol.Get(TypeSymbol.Int32);
        Assert.NotSame(before, after);
    }

    [Fact]
    public void PointerTypeSymbol_ClearCache_EvictsEntries()
    {
        var before = PointerTypeSymbol.Get(TypeSymbol.Int32);
        PointerTypeSymbol.ClearCache();
        var after = PointerTypeSymbol.Get(TypeSymbol.Int32);
        Assert.NotSame(before, after);
    }

    [Fact]
    public void SequenceTypeSymbol_ClearCache_EvictsEntries()
    {
        var before = SequenceTypeSymbol.Get(TypeSymbol.Int32);
        SequenceTypeSymbol.ClearCache();
        var after = SequenceTypeSymbol.Get(TypeSymbol.Int32);
        Assert.NotSame(before, after);
    }

    [Fact]
    public void SliceTypeSymbol_ClearCache_EvictsEntries()
    {
        var before = SliceTypeSymbol.Get(TypeSymbol.Int32);
        SliceTypeSymbol.ClearCache();
        var after = SliceTypeSymbol.Get(TypeSymbol.Int32);
        Assert.NotSame(before, after);
    }

    [Fact]
    public void TupleTypeSymbol_ClearCache_EvictsEntries()
    {
        var elements = ImmutableArray.Create(TypeSymbol.Int32, TypeSymbol.String);
        var before = TupleTypeSymbol.Get(elements);
        TupleTypeSymbol.ClearCache();
        var after = TupleTypeSymbol.Get(elements);
        Assert.NotSame(before, after);
    }

    [Fact]
    public void FunctionPointerTypeSymbol_ClearCache_EvictsEntries()
    {
        var parameters = ImmutableArray.Create(TypeSymbol.Int32);
        var before = FunctionPointerTypeSymbol.GetManaged(parameters, TypeSymbol.Bool);
        FunctionPointerTypeSymbol.ClearCache();
        var after = FunctionPointerTypeSymbol.GetManaged(parameters, TypeSymbol.Bool);
        Assert.NotSame(before, after);
    }

    [Fact]
    public void StructSymbol_ClearCache_EvictsConstructedCaches()
    {
        var box = GetStruct("Box");
        var before = StructSymbol.Construct(box, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));

        StructSymbol.ClearCache();

        var after = StructSymbol.Construct(box, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));
        Assert.NotSame(before, after);
    }

    [Fact]
    public void InterfaceSymbol_ClearCache_EvictsConstructedCache()
    {
        var definition = new InterfaceSymbol("IBox", Accessibility.Public, declaration: null, packageName: "P");
        definition.SetTypeParameters(ImmutableArray.Create(
            new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)));

        var typeArguments = ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32);
        var before = InterfaceSymbol.Construct(definition, typeArguments);

        InterfaceSymbol.ClearCache();

        var after = InterfaceSymbol.Construct(definition, typeArguments);
        Assert.NotSame(before, after);
    }

    [Fact]
    public void DelegateTypeSymbol_ClearCache_EvictsConstructedCache()
    {
        var typeParameter = new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);
        var definition = new DelegateTypeSymbol(
            "D",
            "P",
            Accessibility.Public,
            ImmutableArray<ParameterSymbol>.Empty,
            returnType: typeParameter,
            declaration: null);
        definition.SetTypeParameters(ImmutableArray.Create(typeParameter));

        var typeArguments = ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32);
        var before = DelegateTypeSymbol.Construct(definition, typeArguments);

        DelegateTypeSymbol.ClearCache();

        var after = DelegateTypeSymbol.Construct(definition, typeArguments);
        Assert.NotSame(before, after);
    }

    [Fact]
    public void Dispose_ClearsEveryTypeSymbolCache()
    {
        // Populate a representative sample of the caches Dispose is
        // responsible for evicting.
        var arrayBefore = ArrayTypeSymbol.Get(TypeSymbol.Bool, 2);
        var nullableBefore = NullableTypeSymbol.Get(TypeSymbol.Bool);
        var sliceBefore = SliceTypeSymbol.Get(TypeSymbol.Bool);

        var corePath = typeof(ReferenceResolver).Assembly.Location;
        var resolver = ReferenceResolver.WithReferences(new[] { corePath });
        resolver.Dispose();

        Assert.NotSame(arrayBefore, ArrayTypeSymbol.Get(TypeSymbol.Bool, 2));
        Assert.NotSame(nullableBefore, NullableTypeSymbol.Get(TypeSymbol.Bool));
        Assert.NotSame(sliceBefore, SliceTypeSymbol.Get(TypeSymbol.Bool));
    }

    private const string StructSource = @"package P

class Box[T] {
    var field T
}
";

    private static StructSymbol GetStruct(string name)
    {
        var tree = SyntaxTree.Parse(SourceText.From(StructSource));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);
        return (StructSymbol)compilation.GlobalScope.Structs.Single(s => s.Name == name);
    }
}
