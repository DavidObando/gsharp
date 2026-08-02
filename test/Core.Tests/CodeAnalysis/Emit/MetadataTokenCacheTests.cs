// <copyright file="MetadataTokenCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public class MetadataTokenCacheTests
{
    [Fact]
    public void CtorRefSymbolKey_EqualsDistinguishesRemapIdentities()
    {
        var ctor = typeof(List<>).GetConstructors().Single(c => c.GetParameters().Length == 0);
        var typeArgs = ImmutableArray<TypeSymbol>.Empty;
        var classRemap = new Dictionary<TypeParameterSymbol, int>();
        var methodRemap = new Dictionary<TypeParameterSymbol, int>();
        var key = new MetadataTokenCache.CtorRefSymbolKey(ctor, typeArgs, classRemap, methodRemap);

        Assert.False(key.Equals(new MetadataTokenCache.CtorRefSymbolKey(
            ctor,
            typeArgs,
            new Dictionary<TypeParameterSymbol, int>(),
            methodRemap)));
        Assert.False(key.Equals(new MetadataTokenCache.CtorRefSymbolKey(
            ctor,
            typeArgs,
            classRemap,
            new Dictionary<TypeParameterSymbol, int>())));
    }
}
