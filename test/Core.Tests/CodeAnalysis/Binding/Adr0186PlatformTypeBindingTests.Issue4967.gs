// <copyright file="Adr0186PlatformTypeBindingTests.Issue4967.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import Xunit

/// Issue #4967 / ADR-0072 (amended): the type of the `??=` expression is
/// the target's underlying type when the stored value is known non-nil
/// (`int32? ??= int32` is `int32`, as in C#, and the same as
/// `target ?? value`); otherwise it is the target's `T?`. A `T!` (platform)
/// target follows the rule; a `T!` right side may be nil, so it yields `T?`
/// and is stored unchecked, as the statement form always stored it.
partial class Adr0186PlatformTypeBindingTests {
    /// The `??=` result type equals the expected display and, where
    /// [`matchesCoalesce`](paramref), the `??` result type.
    /// @param declarations Globals declaring the target and right side.
    /// @param target The target expression.
    /// @param value The right side.
    /// @param expected The expected display of the result type.
    /// @param matchesCoalesce Whether `target ?? value` has the same type.
    @Theory
    @InlineData("var t string? = nil", "t", "\"v\"", "string", true)
    @InlineData("var t string? = nil\nvar m string? = nil", "t", "m", "string?", true)
    @InlineData("var n int32? = nil", "n", "42", "int32", true)
    @InlineData("var n int32? = nil\nvar o int32? = nil", "n", "o", "int32?", true)
    @InlineData("var big int64? = nil", "big", "5", "int64", true)
    @InlineData("var x object? = nil", "x", "42", "object", true)
    @InlineData("var arr = []string?{nil}", "arr[0]", "\"v\"", "string", true)
    @InlineData("var s = Ob.Nil()", "s", "\"v\"", "string", true)
    @InlineData("var t string? = nil", "t", "Ob.Value()", "string?", false)
    func Issue4967_CoalescingAssignment_ResultType(
        declarations string,
        target string,
        value string,
        expected string,
        matchesCoalesce bool
    ) {
        using let world = World()
        let _ = world.GlobalProbeType(
            declarations + "\nlet probe = (" + target + " ??= " + value + ")",
            NullabilityMode.PlatformTypes
        )
        let assigned = world.LastProbeDisplay
        Assert.Equal(expected, assigned)
        let _ = world.GlobalProbeType(
            declarations + "\nlet probe = " + target + " ?? " + value,
            NullabilityMode.PlatformTypes
        )
        Assert.Equal(matchesCoalesce, world.LastProbeDisplay == assigned)
    }

    /// A platform target and a platform right side run in value position:
    /// the right side is evaluated only when the target is nil, and the value
    /// is the target's final value.
    @Fact
    func Issue4967_PlatformOperands_RunInValuePosition() {
        using let world = World()
        Assert.Equal("v v V", world.Run(`    var s = Ob.Nil()
    let first = (s ??= "v")
    let second = (s ??= Ob.Value())
    var t string? = nil
    Console.WriteLine(first + " " + second + " " + (t ??= Ob.Value()))`, NullabilityMode.PlatformTypes).Trim())
    }
}
