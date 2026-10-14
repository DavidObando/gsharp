// <copyright file="Issue1622ClearCacheOnDisposeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1622 regression coverage: (cref:ReferenceResolver.Dispose) only
/// cleared (cref:ImportedTypeSymbol) and (cref:FunctionTypeSymbol)'s
/// process-wide interning caches, leaving every other type-symbol cache
/// ((cref:NullableTypeSymbol), (cref:SliceTypeSymbol),
/// (cref:MapTypeSymbol), (cref:PointerTypeSymbol),
/// (cref:ByRefTypeSymbol), (cref:ArrayTypeSymbol),
/// (cref:SequenceTypeSymbol), (cref:AsyncSequenceTypeSymbol),
/// (cref:ChannelTypeSymbol), (cref:TupleTypeSymbol),
/// (cref:FunctionPointerTypeSymbol), (cref:StructSymbol),
/// (cref:InterfaceSymbol), (cref:DelegateTypeSymbol)) to leak
/// entries — and the disposed `MetadataLoadContext` object graph they
/// pin — for the process lifetime. Each test below populates a cache with an
/// entry keyed on a stable singleton (e.g. (cref:TypeSymbol.Int32)),
/// clears the cache, and asserts a fresh lookup produces a NEW instance
/// instead of the one cached before the clear.
open class Issue1622ClearCacheOnDisposeTests {
    @Fact
    func ArrayTypeSymbol_ClearCache_EvictsEntries() {
        let before = ArrayTypeSymbol.Get(TypeSymbol.Int32, 4)
        ArrayTypeSymbol.ClearCache()
        let after = ArrayTypeSymbol.Get(TypeSymbol.Int32, 4)
        Assert.NotSame(before, after)
    }

    @Fact
    func AsyncSequenceTypeSymbol_ClearCache_EvictsEntries() {
        let before = AsyncSequenceTypeSymbol.Get(TypeSymbol.Int32)
        AsyncSequenceTypeSymbol.ClearCache()
        let after = AsyncSequenceTypeSymbol.Get(TypeSymbol.Int32)
        Assert.NotSame(before, after)
    }

    @Fact
    func ByRefTypeSymbol_ClearCache_EvictsEntries() {
        let before = ByRefTypeSymbol.Get(TypeSymbol.Int32)
        ByRefTypeSymbol.ClearCache()
        let after = ByRefTypeSymbol.Get(TypeSymbol.Int32)
        Assert.NotSame(before, after)
    }

    @Fact
    func ChannelTypeSymbol_ClearCache_EvictsEntries() {
        let before = ChannelTypeSymbol.Get(TypeSymbol.Int32)
        ChannelTypeSymbol.ClearCache()
        let after = ChannelTypeSymbol.Get(TypeSymbol.Int32)
        Assert.NotSame(before, after)
    }

    @Fact
    func MapTypeSymbol_ClearCache_EvictsEntries() {
        let before = MapTypeSymbol.Get(TypeSymbol.Int32, TypeSymbol.String)
        MapTypeSymbol.ClearCache()
        let after = MapTypeSymbol.Get(TypeSymbol.Int32, TypeSymbol.String)
        Assert.NotSame(before, after)
    }

    @Fact
    func NullableTypeSymbol_ClearCache_EvictsEntries() {
        let before = NullableTypeSymbol.Get(TypeSymbol.Int32)
        NullableTypeSymbol.ClearCache()
        let after = NullableTypeSymbol.Get(TypeSymbol.Int32)
        Assert.NotSame(before, after)
    }

    @Fact
    func PointerTypeSymbol_ClearCache_EvictsEntries() {
        let before = PointerTypeSymbol.Get(TypeSymbol.Int32)
        PointerTypeSymbol.ClearCache()
        let after = PointerTypeSymbol.Get(TypeSymbol.Int32)
        Assert.NotSame(before, after)
    }

    @Fact
    func SequenceTypeSymbol_ClearCache_EvictsEntries() {
        let before = SequenceTypeSymbol.Get(TypeSymbol.Int32)
        SequenceTypeSymbol.ClearCache()
        let after = SequenceTypeSymbol.Get(TypeSymbol.Int32)
        Assert.NotSame(before, after)
    }

