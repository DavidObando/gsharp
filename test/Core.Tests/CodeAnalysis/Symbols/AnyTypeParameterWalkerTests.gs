// <copyright file="AnyTypeParameterWalkerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable
import Xunit

/// Issue #1481 — the single canonical structural type-parameter walk
/// ((cref:TypeSymbol.AnyTypeParameter)) and its two public wrappers
/// ((cref:TypeSymbol.ContainsTypeParameter) and
/// (cref:TypeSymbol.ContainsOuterMethodTypeParameter)). These replace
/// three previously hand-copied, divergent recursions; the two emit-layer
/// copies omitted (cref:MapTypeSymbol) / (cref:FunctionTypeSymbol)
/// (and one also omitted (cref:StructSymbol) arguments), erasing
/// generic iterator element types. The walker must descend into every
/// composite kind that can structurally carry a type parameter.
open class AnyTypeParameterWalkerTests {
    @Fact
    func ContainsTypeParameter_BareTypeParameter_True() {
        Assert.True(TypeSymbol.ContainsTypeParameter(Tp("T")))
    }

    @Fact
    func ContainsTypeParameter_NoTypeParameter_False() {
        Assert.False(TypeSymbol.ContainsTypeParameter(TypeSymbol.Int32))
        Assert.False(TypeSymbol.ContainsTypeParameter(MapTypeSymbol.Get(TypeSymbol.String, TypeSymbol.Int32)))
        Assert.False(TypeSymbol.ContainsTypeParameter(nil))
    }

    @Fact
    func ContainsTypeParameter_MapKeyOrValue_True() {
        // The two emit-layer copies omitted MapTypeSymbol entirely — this is
        // the core regression the consolidation fixes.
        let t = Tp("T")
        Assert.True(TypeSymbol.ContainsTypeParameter(MapTypeSymbol.Get(TypeSymbol.String, t)))
        Assert.True(TypeSymbol.ContainsTypeParameter(MapTypeSymbol.Get(t, TypeSymbol.String)))
    }

    @Fact
    func ContainsTypeParameter_FunctionParamOrReturn_True() {
        // Also omitted by both emit copies.
        let t = Tp("T")
        let paramOpen = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](t), TypeSymbol.Int32)
        let returnOpen = FunctionTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.Int32), t)
        Assert.True(TypeSymbol.ContainsTypeParameter(paramOpen))
        Assert.True(TypeSymbol.ContainsTypeParameter(returnOpen))
    }

    @Fact
    func ContainsTypeParameter_SequenceAndAsyncSequence_True() {
        let t = Tp("T")
        Assert.True(TypeSymbol.ContainsTypeParameter(SequenceTypeSymbol.Get(t)))
        Assert.True(TypeSymbol.ContainsTypeParameter(AsyncSequenceTypeSymbol.Get(t)))
    }

    @Fact
    func ContainsTypeParameter_NestedComposite_True() {
        // sequence[map[string, (T) -> int32]] — every wrapper kind nested.
        let t = Tp("T")
        let fn = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](t), TypeSymbol.Int32)
        let map_ = MapTypeSymbol.Get(TypeSymbol.String, fn)
        let seq = SequenceTypeSymbol.Get(map_)
        Assert.True(TypeSymbol.ContainsTypeParameter(seq))
    }

    @Fact
    func ContainsTypeParameter_SliceArrayNullableTuple_True() {
        let t = Tp("T")
        Assert.True(TypeSymbol.ContainsTypeParameter(SliceTypeSymbol.Get(t)))
        Assert.True(TypeSymbol.ContainsTypeParameter(ArrayTypeSymbol.Get(t, 3)))
        Assert.True(TypeSymbol.ContainsTypeParameter(NullableTypeSymbol.Get(t)))
        Assert.True(
            TypeSymbol.ContainsTypeParameter(
                TupleTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.Int32, cast[TypeSymbol](t)))
            )
        )
    }

    @Fact
    func AnyTypeParameter_LeafPredicate_OnlyMatchesPredicate() {
        // The leaf predicate must be consulted per referenced parameter.
        let t = Tp("T", 0)
        let u = Tp("U", 1)
        let map_ = MapTypeSymbol.Get(t, u)
        Assert.True(TypeSymbol.AnyTypeParameter(map_, (tp TypeParameterSymbol) -> tp == t))
        Assert.True(TypeSymbol.AnyTypeParameter(map_, (tp TypeParameterSymbol) -> tp == u))
        Assert.False(TypeSymbol.AnyTypeParameter(map_, (_ TypeParameterSymbol) -> false))
        Assert.True(TypeSymbol.AnyTypeParameter(map_, (_ TypeParameterSymbol) -> true))
    }

    @Fact
    func ContainsOuterMethodTypeParameter_OnlyMatchesSuppliedParameters() {
        // The StateMachineEmitter copy used membership in the outer-method
        // parameter set rather than "is any type parameter". A type parameter
        // that is NOT in the supplied set must not match — and, unlike the old
        // copy, map / function composites must now be descended into.
        let outer = Tp("T", 0)
        let unrelated = Tp("X", 5)
        let outerSet = ImmutableArray.Create(outer)
        let mapWithOuter = MapTypeSymbol.Get(TypeSymbol.String, outer)
        let mapWithUnrelated = MapTypeSymbol.Get(TypeSymbol.String, unrelated)
        let funcWithOuter = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](outer), TypeSymbol.Int32)
        Assert.True(TypeSymbol.ContainsOuterMethodTypeParameter(mapWithOuter, outerSet))
        Assert.True(TypeSymbol.ContainsOuterMethodTypeParameter(funcWithOuter, outerSet))
        Assert.False(TypeSymbol.ContainsOuterMethodTypeParameter(mapWithUnrelated, outerSet))
    }

    @Fact
    func ContainsOuterMethodTypeParameter_EmptyOrDefaultSet_False() {
        let t = Tp("T")
        Assert.False(TypeSymbol.ContainsOuterMethodTypeParameter(t, ImmutableArray[TypeParameterSymbol].Empty))
        Assert.False(TypeSymbol.ContainsOuterMethodTypeParameter(t, default(ImmutableArray[TypeParameterSymbol])))
    }

    shared {
        private func Tp(name string, ordinal int32 = 0) TypeParameterSymbol -> TypeParameterSymbol(
            name,
            ordinal,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None
        )
    }
}
