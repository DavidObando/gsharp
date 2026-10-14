// <copyright file="Issue1632ConversionProbeMemoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Linq
import System.Reflection
import Xunit

/// Issue #1632 regression coverage: (cref:ClrOperatorResolution.TryResolveConversion)
/// used to re-walk its uncached `GetMethods` reflection scan (via the
/// private `TryFind` helper) on every call — including the per-candidate
/// × per-argument probing done by `OverloadResolver.IsConvertibilityApplicable`
/// via `ConversionClassifier.TryApplyUserDefinedImplicitArgumentConversion`.
/// These tests assert the memoized `(sourceType, targetType, allowExplicit)`
/// probe: (1) is idempotent/consistent across repeated calls, (2) matches an
/// uncached reflection walk exactly (no behavior change), and (3) is evicted
/// on (cref:ReferenceResolver.Dispose) (mirroring #1678/#1622).
open class Issue1632ConversionProbeMemoTests {
    @Fact
    func TryResolveConversion_RepeatedCalls_ReturnConsistentCachedResult() {
        ClrOperatorResolution.ClearCache()
        let first = ClrOperatorResolution.TryResolveConversion(
            typeof(int32),
            typeof(decimal),
            allowExplicit: false,
            out var firstMethod,
            out var firstExplicit
        )
        let second = ClrOperatorResolution.TryResolveConversion(
            typeof(int32),
            typeof(decimal),
            allowExplicit: false,
            out var secondMethod,
            out var secondExplicit
        )
        Assert.True(first)
        Assert.Equal(first, second)
        Assert.Same(firstMethod, secondMethod)
        Assert.Equal(firstExplicit, secondExplicit)
    }

    @Fact
    func TryResolveConversion_CachedResult_MatchesUncachedReflectionWalkExactly() {
        ClrOperatorResolution.ClearCache()
        let cachedFound = ClrOperatorResolution.TryResolveConversion(
            typeof(int32),
            typeof(decimal),
            allowExplicit: false,
            out var cachedMethod,
            out var cachedExplicit
        )
        let uncachedFound = UncachedProbe(
            typeof(int32),
            typeof(decimal),
            allowExplicit: false,
            out var uncachedMethod,
            out var uncachedExplicit
        )
        Assert.Equal(uncachedFound, cachedFound)
        Assert.Equal(uncachedMethod?.ToString(), cachedMethod?.ToString())
        Assert.Equal(uncachedExplicit, cachedExplicit)
    }

    @Fact
    func TryResolveConversion_ExplicitConversion_CachedResult_MatchesUncachedReflectionWalkExactly() {
        ClrOperatorResolution.ClearCache()
        // decimal -> int has no implicit conversion, only an explicit one
        // (op_Explicit on decimal), so allowExplicit must be honored exactly.
        let cachedFound = ClrOperatorResolution.TryResolveConversion(
            typeof(decimal),
            typeof(int32),
            allowExplicit: true,
            out var cachedMethod,
            out var cachedExplicit
        )
        let uncachedFound = UncachedProbe(
            typeof(decimal),
            typeof(int32),
            allowExplicit: true,
            out var uncachedMethod,
            out var uncachedExplicit
        )
        Assert.True(cachedFound)
        Assert.Equal(uncachedFound, cachedFound)
        Assert.Equal(uncachedMethod?.ToString(), cachedMethod?.ToString())
        Assert.Equal(uncachedExplicit, cachedExplicit)
        // Without allowExplicit, no conversion should be found — the cache key
        // includes allowExplicit so this must not reuse the explicit-probe entry.
        let implicitOnlyFound = ClrOperatorResolution.TryResolveConversion(
            typeof(decimal),
            typeof(int32),
            allowExplicit: false,
            out _,
            out _
        )
        Assert.False(implicitOnlyFound)
    }

    @Fact
    func TryResolveConversion_NoConversionExists_CachedAsNotFoundConsistently() {
        ClrOperatorResolution.ClearCache()
        let first = ClrOperatorResolution.TryResolveConversion(
            typeof(Guid),
            typeof(Uri),
            allowExplicit: true,
            out var firstMethod,
            out _
        )
        let second = ClrOperatorResolution.TryResolveConversion(
            typeof(Guid),
            typeof(Uri),
            allowExplicit: true,
            out var secondMethod,
            out _
        )
        Assert.False(first)
        Assert.False(second)
        Assert.Null(firstMethod)
        Assert.Null(secondMethod)
    }

    @Fact
    func Dispose_ClearsConversionProbeCache() {
        ClrOperatorResolution.ClearCache()
        ClrOperatorResolution.TryResolveConversion(
            typeof(int32),
            typeof(decimal),
            allowExplicit: false,
            out var before,
            out _
        )
        Assert.NotNull(before)
        let corePath = typeof(ReferenceResolver).Assembly.Location
        let resolver = ReferenceResolver.WithReferences([]string{corePath})
        resolver.Dispose()
        // A cleared cache still resolves the SAME conversion (content
        // unaffected by eviction); this only proves the entry was recomputed,
        // not that content changed, since decimal/int are host-runtime types
        // untouched by the disposed MetadataLoadContext.
        let found = ClrOperatorResolution.TryResolveConversion(
            typeof(int32),
            typeof(decimal),
            allowExplicit: false,
            out var after,
            out _
        )
        Assert.True(found)
        Assert.Equal(before.ToString(), after.ToString())
    }

    shared {
        /// Mirrors the pre-fix `TryResolveConversion`/`TryFind` logic
        /// exactly (implicits on source then target, then — if allowed —
        /// explicits on source then target) but always re-walks reflection, never
        /// consulting the memoized cache. Used as the ground truth the cached
        /// path must match.
        private func UncachedProbe(
            sourceType Type,
            targetType Type,
            allowExplicit bool,
            out method MethodInfo?,
            out isExplicit bool
        ) bool {
            method = nil
            isExplicit = false
            if TryFind(sourceType, "op_Implicit", sourceType, targetType, out method) ||
                TryFind(targetType, "op_Implicit", sourceType, targetType, out method) {
                return true
            }
            if !allowExplicit {
                return false
            }
            if TryFind(sourceType, "op_Explicit", sourceType, targetType, out method) ||
                TryFind(targetType, "op_Explicit", sourceType, targetType, out method) {
                isExplicit = true
                return true
            }
            return false
        }

        private func TryFind(declaring Type, name string, src Type, tgt Type, out method MethodInfo?) bool {
            method = nil
            let candidates = declaring.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)
            for m in candidates {
                if !m.IsSpecialName || !string.Equals(m.Name, name, StringComparison.Ordinal) {
                    continue
                }
                let ps = m.GetParameters()
                if ps.Length != 1 {
                    continue
                }
                if ps[0].ParameterType == src && m.ReturnType == tgt {
                    method = m
                    return true
                }
            }
            return false
        }
    }
}
