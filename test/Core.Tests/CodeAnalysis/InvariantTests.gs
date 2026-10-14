// <copyright file="InvariantTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import System
import Xunit

/// Part of #1364: (cref:Invariant.Required{T}) is the alternative to the
/// null-forgiving operator for invariants that are real but non-local. Its
/// whole value over `!` is what happens when the invariant is wrong, so
/// that is what these pin.
open class InvariantTests {
    @Fact
    func Required_ReturnsTheValue_WhenTheInvariantHolds() {
        let value = "present"
        Assert.Same(value, Invariant.Required(value, "the test supplied it", expression: "value"))
    }

    /// The discriminating assertion: a violated invariant throws rather than
    /// returning null. A `!` here would return null and defer the failure to
    /// whatever dereferenced it next.
    @Fact
    func Required_Throws_WhenTheInvariantIsViolated() {
        let absent string? = nil
        Assert.Throws[InvalidOperationException](
            func () object? {
                return Invariant.Required(absent, "the test deliberately omitted it", expression: "absent")
            }
        )
    }

    /// The reason is the point. Without it the exception is no more diagnosable
    /// than the NullReferenceException it replaces.
    @Fact
    func Required_NamesTheReason_InTheMessage() {
        let absent string? = nil
        let ex = Assert.Throws[InvalidOperationException](
            func () object? {
                return Invariant.Required(absent, "a nested type always has a declaring type", expression: "absent")
            }
        )
        Assert.Contains("a nested type always has a declaring type", ex.Message, StringComparison.Ordinal)
    }

    /// CallerArgumentExpression gives the failure the source text of the
    /// offending expression, which `!` cannot.
    @Fact
    func Required_NamesTheExpression_InTheMessage() {
        let someDeclaringType string? = nil
        let ex = Assert.Throws[InvalidOperationException](
            func () object? {
                return Invariant.Required(someDeclaringType, "reason", expression: "someDeclaringType")
            }
        )
        Assert.Contains("someDeclaringType", ex.Message, StringComparison.Ordinal)
    }
}
