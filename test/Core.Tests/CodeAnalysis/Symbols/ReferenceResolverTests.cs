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

    [Fact]
    public void Default_MapClrTypeToReferences_Returns_Host_Type_Unchanged()
    {
        var resolver = ReferenceResolver.Default();

        // With no MetadataLoadContext the host type already has the right
        // identity, so the projection is a no-op (reference-equal).
        Assert.Same(typeof(int), resolver.MapClrTypeToReferences(typeof(int)));
        Assert.Same(typeof(string), resolver.MapClrTypeToReferences(typeof(string)));
        Assert.Null(resolver.MapClrTypeToReferences(null));
    }

    [Theory]
    [InlineData(typeof(int))]
    [InlineData(typeof(bool))]
    [InlineData(typeof(double))]
    [InlineData(typeof(System.DateTime))]
    [InlineData(typeof(System.Guid))]
    [InlineData(typeof(string))]
    public void MapClrTypeToReferences_Lets_Open_Generic_Construct_Under_MetadataLoadContext(Type elementType)
    {
        // Regression for issue #290. When references are loaded through a
        // MetadataLoadContext (the SDK build path), an open generic resolved
        // from those references rejects a host-runtime type argument:
        // MakeGenericType demands every argument come from the SAME context.
        var resolver = BuildMetadataLoadContextResolver();
        Assert.True(resolver.TryResolveType("System.Threading.Tasks.Task`1", out var openTask));

        // Sanity check: the bug. A host-runtime type argument is rejected.
        Assert.Throws<ArgumentException>(() => openTask.MakeGenericType(elementType));

        // The fix: projecting the host type through the resolver yields a
        // context-compatible argument, so Task<T> constructs successfully.
        var projected = resolver.MapClrTypeToReferences(elementType);
        var closed = openTask.MakeGenericType(projected);

        Assert.Equal("System.Threading.Tasks.Task`1", closed.GetGenericTypeDefinition().FullName);
        Assert.Equal(elementType.FullName, closed.GetGenericArguments()[0].FullName);
    }

    [Fact]
    public void MapClrTypeToReferences_Projects_Nested_Generic_Arguments()
    {
        // Constructed generics and arrays must be projected element-by-element
        // so nested type arguments are also pulled into the load context.
        var resolver = BuildMetadataLoadContextResolver();
        Assert.True(resolver.TryResolveType("System.Threading.Tasks.Task`1", out var openTask));

        var projectedList = resolver.MapClrTypeToReferences(typeof(System.Collections.Generic.List<int>));
        var closed = openTask.MakeGenericType(projectedList);
        Assert.Equal(
            typeof(System.Collections.Generic.List<int>).FullName,
            closed.GetGenericArguments()[0].FullName);

        var projectedArray = resolver.MapClrTypeToReferences(typeof(int[]));
        Assert.True(projectedArray.IsArray);
        Assert.Equal(typeof(int[]).FullName, projectedArray.FullName);
    }

    private static ReferenceResolver BuildMetadataLoadContextResolver()
    {
        // Supplying explicit assembly paths forces ReferenceResolver to load
        // them into an isolated MetadataLoadContext, mirroring the SDK build.
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Threading.Tasks.Task<>).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
            typeof(System.Console).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }
}
