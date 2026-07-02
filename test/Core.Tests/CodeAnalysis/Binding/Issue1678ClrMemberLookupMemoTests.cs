// <copyright file="Issue1678ClrMemberLookupMemoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1678 regression coverage: CLR member lookup (<see cref="ClrTypeUtilities.SafeGetMethods"/>,
/// <see cref="ClrTypeUtilities.SafeGetInterfaces"/>, and
/// <see cref="MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces"/>) used to
/// re-enumerate every method / every transitive interface method on every
/// call, with no memoization, so a type used at N call sites paid N full
/// reflection walks. These tests assert:
/// <list type="bullet">
/// <item>repeated lookups for the same (type, flags) / (type, name) return
/// the identical cached instance instead of re-enumerating,</item>
/// <item>the cached result is identical in content and order to what a fresh
/// per-call-site enumeration would produce (no behavior change), and</item>
/// <item>the caches are evicted on <see cref="ReferenceResolver.Dispose"/>
/// (mirroring the #1622 process-wide cache eviction) so entries keyed on a
/// disposed <c>MetadataLoadContext</c>'s <see cref="System.Type"/> instances
/// do not pin that context's memory for the process lifetime.</item>
/// </list>
/// </summary>
public class Issue1678ClrMemberLookupMemoTests
{
    [Fact]
    public void SafeGetMethods_RepeatedCalls_ReturnSameCachedInstance()
    {
        ClrTypeUtilities.ClearCache();

        var first = ClrTypeUtilities.SafeGetMethods(typeof(List<int>), BindingFlags.Public | BindingFlags.Instance);
        var second = ClrTypeUtilities.SafeGetMethods(typeof(List<int>), BindingFlags.Public | BindingFlags.Instance);

        Assert.Same(first, second);
    }

    [Fact]
    public void SafeGetMethods_ClearCache_EvictsEntry()
    {
        ClrTypeUtilities.ClearCache();

        var before = ClrTypeUtilities.SafeGetMethods(typeof(List<int>), BindingFlags.Public | BindingFlags.Instance);
        ClrTypeUtilities.ClearCache();
        var after = ClrTypeUtilities.SafeGetMethods(typeof(List<int>), BindingFlags.Public | BindingFlags.Instance);

        Assert.NotSame(before, after);

        // Content must remain identical — the cache changes identity, not results.
        Assert.Equal(before.Select(m => m.ToString()), after.Select(m => m.ToString()));
    }

    [Fact]
    public void SafeGetMethods_CachedResult_MatchesUncachedReflectionExactly()
    {
        ClrTypeUtilities.ClearCache();

        var cached = ClrTypeUtilities.SafeGetMethods(typeof(List<int>), BindingFlags.Public | BindingFlags.Instance);
        var direct = typeof(List<int>).GetMethods(BindingFlags.Public | BindingFlags.Instance);

        // Same members, same order — SafeGetMethods only filters out members
        // whose signature cannot load (never true here for a live runtime
        // type), so the two sequences must match one-for-one.
        Assert.Equal(direct.Select(m => m.ToString()), cached.Select(m => m.ToString()));
    }

    [Fact]
    public void SafeGetInterfaces_RepeatedCalls_ReturnSameCachedInstance()
    {
        ClrTypeUtilities.ClearCache();

        var first = ClrTypeUtilities.SafeGetInterfaces(typeof(List<int>));
        var second = ClrTypeUtilities.SafeGetInterfaces(typeof(List<int>));

        Assert.Same(first, second);
    }

    [Fact]
    public void SafeGetInterfaces_ClearCache_EvictsEntry()
    {
        ClrTypeUtilities.ClearCache();

        var before = ClrTypeUtilities.SafeGetInterfaces(typeof(List<int>));
        ClrTypeUtilities.ClearCache();
        var after = ClrTypeUtilities.SafeGetInterfaces(typeof(List<int>));

        Assert.NotSame(before, after);
        Assert.Equal(before.Select(t => t.FullName), after.Select(t => t.FullName));
    }

    [Fact]
    public void SafeGetMethodsIncludingSelfAndInterfaces_RepeatedCalls_ReturnSameCachedInstance()
    {
        ClrTypeUtilities.ClearCache();
        MemberLookup.ClearCache();

        var first = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(List<int>), "Add");
        var second = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(List<int>), "Add");

        Assert.Same(first, second);
        Assert.NotEmpty(first);
    }

    [Fact]
    public void SafeGetMethodsIncludingSelfAndInterfaces_ClearCache_EvictsEntry()
    {
        ClrTypeUtilities.ClearCache();
        MemberLookup.ClearCache();

        var before = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(List<int>), "Add");
        MemberLookup.ClearCache();
        var after = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(List<int>), "Add");

        Assert.NotSame(before, after);
        Assert.Equal(before.Select(m => m.ToString()), after.Select(m => m.ToString()));
    }

    [Fact]
    public void SafeGetMethodsIncludingSelfAndInterfaces_DifferentNames_AreCachedIndependently()
    {
        ClrTypeUtilities.ClearCache();
        MemberLookup.ClearCache();

        var add = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(List<int>), "Add");
        var clear = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(List<int>), "Clear");

        Assert.All(add, m => Assert.Equal("Add", m.Name));
        Assert.All(clear, m => Assert.Equal("Clear", m.Name));
    }

    [Fact]
    public void Dispose_ClearsClrMemberLookupCaches()
    {
        ClrTypeUtilities.ClearCache();
        MemberLookup.ClearCache();

        var methodsBefore = ClrTypeUtilities.SafeGetMethods(typeof(Dictionary<string, int>), BindingFlags.Public | BindingFlags.Instance);
        var interfacesBefore = ClrTypeUtilities.SafeGetInterfaces(typeof(Dictionary<string, int>));
        var includingBefore = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(Dictionary<string, int>), "Add");

        var corePath = typeof(ReferenceResolver).Assembly.Location;
        var resolver = ReferenceResolver.WithReferences(new[] { corePath });
        resolver.Dispose();

        var methodsAfter = ClrTypeUtilities.SafeGetMethods(typeof(Dictionary<string, int>), BindingFlags.Public | BindingFlags.Instance);
        var interfacesAfter = ClrTypeUtilities.SafeGetInterfaces(typeof(Dictionary<string, int>));
        var includingAfter = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(Dictionary<string, int>), "Add");

        Assert.NotSame(methodsBefore, methodsAfter);
        Assert.NotSame(interfacesBefore, interfacesAfter);
        Assert.NotSame(includingBefore, includingAfter);
    }
}