    @Fact
    func SliceTypeSymbol_ClearCache_EvictsEntries() {
        let before = SliceTypeSymbol.Get(TypeSymbol.Int32)
        SliceTypeSymbol.ClearCache()
        let after = SliceTypeSymbol.Get(TypeSymbol.Int32)
        Assert.NotSame(before, after)
    }

    @Fact
    func TupleTypeSymbol_ClearCache_EvictsEntries() {
        let elements = ImmutableArray.Create(TypeSymbol.Int32, TypeSymbol.String)
        let before = TupleTypeSymbol.Get(elements)
        TupleTypeSymbol.ClearCache()
        let after = TupleTypeSymbol.Get(elements)
        Assert.NotSame(before, after)
    }

    @Fact
    func FunctionPointerTypeSymbol_ClearCache_EvictsEntries() {
        let parameters = ImmutableArray.Create(TypeSymbol.Int32)
        let before = FunctionPointerTypeSymbol.GetManaged(parameters, TypeSymbol.Bool)
        FunctionPointerTypeSymbol.ClearCache()
        let after = FunctionPointerTypeSymbol.GetManaged(parameters, TypeSymbol.Bool)
        Assert.NotSame(before, after)
    }

    @Fact
    func StructSymbol_ClearCache_EvictsConstructedCaches() {
        let box = GetStruct("Box")
        let before = StructSymbol.Construct(box, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        StructSymbol.ClearCache()
        let after = StructSymbol.Construct(box, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        Assert.NotSame(before, after)
    }

    @Fact
    func InterfaceSymbol_ClearCache_EvictsConstructedCache() {
        let definition = InterfaceSymbol("IBox", Accessibility.Public, declaration: nil, packageName: "P")
        definition.SetTypeParameters(
            ImmutableArray.Create(TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None))
        )
        let typeArguments = ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
        let before = InterfaceSymbol.Construct(definition, typeArguments)
        InterfaceSymbol.ClearCache()
        let after = InterfaceSymbol.Construct(definition, typeArguments)
        Assert.NotSame(before, after)
    }

    @Fact
    func DelegateTypeSymbol_ClearCache_EvictsConstructedCache() {
        let typeParameter = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let definition = DelegateTypeSymbol(
            "D",
            "P",
            Accessibility.Public,
            ImmutableArray[ParameterSymbol].Empty,
            returnType: typeParameter,
            declaration: nil
        )
        definition.SetTypeParameters(ImmutableArray.Create(typeParameter))
        let typeArguments = ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
        let before = DelegateTypeSymbol.Construct(definition, typeArguments)
        DelegateTypeSymbol.ClearCache()
        let after = DelegateTypeSymbol.Construct(definition, typeArguments)
        Assert.NotSame(before, after)
    }

    @Fact
    func Dispose_ClearsEveryTypeSymbolCache() {
        // Populate a representative sample of the caches Dispose is
        // responsible for evicting.
        let arrayBefore = ArrayTypeSymbol.Get(TypeSymbol.Bool, 2)
        let nullableBefore = NullableTypeSymbol.Get(TypeSymbol.Bool)
        let sliceBefore = SliceTypeSymbol.Get(TypeSymbol.Bool)
        let corePath = typeof(ReferenceResolver).Assembly.Location
        let resolver = ReferenceResolver.WithReferences([]string{corePath})
        resolver.Dispose()
        Assert.NotSame(arrayBefore, ArrayTypeSymbol.Get(TypeSymbol.Bool, 2))
        Assert.NotSame(nullableBefore, NullableTypeSymbol.Get(TypeSymbol.Bool))
        Assert.NotSame(sliceBefore, SliceTypeSymbol.Get(TypeSymbol.Bool))
    }

    shared {
        private const StructSource string = `package P

class Box[T] {
    var field T
}
`

        private func GetStruct(name string) StructSymbol {
            let tree = SyntaxTree.Parse(SourceText.From(StructSource))
            let compilation = Compilation(tree)
            Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
            return cast[StructSymbol](compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == name))
        }
    }
}
