// <copyright file="MemberLookupTransitiveWalkTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Binding;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #607: regression tests proving that
/// <see cref="MemberLookup.SafeGetMethodIncludingSelfAndInterfaces"/> and
/// <see cref="MemberLookup.SafeGetPropertyIncludingSelfAndInterfaces"/>
/// discover members declared on transitive parent interfaces — the gap
/// that plain <c>Type.GetMethod</c> on an interface type leaves open.
/// </summary>
public class MemberLookupTransitiveWalkTests
{
    // ---------------------------------------------------------------
    // MoveNext / Current on a custom enumerator interface that
    // inherits from IEnumerator<T> (the for-in lowerer path).
    // ---------------------------------------------------------------

    [Fact]
    public void SafeGetMethod_MoveNext_OnInterfaceInheritingIEnumerator()
    {
        // ICustomEnumerator<T> : IEnumerator<T> does not redeclare
        // MoveNext — it lives on IEnumerator. The old direct GetMethod
        // on the interface would return null.
        var method = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
            typeof(ICustomEnumerator<int>),
            "MoveNext",
            Type.EmptyTypes);
        Assert.NotNull(method);
        Assert.Equal("MoveNext", method.Name);
    }

    [Fact]
    public void SafeGetProperty_Current_OnInterfaceInheritingIEnumerator()
    {
        var prop = MemberLookup.SafeGetPropertyIncludingSelfAndInterfaces(
            typeof(ICustomEnumerator<int>),
            "Current");
        Assert.NotNull(prop);
        Assert.Equal(typeof(int), prop.PropertyType);
    }

    [Fact]
    public void SafeGetMethod_Dispose_OnInterfaceInheritingIDisposable()
    {
        // Dispose lives on IDisposable, inherited by IEnumerator<T>.
        var method = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
            typeof(ICustomEnumerator<string>),
            "Dispose",
            Type.EmptyTypes);
        Assert.NotNull(method);
        Assert.Equal("Dispose", method.Name);
    }

    [Fact]
    public void SafeGetMethod_OnConcreteType_StillWorksDirectly()
    {
        // Sanity check: concrete types that declare the method directly
        // still resolve fine.
        var method = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
            typeof(List<int>),
            "Add",
            new[] { typeof(int) });
        Assert.NotNull(method);
    }

    [Fact]
    public void SafeGetMethod_ReturnsNull_WhenMethodDoesNotExist()
    {
        var method = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
            typeof(ICustomEnumerator<int>),
            "NonExistentMethod",
            Type.EmptyTypes);
        Assert.Null(method);
    }

    [Fact]
    public void SafeGetMethodsIncludingSelfAndInterfaces_FindsInheritedMethods()
    {
        // GetEnumerator is on IEnumerable<T> which IReadOnlyList<T> inherits.
        var methods = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
            typeof(IReadOnlyList<int>),
            "GetEnumerator");
        Assert.NotEmpty(methods);
    }

    // ---------------------------------------------------------------
    // Helper interfaces
    // ---------------------------------------------------------------

    /// <summary>
    /// A custom enumerator interface that inherits IEnumerator&lt;T&gt;
    /// without redeclaring any members. Simulates a user-defined enumerator
    /// interface where MoveNext/Current live on the parent.
    /// </summary>
    public interface ICustomEnumerator<T> : IEnumerator<T>
    {
        // MoveNext, Current, Dispose all inherited — not redeclared.
    }
}
