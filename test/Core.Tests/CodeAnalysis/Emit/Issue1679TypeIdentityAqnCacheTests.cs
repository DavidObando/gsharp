// <copyright file="Issue1679TypeIdentityAqnCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Emit;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #1679: <see cref="TypeIdentityComparer"/> used to rebuild each
/// <see cref="Type"/>'s assembly-qualified-name key from scratch on every
/// <c>Equals</c>/<c>GetHashCode</c> call — including cache hits against the
/// <c>TypeRefs</c>/<c>TypeSpecs</c> dictionaries it backs. The fix memoizes
/// the key per <see cref="Type"/> instance in a
/// <see cref="ConditionalWeakTable{TKey, TValue}"/>. These tests pin that the
/// memoization is transparent to observers (identical Equals/GetHashCode
/// results before and after caching kicks in) for the representative type
/// shapes called out in the issue — generics, arrays, nested types, and
/// types reached through distinct <c>MetadataLoadContext</c> instances — and
/// that the cache is actually populated (not merely a no-op wrapper).
/// </summary>
public class Issue1679TypeIdentityAqnCacheTests
{
    private class OuterHolder
    {
        public class NestedType
        {
        }
    }

    private static readonly FieldInfo KeyCacheField = typeof(TypeIdentityComparer)
        .GetField("KeyCache", BindingFlags.NonPublic | BindingFlags.Static);

    [Fact]
    public void GetHashCode_IsStable_AcrossRepeatedCallsOnSameInstance()
    {
        // First call populates the cache; subsequent calls must return the
        // exact same hash (memoization must not change observable behavior).
        var type = typeof(Dictionary<string, List<int>>);
        var first = TypeIdentityComparer.Instance.GetHashCode(type);
        var second = TypeIdentityComparer.Instance.GetHashCode(type);
        var third = TypeIdentityComparer.Instance.GetHashCode(type);

        Assert.Equal(first, second);
        Assert.Equal(second, third);
    }

    [Fact]
    public void Equals_And_GetHashCode_PreservedForConstructedGenerics()
    {
        var a = typeof(Dictionary<string, List<int>>);
        var b = typeof(Dictionary<string, List<int>>);

        Assert.True(TypeIdentityComparer.Instance.Equals(a, b));
        Assert.Equal(
            TypeIdentityComparer.Instance.GetHashCode(a),
            TypeIdentityComparer.Instance.GetHashCode(b));

        // A different generic argument must remain distinct.
        var c = typeof(Dictionary<string, List<long>>);
        Assert.False(TypeIdentityComparer.Instance.Equals(a, c));
    }

    [Fact]
    public void Equals_And_GetHashCode_PreservedForArrays()
    {
        var a1 = typeof(int[]);
        var a2 = typeof(int[]);
        var jagged = typeof(int[][]);
        var rank2 = typeof(int[,]);
        var strings = typeof(string[]);

        Assert.True(TypeIdentityComparer.Instance.Equals(a1, a2));
        Assert.Equal(
            TypeIdentityComparer.Instance.GetHashCode(a1),
            TypeIdentityComparer.Instance.GetHashCode(a2));

        Assert.False(TypeIdentityComparer.Instance.Equals(a1, jagged));
        Assert.False(TypeIdentityComparer.Instance.Equals(a1, rank2));
        Assert.False(TypeIdentityComparer.Instance.Equals(a1, strings));
    }

    [Fact]
    public void Equals_And_GetHashCode_PreservedForNestedTypes()
    {
        var a = typeof(OuterHolder.NestedType);
        var b = typeof(OuterHolder.NestedType);

        Assert.True(TypeIdentityComparer.Instance.Equals(a, b));
        Assert.Equal(
            TypeIdentityComparer.Instance.GetHashCode(a),
            TypeIdentityComparer.Instance.GetHashCode(b));

        // Nested type must remain distinct from its declaring (outer) type.
        Assert.False(TypeIdentityComparer.Instance.Equals(a, typeof(OuterHolder)));
    }

    [Fact]
    public void Equals_And_GetHashCode_PreservedAcrossMetadataLoadContexts()
    {
        // Same repro as TypeRefDeduplicationTests, but covering constructed
        // generics reached through two distinct MetadataLoadContext
        // instances, to make sure memoizing the key per-Type-instance still
        // lets structurally-identical (but reference-distinct) generic
        // instantiations compare equal.
        var coreAssemblies = Directory
            .GetFiles(System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory(), "*.dll")
            .ToList();

        using var ctxA = new MetadataLoadContext(new PathAssemblyResolver(coreAssemblies));
        using var ctxB = new MetadataLoadContext(new PathAssemblyResolver(coreAssemblies));

        var listOfObjectA = ctxA.CoreAssembly!.GetType("System.Collections.Generic.List`1")
            !.MakeGenericType(ctxA.CoreAssembly!.GetType("System.String")!);
        var listOfObjectB = ctxB.CoreAssembly!.GetType("System.Collections.Generic.List`1")
            !.MakeGenericType(ctxB.CoreAssembly!.GetType("System.String")!);

        Assert.NotSame(listOfObjectA, listOfObjectB);
        Assert.True(TypeIdentityComparer.Instance.Equals(listOfObjectA, listOfObjectB));
        Assert.Equal(
            TypeIdentityComparer.Instance.GetHashCode(listOfObjectA),
            TypeIdentityComparer.Instance.GetHashCode(listOfObjectB));
    }

    [Fact]
    public void KeyCache_IsPopulated_AfterFirstProbe()
    {
        // Confirms the memoization is real (not a dead field): after a single
        // Equals/GetHashCode call for a fresh Type, the ConditionalWeakTable
        // holds an entry for it.
        Assert.NotNull(KeyCacheField);

        var cache = KeyCacheField.GetValue(null);
        Assert.NotNull(cache);

        var tryGetValue = cache.GetType().GetMethod("TryGetValue");
        Assert.NotNull(tryGetValue);

        // Use a type unlikely to have been probed by any earlier test in this
        // run, so we can observe the cache transition from empty to populated
        // for this specific key.
        var type = typeof(Issue1679TypeIdentityAqnCacheTests);

        var argsBefore = new object[] { type, null };
        var foundBefore = (bool)tryGetValue.Invoke(cache, argsBefore);

        TypeIdentityComparer.Instance.GetHashCode(type);

        var argsAfter = new object[] { type, null };
        var foundAfter = (bool)tryGetValue.Invoke(cache, argsAfter);

        Assert.False(foundBefore);
        Assert.True(foundAfter);
        Assert.Equal(type.AssemblyQualifiedName, (string)argsAfter[1]);
    }

    [Fact]
    public void NullHandling_Unchanged()
    {
        Assert.True(TypeIdentityComparer.Instance.Equals(null, null));
        Assert.False(TypeIdentityComparer.Instance.Equals(null, typeof(int)));
        Assert.False(TypeIdentityComparer.Instance.Equals(typeof(int), null));
        Assert.Throws<ArgumentNullException>(() => TypeIdentityComparer.Instance.GetHashCode(null));
    }
}
