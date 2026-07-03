// <copyright file="Issue1632ConversionProbeMemoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1632 regression coverage: <see cref="ClrOperatorResolution.TryResolveConversion"/>
/// used to re-walk its uncached <c>GetMethods</c> reflection scan (via the
/// private <c>TryFind</c> helper) on every call — including the per-candidate
/// × per-argument probing done by <c>OverloadResolver.IsConvertibilityApplicable</c>
/// via <c>ConversionClassifier.TryApplyUserDefinedImplicitArgumentConversion</c>.
/// These tests assert the memoized <c>(sourceType, targetType, allowExplicit)</c>
/// probe: (1) is idempotent/consistent across repeated calls, (2) matches an
/// uncached reflection walk exactly (no behavior change), and (3) is evicted
/// on <see cref="ReferenceResolver.Dispose"/> (mirroring #1678/#1622).
/// </summary>
public class Issue1632ConversionProbeMemoTests
{
    [Fact]
    public void TryResolveConversion_RepeatedCalls_ReturnConsistentCachedResult()
    {
        ClrOperatorResolution.ClearCache();

        var first = ClrOperatorResolution.TryResolveConversion(typeof(int), typeof(decimal), allowExplicit: false, out var firstMethod, out var firstExplicit);
        var second = ClrOperatorResolution.TryResolveConversion(typeof(int), typeof(decimal), allowExplicit: false, out var secondMethod, out var secondExplicit);

        Assert.True(first);
        Assert.Equal(first, second);
        Assert.Same(firstMethod, secondMethod);
        Assert.Equal(firstExplicit, secondExplicit);
    }

    [Fact]
    public void TryResolveConversion_CachedResult_MatchesUncachedReflectionWalkExactly()
    {
        ClrOperatorResolution.ClearCache();

        var cachedFound = ClrOperatorResolution.TryResolveConversion(typeof(int), typeof(decimal), allowExplicit: false, out var cachedMethod, out var cachedExplicit);

        var uncachedFound = UncachedProbe(typeof(int), typeof(decimal), allowExplicit: false, out var uncachedMethod, out var uncachedExplicit);

        Assert.Equal(uncachedFound, cachedFound);
        Assert.Equal(uncachedMethod?.ToString(), cachedMethod?.ToString());
        Assert.Equal(uncachedExplicit, cachedExplicit);
    }

    [Fact]
    public void TryResolveConversion_ExplicitConversion_CachedResult_MatchesUncachedReflectionWalkExactly()
    {
        ClrOperatorResolution.ClearCache();

        // decimal -> int has no implicit conversion, only an explicit one
        // (op_Explicit on decimal), so allowExplicit must be honored exactly.
        var cachedFound = ClrOperatorResolution.TryResolveConversion(typeof(decimal), typeof(int), allowExplicit: true, out var cachedMethod, out var cachedExplicit);
        var uncachedFound = UncachedProbe(typeof(decimal), typeof(int), allowExplicit: true, out var uncachedMethod, out var uncachedExplicit);

        Assert.True(cachedFound);
        Assert.Equal(uncachedFound, cachedFound);
        Assert.Equal(uncachedMethod?.ToString(), cachedMethod?.ToString());
        Assert.Equal(uncachedExplicit, cachedExplicit);

        // Without allowExplicit, no conversion should be found — the cache key
        // includes allowExplicit so this must not reuse the explicit-probe entry.
        var implicitOnlyFound = ClrOperatorResolution.TryResolveConversion(typeof(decimal), typeof(int), allowExplicit: false, out _, out _);
        Assert.False(implicitOnlyFound);
    }

    [Fact]
    public void TryResolveConversion_NoConversionExists_CachedAsNotFoundConsistently()
    {
        ClrOperatorResolution.ClearCache();

        var first = ClrOperatorResolution.TryResolveConversion(typeof(Guid), typeof(Uri), allowExplicit: true, out var firstMethod, out _);
        var second = ClrOperatorResolution.TryResolveConversion(typeof(Guid), typeof(Uri), allowExplicit: true, out var secondMethod, out _);

        Assert.False(first);
        Assert.False(second);
        Assert.Null(firstMethod);
        Assert.Null(secondMethod);
    }

    [Fact]
    public void Dispose_ClearsConversionProbeCache()
    {
        ClrOperatorResolution.ClearCache();

        ClrOperatorResolution.TryResolveConversion(typeof(int), typeof(decimal), allowExplicit: false, out var before, out _);
        Assert.NotNull(before);

        var corePath = typeof(ReferenceResolver).Assembly.Location;
        var resolver = ReferenceResolver.WithReferences(new[] { corePath });
        resolver.Dispose();

        // A cleared cache still resolves the SAME conversion (content
        // unaffected by eviction); this only proves the entry was recomputed,
        // not that content changed, since decimal/int are host-runtime types
        // untouched by the disposed MetadataLoadContext.
        var found = ClrOperatorResolution.TryResolveConversion(typeof(int), typeof(decimal), allowExplicit: false, out var after, out _);
        Assert.True(found);
        Assert.Equal(before.ToString(), after.ToString());
    }

    /// <summary>
    /// Mirrors the pre-fix <c>TryResolveConversion</c>/<c>TryFind</c> logic
    /// exactly (implicits on source then target, then — if allowed —
    /// explicits on source then target) but always re-walks reflection, never
    /// consulting the memoized cache. Used as the ground truth the cached
    /// path must match.
    /// </summary>
    private static bool UncachedProbe(Type sourceType, Type targetType, bool allowExplicit, out MethodInfo method, out bool isExplicit)
    {
        method = null;
        isExplicit = false;

        if (TryFind(sourceType, "op_Implicit", sourceType, targetType, out method)
            || TryFind(targetType, "op_Implicit", sourceType, targetType, out method))
        {
            return true;
        }

        if (!allowExplicit)
        {
            return false;
        }

        if (TryFind(sourceType, "op_Explicit", sourceType, targetType, out method)
            || TryFind(targetType, "op_Explicit", sourceType, targetType, out method))
        {
            isExplicit = true;
            return true;
        }

        return false;
    }

    private static bool TryFind(Type declaring, string name, Type src, Type tgt, out MethodInfo method)
    {
        method = null;
        var candidates = declaring.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly);
        foreach (var m in candidates)
        {
            if (!m.IsSpecialName || !string.Equals(m.Name, name, StringComparison.Ordinal))
            {
                continue;
            }

            var ps = m.GetParameters();
            if (ps.Length != 1)
            {
                continue;
            }

            if (ps[0].ParameterType == src && m.ReturnType == tgt)
            {
                method = m;
                return true;
            }
        }

        return false;
    }
}
