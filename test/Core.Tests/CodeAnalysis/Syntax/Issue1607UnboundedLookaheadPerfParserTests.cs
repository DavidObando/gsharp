// <copyright file="Issue1607UnboundedLookaheadPerfParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Diagnostics;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1607: several speculative "does this look like X" token-lookahead
/// scans (<c>TryFindMatchingCloseBracketFollowedByEquals</c>,
/// <c>LooksLikeYieldTupleLiteral</c>, <c>LooksLikeCollectionInitializerBrace</c>,
/// <c>LooksLikeReceiverMethodDeclaration</c>, <c>LooksLikeIfExpression</c>) had
/// no scan bound and ran to EOF on malformed/unbalanced input. Since each is
/// invoked per statement/position, an unbalanced construct repeated many
/// times made parsing O(N^2). All five are now capped at the same
/// <c>LookaheadMaxScan</c> bound already used by <c>LooksLikeLambdaStart</c>,
/// so a malformed lookahead bails out quickly instead of scanning to EOF.
/// </summary>
public class Issue1607UnboundedLookaheadPerfParserTests
{
    [Fact]
    public void Many_Unbalanced_Index_Assignments_Parse_Quickly()
    {
        // Each `a[` opens TryFindMatchingCloseBracketFollowedByEquals with no
        // matching `]` anywhere in the file. Before the fix, each occurrence
        // rescanned the remaining tokens to EOF -> O(N^2). The index content is
        // a literal (not another unclosed `ident[`) so each statement's index
        // expression terminates on its own instead of chaining into the next
        // statement's unclosed bracket (a separate, pre-existing recursion
        // concern unrelated to this lookahead-bound fix).
        const int statementCount = 3000;
        var source = "package p\nfunc F() {\n" +
            string.Join("\n", Enumerable.Range(0, statementCount).Select(i => $"a{i}[{i}")) +
            "\n}";

        // Warm up JIT once, then take the best (minimum) of several runs.
        // Minimum excludes cold-JIT and GC/scheduler spikes that make a
        // single wall-clock sample flaky on shared CI hardware; the 2000ms
        // bound still has ~1000x headroom over the linear parse while
        // catching a regression back to the quadratic scan-to-EOF.
        SyntaxTree.Parse(source);
        var bestMs = long.MaxValue;
        SyntaxTree tree = null;
        for (var run = 0; run < 3; run++)
        {
            var stopwatch = Stopwatch.StartNew();
            tree = SyntaxTree.Parse(source);
            stopwatch.Stop();
            if (stopwatch.ElapsedMilliseconds < bestMs)
            {
                bestMs = stopwatch.ElapsedMilliseconds;
            }
        }

        Assert.NotEmpty(tree.Diagnostics);
        Assert.True(bestMs < 2000, $"Parsing {statementCount} unbalanced '[' statements took {bestMs}ms, expected < 2000ms (quadratic before issue #1607 fix).");
    }

    [Fact]
    public void Many_Unclosed_If_Blocks_Parse_Quickly()
    {
        // Each nested `if` inside a block expression invokes LooksLikeIfExpression,
        // which used to walk to EOF when the `{` never closes.
        const int nestCount = 3000;
        var source = "package p\nlet x = {\n" +
            string.Join("\n", Enumerable.Range(0, nestCount).Select(i => "if true {")) +
            "\n}";

        // Warm up JIT once, then take the best (minimum) of several runs to
        // avoid cold-JIT / GC-spike flakiness on shared CI hardware.
        SyntaxTree.Parse(source);
        var bestMs = long.MaxValue;
        for (var run = 0; run < 3; run++)
        {
            var stopwatch = Stopwatch.StartNew();
            SyntaxTree.Parse(source);
            stopwatch.Stop();
            if (stopwatch.ElapsedMilliseconds < bestMs)
            {
                bestMs = stopwatch.ElapsedMilliseconds;
            }
        }

        Assert.True(bestMs < 2000, $"Parsing {nestCount} unclosed 'if' blocks took {bestMs}ms, expected < 2000ms (quadratic before issue #1607 fix).");
    }

    [Fact]
    public void Valid_Index_Assignment_Still_Parses()
    {
        const string source = "package p\nfunc F() {\n a[0] = 1\n}";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void Valid_Yield_Tuple_Literal_Still_Parses()
    {
        const string source = """
            package p
            class C {
                shared {
                    func F() sequence[(int32, int32)] {
                        yield (1, 2)
                    }
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void Valid_If_Expression_Chain_Still_Parses()
    {
        const string source = """
            package P
            let x = if true { 1 } else { 2 }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }
}
