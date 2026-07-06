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

    /// <summary>
    /// An <c>internal</c> (non-externally-visible) type declared by a referenced
    /// assembly that does not grant this compilation friendship must not satisfy
    /// a type reference by name — matching C# accessibility. Regression for the
    /// bug where an unqualified <c>ThisAssembly</c> bound to the framework-internal
    /// <c>System.Diagnostics.ThisAssembly</c> (whose <c>AssemblyFileVersion</c> is a
    /// <see cref="System.Version"/>) instead of failing to resolve.
    /// </summary>
    [Fact]
    public void WithReferences_Does_Not_Resolve_Internal_Type_By_Name()
    {
        var asm = typeof(System.Diagnostics.DiagnosticSource).Assembly;
        var path = asm.Location;
        Assert.False(string.IsNullOrEmpty(path));

        // Any top-level internal type the assembly actually declares.
        var internalType = asm
            .GetTypes()
            .FirstOrDefault(t => t.IsNotPublic && !t.IsNested && t.FullName is not null);
        Assert.NotNull(internalType);

        var resolver = ReferenceResolver.WithReferences(new[] { path });

        // CurrentAssemblyName is unset, so no InternalsVisibleTo friendship is
        // granted and the internal type is unreachable by name.
        Assert.False(resolver.TryResolveType(internalType.FullName, out var resolved));
        Assert.Null(resolved);

        // A public type in the same assembly still resolves — the accessibility
        // gate must not over-block externally visible types.
        Assert.True(resolver.TryResolveType(
            typeof(System.Diagnostics.DiagnosticSource).FullName,
            out _));
    }

    [Fact]
    public void TryResolveType_WithoutExternalVisibility_Resolves_Internal_Type_By_Name()
    {
        // The emitter/lowering infrastructure resolves well-known types by exact
        // name — including compiler-internal attributes such as NullableAttribute
        // / IsReadOnlyAttribute — and must be able to bypass the accessibility
        // gate that guards user-written type references. Regression guard: a too-
        // aggressive gate dropped these lookups, silently stripping nullable /
        // readonly metadata from emitted assemblies.
        var asm = typeof(System.Diagnostics.DiagnosticSource).Assembly;
        var path = asm.Location;
        Assert.False(string.IsNullOrEmpty(path));

        var internalType = asm
            .GetTypes()
            .FirstOrDefault(t => t.IsNotPublic && !t.IsNested && t.FullName is not null);
        Assert.NotNull(internalType);

        var resolver = ReferenceResolver.WithReferences(new[] { path });

        // Gated (user-facing) path: internal type is unreachable by name.
        Assert.False(resolver.TryResolveType(internalType.FullName, out _));

        // Ungated (infrastructure) path: the same internal type resolves.
        Assert.True(resolver.TryResolveType(
            internalType.FullName,
            requireExternalVisibility: false,
            out var resolved));
        Assert.NotNull(resolved);
        Assert.Equal(internalType.FullName, resolved.FullName);

        // The bypass overload still resolves externally visible types.
        Assert.True(resolver.TryResolveType(
            typeof(System.Diagnostics.DiagnosticSource).FullName,
            requireExternalVisibility: false,
            out _));
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

    [Fact]
    public void MapClrTypeToReferences_Projects_ByRef_Types()
    {
        var resolver = BuildMetadataLoadContextResolver();

        var projected = resolver.MapClrTypeToReferences(typeof(int).MakeByRefType());

        Assert.True(projected.IsByRef);
        var element = projected.GetElementType();
        Assert.Equal(typeof(int).FullName, element.FullName);

        // The projected element must share the load context, so an open generic
        // resolved from the references accepts it.
        Assert.True(resolver.TryResolveType("System.Threading.Tasks.Task`1", out var openTask));
        var closed = openTask.MakeGenericType(element);
        Assert.Equal(typeof(int).FullName, closed.GetGenericArguments()[0].FullName);
    }

    [Fact]
    public void MapClrTypeToReferences_Projects_Pointer_Types()
    {
        var resolver = BuildMetadataLoadContextResolver();

        var projected = resolver.MapClrTypeToReferences(typeof(int).MakePointerType());

        Assert.True(projected.IsPointer);
        Assert.Equal(typeof(int).FullName, projected.GetElementType().FullName);
    }

    [Fact]
    public void MapClrTypeToReferences_Projects_Array_Of_ByRef_Element_Chain()
    {
        // Byref-to-array: the inner array element must also be projected.
        var resolver = BuildMetadataLoadContextResolver();

        var projected = resolver.MapClrTypeToReferences(typeof(int[]).MakeByRefType());

        Assert.True(projected.IsByRef);
        var arrayElement = projected.GetElementType();
        Assert.True(arrayElement.IsArray);
        Assert.Equal(typeof(int[]).FullName, arrayElement.FullName);
    }

    [Fact]
    public void MapClrTypeToReferences_Passes_Through_Generic_Parameters()
    {
        var resolver = BuildMetadataLoadContextResolver();
        Assert.True(resolver.TryResolveType("System.Collections.Generic.List`1", out var openList));

        var genericParameter = openList.GetGenericArguments()[0];
        Assert.True(genericParameter.IsGenericParameter);

        // A generic parameter is meaningful only relative to its already-mapped
        // declaring definition; projection passes it through unchanged.
        var projected = resolver.MapClrTypeToReferences(genericParameter);
        Assert.Same(genericParameter, projected);
    }

    [Fact]
    public void MapClrTypeToReferences_Throws_Instead_Of_Silent_Host_Fallback()
    {
        // A type that cannot be resolved by name from the supplied references
        // (it is defined only in the host's test assembly) must surface as an
        // explicit error rather than silently returning the wrong-context host
        // type, which would fail opaquely later inside MakeGenericType.
        var resolver = BuildMetadataLoadContextResolver();

        var ex = Assert.Throws<InvalidOperationException>(
            () => resolver.MapClrTypeToReferences(typeof(ReferenceResolverTests)));

        Assert.Contains(typeof(ReferenceResolverTests).ToString(), ex.Message);
    }

    [Fact]
    public void TryResolveType_CachesHitsAndMissesForLifetimeOfResolver()
    {
        // Hot-path optimization: language-server binding issues thousands of
        // TryResolveType calls for the same name. Each uncached call iterates
        // every assembly in the reference set (~216 entries on a typical .NET
        // project) and is observably slow (~0.1ms per miss). The resolver
        // memoizes hits AND misses so the second lookup is O(1).
        var resolver = BuildMetadataLoadContextResolver();

        Assert.True(resolver.TryResolveType("System.String", out var first));
        Assert.True(resolver.TryResolveType("System.String", out var second));
        Assert.Same(first, second);

        Assert.False(resolver.TryResolveType("Foo.Bar.NotARealType", out var missFirst));
        Assert.False(resolver.TryResolveType("Foo.Bar.NotARealType", out var missSecond));
        Assert.Null(missFirst);
        Assert.Null(missSecond);
    }

    [Fact]
    public void TryResolveType_ResolvesTypesAcrossEverySuppliedAssembly()
    {
        // Issue #854: TryResolveType is backed by a full-name index built once
        // over the entire reference set. This guards the property the previous
        // per-assembly scan guaranteed — that a name defined in *any* supplied
        // assembly resolves, not just the first — so the index must span every
        // assembly. System.String lives in the core library, System.Console in
        // System.Console.dll, and Task`1 in System.Private.CoreLib/Threading,
        // covering distinct assemblies in the supplied set.
        var resolver = BuildMetadataLoadContextResolver();

        Assert.True(resolver.TryResolveType("System.String", out var stringType));
        Assert.True(resolver.TryResolveType("System.Console", out var consoleType));
        Assert.True(resolver.TryResolveType("System.Collections.Generic.List`1", out var listType));

        Assert.NotNull(stringType);
        Assert.NotNull(consoleType);
        Assert.NotNull(listType);

        // Types must originate from the resolver's isolated MetadataLoadContext,
        // not the gsc host runtime (a regression here would reintroduce the
        // cross-context identity mismatches the resolver exists to prevent).
        Assert.NotSame(typeof(string), stringType);
        Assert.NotSame(typeof(System.Console), consoleType);
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
