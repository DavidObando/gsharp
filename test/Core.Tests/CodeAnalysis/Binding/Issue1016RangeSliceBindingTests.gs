// <copyright file="Issue1016RangeSliceBindingTests.cs" company="GSharp">
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
import System.Collections.Immutable
import Xunit

/// Issue #1016: Emitted-oracle coverage for range slice binding.
/// Traceability: diagnostic GS0392.
open class Issue1016RangeSliceBindingTests {
    @Fact
    func ArraySlice_ClosedRange_Evaluates() {
        let result = Evaluate(`var xs = [5]int32{10, 20, 30, 40, 50}
let ys = xs[1..3]
ys[0] + ys[1]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(50, result.Value)
    }

    @Fact
    func ArraySlice_OpenLowerBound_Evaluates() {
        let result = Evaluate(`var xs = [5]int32{10, 20, 30, 40, 50}
let ys = xs[..2]
ys[0] + ys[1]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(30, result.Value)
    }

    @Fact
    func ArraySlice_OpenUpperBound_Evaluates() {
        let result = Evaluate(`var xs = [5]int32{10, 20, 30, 40, 50}
let ys = xs[3..]
ys[0] + ys[1]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(90, result.Value)
    }

    @Fact
    func ArraySlice_FullRange_Evaluates() {
        let result = Evaluate(`var xs = [3]int32{7, 8, 9}
let ys = xs[..]
ys[0] + ys[1] + ys[2]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(24, result.Value)
    }

    @Fact
    func StringSlice_ClosedRange_Evaluates() {
        let result = Evaluate(`let s = "hello world"
let h = s[0..5]
h`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hello", result.Value)
    }

    @Fact
    func StringSlice_OpenUpperBound_Evaluates() {
        let result = Evaluate(`let s = "hello world"
let w = s[6..]
w`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("world", result.Value)
    }

    @Fact
    func NonSliceableTarget_ReportsGs0392() {
        let diagnostics = Bind(`import System.Collections.Generic
let m = Dictionary[string, int32]()
let bad = m["a".."b"]
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0392")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] -> Evaluate(source).Diagnostics
    }
}
