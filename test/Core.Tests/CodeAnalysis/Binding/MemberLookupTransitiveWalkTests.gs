// <copyright file="MemberLookupTransitiveWalkTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import System
import System.Collections
import System.Collections.Generic
import System.Reflection
import Xunit

/// Issue #607: regression tests proving that
/// (cref:MemberLookup.SafeGetMethodIncludingSelfAndInterfaces) and
/// (cref:MemberLookup.SafeGetPropertyIncludingSelfAndInterfaces)
/// discover members declared on transitive parent interfaces — the gap
/// that plain `Type.GetMethod` on an interface type leaves open.
open class MemberLookupTransitiveWalkTests {
    // ---------------------------------------------------------------
    // MoveNext / Current on a custom enumerator interface that
    // inherits from IEnumerator<T> (the for-in lowerer path).
    // ---------------------------------------------------------------
    @Fact
    func SafeGetMethod_MoveNext_OnInterfaceInheritingIEnumerator() {
        // ICustomEnumerator<T> : IEnumerator<T> does not redeclare
        // MoveNext — it lives on IEnumerator. The old direct GetMethod
        // on the interface would return null.
        let method MethodInfo? = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
            typeof(ICustomEnumerator[int32]),
            "MoveNext",
            Type.EmptyTypes
        )
        Assert.NotNull(method)
        Assert.Equal("MoveNext", method!!.Name)
    }

    @Fact
    func SafeGetProperty_Current_OnInterfaceInheritingIEnumerator() {
        let prop PropertyInfo? = MemberLookup.SafeGetPropertyIncludingSelfAndInterfaces(
            typeof(ICustomEnumerator[int32]),
            "Current"
        )
        Assert.NotNull(prop)
        Assert.Equal(typeof(int32), prop!!.PropertyType)
    }

    @Fact
    func SafeGetMethod_Dispose_OnInterfaceInheritingIDisposable() {
        // Dispose lives on IDisposable, inherited by IEnumerator<T>.
        let method MethodInfo? = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
            typeof(ICustomEnumerator[string]),
            "Dispose",
            Type.EmptyTypes
        )
        Assert.NotNull(method)
        Assert.Equal("Dispose", method!!.Name)
    }

    @Fact
    func SafeGetMethod_OnConcreteType_StillWorksDirectly() {
        // Sanity check: concrete types that declare the method directly
        // still resolve fine.
        let method MethodInfo? = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
            typeof(List[int32]),
            "Add",
            []Type{typeof(int32)}
        )
        Assert.NotNull(method)
    }

    @Fact
    func SafeGetMethod_ReturnsNull_WhenMethodDoesNotExist() {
        let method MethodInfo? = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
            typeof(ICustomEnumerator[int32]),
            "NonExistentMethod",
            Type.EmptyTypes
        )
        Assert.Null(method)
    }

    @Fact
    func SafeGetMethodsIncludingSelfAndInterfaces_FindsInheritedMethods() {
        // GetEnumerator is on IEnumerable<T> which IReadOnlyList<T> inherits.
        let methods = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
            typeof(IReadOnlyList[int32]),
            "GetEnumerator"
        )
        Assert.NotEmpty(methods)
    }

    // ---------------------------------------------------------------
    // Helper interfaces
    // ---------------------------------------------------------------
    /// A custom enumerator interface that inherits IEnumerator<T>
    /// without redeclaring any members. Simulates a user-defined enumerator
    /// interface where MoveNext/Current live on the parent.
    interface ICustomEnumerator[T] : IEnumerator[T] { }
}
