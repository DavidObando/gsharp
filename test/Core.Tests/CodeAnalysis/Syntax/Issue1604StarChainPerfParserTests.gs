// <copyright file="Issue1604StarChainPerfParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Diagnostics
import System.Linq
import Xunit

/// Issue #1604: `SyntaxNode.Span` walked the whole subtree via uncached
/// reflection on every access. The ADR-0122 leading-`*` newline check
/// ((cref:Parser)'s `IsCurrentOnNewLineAfter`) calls
/// `node.Span` on the accumulated left operand at every `*` in a
/// binary chain, so parsing `1 * 1 * ... * 1` re-walked an O(i) tree at
/// each of N iterations: O(N^2) with a large reflection constant. A long
/// `*` chain must parse in roughly the same time as an equivalent
/// `+` chain, not 1000x+ slower.
open class Issue1604StarChainPerfParserTests {
    @Fact
    func Long_Star_Chain_Parses_Quickly() {
        const termCount = 4000
        let source = "package p\nfunc F() int32 { return " + string.Join(" * ", Enumerable.Repeat("1", termCount)) +
            " }"
        let stopwatch = Stopwatch.StartNew()
        let tree = SyntaxTree.Parse(source)
        stopwatch.Stop()
        Assert.Empty(tree.Diagnostics)
        // Was ~3.6s for 4000 terms before the fix (quadratic); the fixed,
        // amortized-O(1)-Span version parses in low tens of ms. Generous bound
        // to avoid flakiness on slow CI machines while still catching a
        // regression back to quadratic behavior.
        Assert.True(
            stopwatch.ElapsedMilliseconds < int64(1000),
            "Parsing $termCount '*' terms took ${stopwatch.ElapsedMilliseconds}ms, expected < 1000ms (was ~3660ms before issue #1604 fix)."
        )
    }

    @Fact
    func Span_Is_Cached_And_Stable_Across_Repeated_Access() {
        const source = "package p\nfunc F() int32 { return 1 * 2 * 3 }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let first = tree.Root.Span
        let second = tree.Root.Span
        Assert.Equal(first, second)
    }
}
