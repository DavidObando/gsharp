// <copyright file="InvariantTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Core.CodeAnalysis;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Part of #1364: <see cref="Invariant.Required{T}"/> is the alternative to the
/// null-forgiving operator for invariants that are real but non-local. Its
/// whole value over <c>!</c> is what happens when the invariant is wrong, so
/// that is what these pin.
/// </summary>
public class InvariantTests
{
    [Fact]
    public void Required_ReturnsTheValue_WhenTheInvariantHolds()
    {
        var value = "present";

        Assert.Same(value, Invariant.Required(value, "the test supplied it"));
    }

    /// <summary>
    /// The discriminating assertion: a violated invariant throws rather than
    /// returning null. A `!` here would return null and defer the failure to
    /// whatever dereferenced it next.
    /// </summary>
    [Fact]
    public void Required_Throws_WhenTheInvariantIsViolated()
    {
        string absent = null;

        Assert.Throws<InvalidOperationException>(
            () => Invariant.Required(absent, "the test deliberately omitted it"));
    }

    /// <summary>
    /// The reason is the point. Without it the exception is no more diagnosable
    /// than the NullReferenceException it replaces.
    /// </summary>
    [Fact]
    public void Required_NamesTheReason_InTheMessage()
    {
        string absent = null;

        var ex = Assert.Throws<InvalidOperationException>(
            () => Invariant.Required(absent, "a nested type always has a declaring type"));

        Assert.Contains("a nested type always has a declaring type", ex.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// CallerArgumentExpression gives the failure the source text of the
    /// offending expression, which `!` cannot.
    /// </summary>
    [Fact]
    public void Required_NamesTheExpression_InTheMessage()
    {
        string someDeclaringType = null;

        var ex = Assert.Throws<InvalidOperationException>(
            () => Invariant.Required(someDeclaringType, "reason"));

        Assert.Contains("someDeclaringType", ex.Message, StringComparison.Ordinal);
    }
}
