// <copyright file="Issue4350IndexRangeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Linq
import Xunit

/// ADR-0187 / issue #4350: emitted-oracle coverage for first-class
/// `System.Index` / `System.Range` expressions and the `~`
/// one's-complement operator.
open class Issue4350IndexRangeBindingTests {
    @Fact
    func BareFromEnd_BindsToSystemIndexValue() {
        let result = EmittedOracle.Evaluate("let i = ^3\ni")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(Index.FromEnd(3), result.Value)
    }

    @Fact
    func ExplicitlyTypedIndexLocal_AcceptsFromEndAndIntegers() {
        let result = EmittedOracle.Evaluate(`let a System.Index = ^2
let b System.Index = 4
a.Value * 10 + b.Value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(24, result.Value)
    }

    @Fact
    func LeadingFromEndRange_BindsToSystemRangeValue() {
        let result = EmittedOracle.Evaluate("let r = ^4..^1\nr")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(Range(Index.FromEnd(4), Index.FromEnd(1)), result.Value)
    }

    @Fact
    func SavedIndexBounds_BuildRange() {
        let result = EmittedOracle.Evaluate(`let i = ^3
let j System.Index = 4
let r = i..j
r`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(Range(Index.FromEnd(3), 4), result.Value)
    }

    @Fact
    func OpenForms_UseStartAndEnd() {
        Assert.Equal(Range.All, EmittedOracle.Evaluate("let r = ..\nr").Value)
        Assert.Equal(Range.StartAt(Index.FromEnd(2)), EmittedOracle.Evaluate("let r = ^2..\nr").Value)
        Assert.Equal(Range.EndAt(Index.FromEnd(2)), EmittedOracle.Evaluate("let r = ..^2\nr").Value)
    }

    @Fact
    func SavedIndex_IndexesArray() {
        let result = EmittedOracle.Evaluate(`var xs = [5]int32{10, 20, 30, 40, 50}
let i = ^2
xs[i] + xs[(^5)]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(50, result.Value)
    }

    @Fact
    func Tilde_ComplementsIntegersAndEnums() {
        Assert.Equal(-6, EmittedOracle.Evaluate("~5").Value)
        Assert.Equal(uint32.MaxValue - uint32(15), EmittedOracle.Evaluate("~15u").Value)
        Assert.Equal(~DayOfWeek.Sunday, EmittedOracle.Evaluate("import System\n~DayOfWeek.Sunday").Value)
    }

    @Fact
    func FromEndIndex_IsNotAnInteger() {
        // C# rejects `^a + 1` (no Index + int operator); so does G#.
        let result = EmittedOracle.Evaluate(`let a = 2
let x = ^a + 1
x`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func RetiredGs0410_IsNeverReported() {
        let result = EmittedOracle.Evaluate(`let r = ^1..3
let i = ^1
r.Start.Value + i.Value`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0410")
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(2, result.Value)
    }
}
