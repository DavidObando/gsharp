// <copyright file="Issue1679TypeIdentityAqnCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Emit
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import System.Runtime.InteropServices
import Xunit

/// Issue #1679: (cref:TypeIdentityComparer) used to rebuild each
/// (cref:Type)'s assembly-qualified-name key from scratch on every
/// `Equals`/`GetHashCode` call — including cache hits against the
/// `TypeRefs`/`TypeSpecs` dictionaries it backs. The fix memoizes
/// the key per (cref:Type) instance in a
/// (cref:ConditionalWeakTable{TKey, TValue}). These tests pin that the
/// memoization is transparent to observers (identical Equals/GetHashCode
/// results before and after caching kicks in) for the representative type
/// shapes called out in the issue — generics, arrays, nested types, and
/// types reached through distinct `MetadataLoadContext` instances — and
/// that the cache is actually populated (not merely a no-op wrapper).
open class Issue1679TypeIdentityAqnCacheTests {
    private class OuterHolder {
        class NestedType { }
    }

    @Fact
    func GetHashCode_IsStable_AcrossRepeatedCallsOnSameInstance() {
        // First call populates the cache; subsequent calls must return the
        // exact same hash (memoization must not change observable behavior).
        let type = typeof(Dictionary[string, List[int32]])
        let first = TypeIdentityComparer.Instance.GetHashCode(type)
        let second = TypeIdentityComparer.Instance.GetHashCode(type)
        let third = TypeIdentityComparer.Instance.GetHashCode(type)
        Assert.Equal(first, second)
        Assert.Equal(second, third)
    }

    @Fact
    func Equals_And_GetHashCode_PreservedForConstructedGenerics() {
        let a = typeof(Dictionary[string, List[int32]])
        let b = typeof(Dictionary[string, List[int32]])
        Assert.True(TypeIdentityComparer.Instance.Equals(a, b))
        Assert.Equal(TypeIdentityComparer.Instance.GetHashCode(a), TypeIdentityComparer.Instance.GetHashCode(b))
        // A different generic argument must remain distinct.
        let c = typeof(Dictionary[string, List[int64]])
        Assert.False(TypeIdentityComparer.Instance.Equals(a, c))
    }

    @Fact
    func Equals_And_GetHashCode_PreservedForArrays() {
        let a1 = typeof([]int32)
        let a2 = typeof([]int32)
        let jagged = typeof([][]int32)
        let rank2 = typeof([,]int32)
        let strings = typeof([]string)
        Assert.True(TypeIdentityComparer.Instance.Equals(a1, a2))
        Assert.Equal(TypeIdentityComparer.Instance.GetHashCode(a1), TypeIdentityComparer.Instance.GetHashCode(a2))
        Assert.False(TypeIdentityComparer.Instance.Equals(a1, jagged))
        Assert.False(TypeIdentityComparer.Instance.Equals(a1, rank2))
        Assert.False(TypeIdentityComparer.Instance.Equals(a1, strings))
    }

    @Fact
    func Equals_And_GetHashCode_PreservedForNestedTypes() {
        let a = typeof(Issue1679TypeIdentityAqnCacheTests.OuterHolder.NestedType)
        let b = typeof(Issue1679TypeIdentityAqnCacheTests.OuterHolder.NestedType)
        Assert.True(TypeIdentityComparer.Instance.Equals(a, b))
        Assert.Equal(TypeIdentityComparer.Instance.GetHashCode(a), TypeIdentityComparer.Instance.GetHashCode(b))
        // Nested type must remain distinct from its declaring (outer) type.
        Assert.False(TypeIdentityComparer.Instance.Equals(a, typeof(OuterHolder)))
    }

    @Fact
    func Equals_And_GetHashCode_PreservedAcrossMetadataLoadContexts() {
        // Same repro as TypeRefDeduplicationTests, but covering constructed
        // generics reached through two distinct MetadataLoadContext
        // instances, to make sure memoizing the key per-Type-instance still
        // lets structurally-identical (but reference-distinct) generic
        // instantiations compare equal.
        let coreAssemblies = Directory.GetFiles(RuntimeEnvironment.GetRuntimeDirectory(), "*.dll").ToList()
        using let ctxA = MetadataLoadContext(PathAssemblyResolver(coreAssemblies))
        using let ctxB = MetadataLoadContext(PathAssemblyResolver(coreAssemblies))
        let listOfObjectA = ctxA.CoreAssembly!!.GetType("System.Collections.Generic.List`1")!!.MakeGenericType(
            ctxA.CoreAssembly!!.GetType("System.String")!!
        )
        let listOfObjectB = ctxB.CoreAssembly!!.GetType("System.Collections.Generic.List`1")!!.MakeGenericType(
            ctxB.CoreAssembly!!.GetType("System.String")!!
        )
        Assert.NotSame(listOfObjectA, listOfObjectB)
        Assert.True(TypeIdentityComparer.Instance.Equals(listOfObjectA, listOfObjectB))
        Assert.Equal(
            TypeIdentityComparer.Instance.GetHashCode(listOfObjectA),
            TypeIdentityComparer.Instance.GetHashCode(listOfObjectB)
        )
    }

    @Fact
    func KeyCache_IsPopulated_AfterFirstProbe() {
        // Confirms the memoization is real (not a dead field): after a single
        // Equals/GetHashCode call for a fresh Type, the ConditionalWeakTable
        // holds an entry for it.
        Assert.NotNull(KeyCacheField)
        let cache object? = KeyCacheField!!.GetValue(nil)
        Assert.NotNull(cache)
        let tryGetValue MethodInfo? = cache!!.GetType().GetMethod("TryGetValue")
        Assert.NotNull(tryGetValue)
        // Use a type unlikely to have been probed by any earlier test in this
        // run, so we can observe the cache transition from empty to populated
        // for this specific key.
        let type = typeof(Issue1679TypeIdentityAqnCacheTests)
        let argsBefore = []object? {type, nil}
        let foundBefore = bool(tryGetValue!!.Invoke(cache, argsBefore))
        TypeIdentityComparer.Instance.GetHashCode(type)
        let argsAfter = []object? {type, nil}
        let foundAfter = bool(tryGetValue!!.Invoke(cache, argsAfter))
        Assert.False(foundBefore)
        Assert.True(foundAfter)
        Assert.Equal(type.AssemblyQualifiedName, cast[string](argsAfter[1]))
    }

    @Fact
    func NullHandling_Unchanged() {
        Assert.True(TypeIdentityComparer.Instance.Equals(nil, nil))
        Assert.False(TypeIdentityComparer.Instance.Equals(nil, typeof(int32)))
        Assert.False(TypeIdentityComparer.Instance.Equals(typeof(int32), nil))
        Assert.Throws[ArgumentNullException](
            func () object? {
                return TypeIdentityComparer.Instance.GetHashCode(nil)
            }
        )
    }

    shared {
        private let KeyCacheField FieldInfo? = typeof(TypeIdentityComparer).GetField(
            "KeyCache",
            BindingFlags.NonPublic | BindingFlags.Static
        )
    }
}
