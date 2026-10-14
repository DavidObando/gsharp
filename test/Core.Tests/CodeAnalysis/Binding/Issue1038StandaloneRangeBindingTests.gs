// <copyright file="Issue1038StandaloneRangeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #1038: Emitted-oracle coverage for standalone range binding.
/// Traceability: diagnostic GS0410 (retired by ADR-0187).
open class Issue1038StandaloneRangeBindingTests {
    @Fact
    func StandaloneRange_IsSystemRangeTyped() {
        let result = Evaluate("let r = 1..3\nr.GetType().FullName")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("System.Range", result.Value)
    }

    @Fact
    func RangeValue_IndexesArray_ClosedRange() {
        let result = Evaluate(`var xs = [5]int32{10, 20, 30, 40, 50}
let r = 1..3
let ys = xs[r]
ys[0] + ys[1]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(50, result.Value)
    }

    @Fact
    func RangeValue_IndexesArray_OpenLowerBound() {
        let result = Evaluate(`var xs = [5]int32{10, 20, 30, 40, 50}
let r = ..2
let ys = xs[r]
ys[0] + ys[1]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(30, result.Value)
    }

    @Fact
    func RangeValue_IndexesArray_OpenUpperBound() {
        let result = Evaluate(`var xs = [5]int32{10, 20, 30, 40, 50}
let r = 3..
let ys = xs[r]
ys[0] + ys[1]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(90, result.Value)
    }

    @Fact
    func RangeValue_IndexesArray_FullRange() {
        let result = Evaluate(`var xs = [3]int32{7, 8, 9}
let r = ..
let ys = xs[r]
ys[0] + ys[1] + ys[2]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(24, result.Value)
    }

    @Fact
    func RangeValue_FromEndUpperBound_IndexesArray() {
        // xs[1..^1] keeps indices 1, 2, 3 (drops the last).
        let result = Evaluate(`var xs = [5]int32{10, 20, 30, 40, 50}
let r = 1..^1
let ys = xs[r]
ys.Length * 1000 + ys[0] + ys[2]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal((3 * 1000) + 20 + 40, result.Value)
    }

    @Fact
    func RangeValue_IndexesString() {
        let result = Evaluate(`let s = "hello world"
let r = 0..5
s[r]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hello", result.Value)
    }

    @Fact
    func InlineParenthesizedRange_IndexesArray() {
        let result = Evaluate(`var xs = [5]int32{10, 20, 30, 40, 50}
let ys = xs[(1..3)]
ys[0] + ys[1]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(50, result.Value)
    }

    @Fact
    func RangeBindsLooserThanAdditive() {
        // 1+1..2+2 == 2..4 -> xs[2..4] == {30, 40}.
        let result = Evaluate(`var xs = [5]int32{10, 20, 30, 40, 50}
let r = 1+1..2+2
let ys = xs[r]
ys.Length * 1000 + ys[0] + ys[1]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal((2 * 1000) + 30 + 40, result.Value)
    }

    @Fact
    func LeadingFromEndMarker_BindsReusableRange_Adr0187() {
        // ADR-0187 retired GS0410: `^3..^1` over five elements is {30, 40}.
        let result = Evaluate(`var xs = [5]int32{10, 20, 30, 40, 50}
let r = ^3..^1
let ys = xs[r]
ys.Length * 1000 + ys[0] + ys[1]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal((2 * 1000) + 30 + 40, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func GetDiagnostics(source string) IEnumerable[Diagnostic] -> Evaluate(source).Diagnostics
    }
}
