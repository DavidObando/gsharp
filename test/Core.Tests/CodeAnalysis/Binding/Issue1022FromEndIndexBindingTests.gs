// <copyright file="Issue1022FromEndIndexBindingTests.cs" company="GSharp">
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

/// Issue #1022: Emitted-oracle coverage for from end index binding.
open class Issue1022FromEndIndexBindingTests {
    @Fact
    func SingleFromEndIndex_LastElement() {
        let result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nxs[^1]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(50, result.Value)
    }

    @Fact
    func SingleFromEndIndex_NthFromEnd() {
        let result = Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nxs[^2]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(40, result.Value)
    }

    @Fact
    func FromEndUpperBound_DropsLast() {
        let result = Evaluate(`var xs = [5]int32{10, 20, 30, 40, 50}
let ys = xs[1..^1]
ys[0] + ys[ys.Length - 1]`)
        Assert.Empty(result.Diagnostics)
        // ys = {20, 30, 40}; first + last = 60.
        Assert.Equal(60, result.Value)
    }

    @Fact
    func FromEndUpperBound_OpenLower_DropsLastThree() {
        let result = Evaluate(`var xs = [5]int32{10, 20, 30, 40, 50}
let ys = xs[..^3]
ys.Length * 1000 + ys[0] + ys[1]`)
        Assert.Empty(result.Diagnostics)
        // ys = {10, 20}; len 2 -> 2030.
        Assert.Equal(2030, result.Value)
    }

    @Fact
    func FromEndLowerBound_OpenUpper_LastTwo() {
        let result = Evaluate(`var xs = [5]int32{10, 20, 30, 40, 50}
let ys = xs[^2..]
ys.Length * 1000 + ys[0] + ys[1]`)
        Assert.Empty(result.Diagnostics)
        // ys = {40, 50}; len 2 -> 2090.
        Assert.Equal(2090, result.Value)
    }

    @Fact
    func StringSlice_FromEndUpperBound() {
        let result = Evaluate("let s = \"abcdef\"\ns[..^3]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("abc", result.Value)
    }

    @Fact
    func StringSlice_FromEndBothEnds() {
        let result = Evaluate("let s = \"abcdef\"\ns[1..^1]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("bcde", result.Value)
    }

    @Fact
    func OnesComplement_StillEvaluates() {
        // ADR-0187: one's-complement is spelled `~`.
        let result = Evaluate("~0")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(-1, result.Value)
    }

    @Fact
    func Xor_StillEvaluates() {
        let result = Evaluate("6 ^ 3")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
