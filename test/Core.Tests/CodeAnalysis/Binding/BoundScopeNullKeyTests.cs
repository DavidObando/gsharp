// <copyright file="BoundScopeNullKeyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public class BoundScopeNullKeyTests
{
    // A null symbol name must never reach a Dictionary key, which would throw
    // ArgumentNullException ("Value cannot be null. (Parameter 'key')") and crash the
    // whole language-server request (diagnostics, inlay hints, semantic tokens, code lens).
    [Fact]
    public void TryLookupSymbol_NullName_ReturnsNullWithoutThrowing()
    {
        var scope = new BoundScope(null, ReferenceResolver.Default());

        var result = scope.TryLookupSymbol(null);

        Assert.Null(result);
    }

    [Fact]
    public void TryLookupTypeAlias_NullName_ReturnsFalseWithoutThrowing()
    {
        var scope = new BoundScope(null, ReferenceResolver.Default());

        var found = scope.TryLookupTypeAlias(null, out var type);

        Assert.False(found);
        Assert.Null(type);
    }

    [Fact]
    public void TryDeclareTypeAlias_NullName_ReturnsFalseWithoutThrowing()
    {
        var scope = new BoundScope(null, ReferenceResolver.Default());

        var declared = scope.TryDeclareTypeAlias(null, TypeSymbol.Int32);

        Assert.False(declared);
    }
}
