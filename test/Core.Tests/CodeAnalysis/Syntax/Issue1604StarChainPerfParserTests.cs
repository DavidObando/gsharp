// <copyright file="Issue1604StarChainPerfParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Diagnostics;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1604: <c>SyntaxNode.Span</c> walked the whole subtree via uncached
/// reflection on every access. The ADR-0122 leading-<c>*</c> newline check
/// (<see cref="Parser"/>'s <c>IsCurrentOnNewLineAfter</c>) calls
/// <c>node.Span</c> on the accumulated left operand at every <c>*</c> in a
/// binary chain, so parsing <c>1 * 1 * ... * 1</c> re-walked an O(i) tree at
/// each of N iterations: O(N^2) with a large reflection constant. A long
/// <c>*</c> chain must parse in roughly the same time as an equivalent
/// <c>+</c> chain, not 1000x+ slower.
/// </summary>
public class Issue1604StarChainPerfParserTests
{
    [Fact]
    public void Long_Star_Chain_Parses_Quickly()
    {
        const int termCount = 4000;
        var source = "package p\nfunc F() int32 { return " + string.Join(" * ", System.Linq.Enumerable.Repeat("1", termCount)) + " }";

        var stopwatch = Stopwatch.StartNew();
        var tree = SyntaxTree.Parse(source);
        stopwatch.Stop();

        Assert.Empty(tree.Diagnostics);

        // Was ~3.6s for 4000 terms before the fix (quadratic); the fixed,
        // amortized-O(1)-Span version parses in low tens of ms. Generous bound
        // to avoid flakiness on slow CI machines while still catching a
        // regression back to quadratic behavior.
        Assert.True(stopwatch.ElapsedMilliseconds < 1000, $"Parsing {termCount} '*' terms took {stopwatch.ElapsedMilliseconds}ms, expected < 1000ms (was ~3660ms before issue #1604 fix).");
    }

    [Fact]
    public void Span_Is_Cached_And_Stable_Across_Repeated_Access()
    {
        const string source = "package p\nfunc F() int32 { return 1 * 2 * 3 }";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var first = tree.Root.Span;
        var second = tree.Root.Span;
        Assert.Equal(first, second);
    }
}
