// <copyright file="ReferenceResolverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Tests for <see cref="ReferenceResolver"/>, the seam that <c>import</c>
/// statements use to resolve CLR types.
/// </summary>
public class ReferenceResolverTests
{
    [Theory]
    [InlineData("System.Console")]
    [InlineData("System.String")]
    public void Default_Resolves_Bcl_Type(string fullName)
    {
        var resolver = ReferenceResolver.Default();
        Assert.True(resolver.TryResolveType(fullName, out var type));
        Assert.Equal(fullName, type.FullName);
    }

    [Fact]
    public void Default_Returns_False_For_Unknown_Type()
    {
        var resolver = ReferenceResolver.Default();
        Assert.False(resolver.TryResolveType("System.ThisTypeDoesNotExist", out var type));
        Assert.Null(type);
    }

    [Fact]
    public void WithReferences_Resolves_Type_From_Supplied_Assembly()
    {
        var corePath = typeof(ReferenceResolver).Assembly.Location;
        Assert.False(string.IsNullOrEmpty(corePath));

        var resolver = ReferenceResolver.WithReferences(new[] { corePath });
        Assert.True(resolver.TryResolveType("GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver", out var type));
        Assert.Equal(typeof(ReferenceResolver).FullName, type.FullName);
    }

    [Fact]
    public void WithReferences_Tolerates_Null_Or_Missing_Paths()
    {
        var resolver = ReferenceResolver.WithReferences(new[]
        {
            string.Empty,
            "/this/path/does/not/exist.dll",
        });

        Assert.True(resolver.TryResolveType("System.Console", out _));
    }
}
