// <copyright file="MetadataTokenCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import Xunit

open class MetadataTokenCacheTests {
    @Fact
    func CtorRefSymbolKey_EqualsDistinguishesRemapIdentities() {
        let ctor = typeof(List[_]).GetConstructors().Single((c ConstructorInfo) -> c.GetParameters().Length == 0)
        let typeArgs = ImmutableArray[TypeSymbol].Empty
        let classRemap = Dictionary[TypeParameterSymbol, int32]()
        let methodRemap = Dictionary[TypeParameterSymbol, int32]()
        let key = MetadataTokenCache.CtorRefSymbolKey(ctor, typeArgs, RemapScope(classRemap, methodRemap))
        Assert.False(
            key.Equals(
                MetadataTokenCache.CtorRefSymbolKey(
                    ctor,
                    typeArgs,
                    RemapScope(Dictionary[TypeParameterSymbol, int32](), methodRemap)
                )
            )
        )
        Assert.False(
            key.Equals(
                MetadataTokenCache.CtorRefSymbolKey(
                    ctor,
                    typeArgs,
                    RemapScope(classRemap, Dictionary[TypeParameterSymbol, int32]())
                )
            )
        )
    }

    @Fact
    func RemapScope_EqualityIsReferenceIdentityPerChannel() {
        let classRemap = Dictionary[TypeParameterSymbol, int32]()
        let methodRemap = Dictionary[TypeParameterSymbol, int32]()
        let scope_ = RemapScope(classRemap, methodRemap)
        Assert.True(scope_.Equals(RemapScope(classRemap, methodRemap)))
        Assert.Equal(scope_.GetHashCode(), RemapScope(classRemap, methodRemap).GetHashCode())
        Assert.False(scope_.Equals(RemapScope(Dictionary[TypeParameterSymbol, int32](), methodRemap)))
        Assert.False(scope_.Equals(RemapScope(classRemap, Dictionary[TypeParameterSymbol, int32]())))
        Assert.True(default(RemapScope).Equals(RemapScope(nil, nil)))
    }
}
