// <copyright file="Adr0186PlatformTypeBindingTests.Issue4967.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import Xunit

/// Issue #4967 / ADR-0072 (amended): the type of the `??=` expression is
/// the type `target ?? value` has. With a non-nullable right side that is
/// the target's underlying type (`int32? ??= int32` is `int32`, as in C#);
/// with a right side that may be nil it stays the target's `T?`. A `T!`
/// (platform) target or right side follows the same `??` rule.
partial class Adr0186PlatformTypeBindingTests {
    /// The `??=` result type equals the `??` result type, and both equal the
    /// expected display.
    /// @param declarations Globals declaring the target and right side.
    /// @param target The target expression.
    /// @param value The right side.
    /// @param expected The expected display of the result type.
    @Theory
    @InlineData("var t string? = nil", "t", "\"v\"", "string")
    @InlineData("var t string? = nil\nvar m string? = nil", "t", "m", "string?")
    @InlineData("var n int32? = nil", "n", "42", "int32")
    @InlineData("var n int32? = nil\nvar o int32? = nil", "n", "o", "int32?")
    @InlineData("var arr = []string?{nil}", "arr[0]", "\"v\"", "string")
    @InlineData("var s = Ob.Nil()", "s", "\"v\"", "string")
    @InlineData("var t string? = nil", "t", "Ob.Value()", "string")
    func Issue4967_CoalescingAssignment_HasTheTypeOfCoalesce(
        declarations string,
        target string,
        value string,
        expected string
    ) {
        using let world = World()
        let _ = world.GlobalProbeType(
            declarations + "\nlet probe = (" + target + " ??= " + value + ")",
            NullabilityMode.PlatformTypes
        )
        let assigned = world.LastProbeDisplay
        let _ = world.GlobalProbeType(
            declarations + "\nlet probe = " + target + " ?? " + value,
            NullabilityMode.PlatformTypes
        )
        Assert.Equal(world.LastProbeDisplay, assigned)
        Assert.Equal(expected, assigned)
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
