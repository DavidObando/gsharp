// <copyright file="Issue1678ClrMemberLookupMemoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import Xunit

/// Issue #1678 regression coverage: CLR member lookup ((cref:ClrTypeUtilities.SafeGetMethods),
/// (cref:ClrTypeUtilities.SafeGetInterfaces), and
/// (cref:MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces)) used to
/// re-enumerate every method / every transitive interface method on every
/// call, with no memoization, so a type used at N call sites paid N full
/// reflection walks. These tests assert:
/// - repeated lookups for the same (type, flags) / (type, name) return the identical cached instance
/// instead of re-enumerating,
/// - the cached result is identical in content and order to what a fresh per-call-site enumeration
/// would produce (no behavior change), and
/// - the caches are evicted on (cref:ReferenceResolver.Dispose) (mirroring the #1622 process-wide cache
/// eviction) so entries keyed on a disposed `MetadataLoadContext`'s (cref:System.Type) instances do not
/// pin that context's memory for the process lifetime.
open class Issue1678ClrMemberLookupMemoTests {
    @Fact
    func SafeGetMethods_RepeatedCalls_ReturnSameCachedInstance() {
        ClrTypeUtilities.ClearCache()
        let first = ClrTypeUtilities.SafeGetMethods(typeof(List[int32]), BindingFlags.Public | BindingFlags.Instance)
        let second = ClrTypeUtilities.SafeGetMethods(typeof(List[int32]), BindingFlags.Public | BindingFlags.Instance)
        Assert.Same(first, second)
    }

    @Fact
    func SafeGetMethods_ClearCache_EvictsEntry() {
        ClrTypeUtilities.ClearCache()
        let before = ClrTypeUtilities.SafeGetMethods(typeof(List[int32]), BindingFlags.Public | BindingFlags.Instance)
        ClrTypeUtilities.ClearCache()
        let after = ClrTypeUtilities.SafeGetMethods(typeof(List[int32]), BindingFlags.Public | BindingFlags.Instance)
        Assert.NotSame(before, after)
        // Content must remain identical — the cache changes identity, not results.
        Assert.Equal(before.Select((m MethodInfo) -> m.ToString()), after.Select((m MethodInfo) -> m.ToString()))
    }

    @Fact
    func SafeGetMethods_CachedResult_MatchesUncachedReflectionExactly() {
        ClrTypeUtilities.ClearCache()
        let cached = ClrTypeUtilities.SafeGetMethods(typeof(List[int32]), BindingFlags.Public | BindingFlags.Instance)
        let direct = typeof(List[int32]).GetMethods(BindingFlags.Public | BindingFlags.Instance)
        // Same members, same order — SafeGetMethods only filters out members
        // whose signature cannot load (never true here for a live runtime
        // type), so the two sequences must match one-for-one.
        Assert.Equal(direct.Select((m MethodInfo) -> m.ToString()), cached.Select((m MethodInfo) -> m.ToString()))
    }

    @Fact
    func SafeGetInterfaces_RepeatedCalls_ReturnSameCachedInstance() {
        ClrTypeUtilities.ClearCache()
        let first = ClrTypeUtilities.SafeGetInterfaces(typeof(List[int32]))
        let second = ClrTypeUtilities.SafeGetInterfaces(typeof(List[int32]))
        Assert.Same(first, second)
    }

    @Fact
    func SafeGetInterfaces_ClearCache_EvictsEntry() {
        ClrTypeUtilities.ClearCache()
        let before = ClrTypeUtilities.SafeGetInterfaces(typeof(List[int32]))
        ClrTypeUtilities.ClearCache()
        let after = ClrTypeUtilities.SafeGetInterfaces(typeof(List[int32]))
        Assert.NotSame(before, after)
        Assert.Equal(before.Select((t Type) -> t.FullName), after.Select((t Type) -> t.FullName))
    }

    @Fact
    func SafeGetMethodsIncludingSelfAndInterfaces_RepeatedCalls_ReturnSameCachedInstance() {
        ClrTypeUtilities.ClearCache()
        MemberLookup.ClearCache()
        let first = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(List[int32]), "Add")
        let second = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(List[int32]), "Add")
        Assert.Same(first, second)
        Assert.NotEmpty(first)
    }

    @Fact
    func SafeGetMethodsIncludingSelfAndInterfaces_ClearCache_EvictsEntry() {
        ClrTypeUtilities.ClearCache()
        MemberLookup.ClearCache()
        let before = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(List[int32]), "Add")
        MemberLookup.ClearCache()
        let after = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(List[int32]), "Add")
        Assert.NotSame(before, after)
        Assert.Equal(before.Select((m MethodInfo) -> m.ToString()), after.Select((m MethodInfo) -> m.ToString()))
    }

    @Fact
    func SafeGetMethodsIncludingSelfAndInterfaces_DifferentNames_AreCachedIndependently() {
        ClrTypeUtilities.ClearCache()
        MemberLookup.ClearCache()
        let add = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(List[int32]), "Add")
        let clear = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(typeof(List[int32]), "Clear")
        Assert.All(add, (m MethodInfo) -> Assert.Equal("Add", m.Name))
        Assert.All(clear, (m MethodInfo) -> Assert.Equal("Clear", m.Name))
    }

    @Fact
    func Dispose_ClearsClrMemberLookupCaches() {
        ClrTypeUtilities.ClearCache()
        MemberLookup.ClearCache()
        let methodsBefore = ClrTypeUtilities.SafeGetMethods(
            typeof(Dictionary[string, int32]),
            BindingFlags.Public | BindingFlags.Instance
        )
        let interfacesBefore = ClrTypeUtilities.SafeGetInterfaces(typeof(Dictionary[string, int32]))
        let includingBefore = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
            typeof(Dictionary[string, int32]),
            "Add"
        )
        let corePath = typeof(ReferenceResolver).Assembly.Location
        let resolver = ReferenceResolver.WithReferences([]string{corePath})
        resolver.Dispose()
        let methodsAfter = ClrTypeUtilities.SafeGetMethods(
            typeof(Dictionary[string, int32]),
            BindingFlags.Public | BindingFlags.Instance
        )
        let interfacesAfter = ClrTypeUtilities.SafeGetInterfaces(typeof(Dictionary[string, int32]))
        let includingAfter = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
            typeof(Dictionary[string, int32]),
            "Add"
        )
        Assert.NotSame(methodsBefore, methodsAfter)
        Assert.NotSame(interfacesBefore, interfacesAfter)
        Assert.NotSame(includingBefore, includingAfter)
    }
}
