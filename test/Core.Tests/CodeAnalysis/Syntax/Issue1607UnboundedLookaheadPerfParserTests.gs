// <copyright file="Issue1607UnboundedLookaheadPerfParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Diagnostics
import System.Linq
import Xunit

/// Issue #1607: several speculative "does this look like X" token-lookahead
/// scans (`TryFindMatchingCloseBracketFollowedByEquals`,
/// `LooksLikeYieldTupleLiteral`, `LooksLikeCollectionInitializerBrace`,
/// `LooksLikeReceiverMethodDeclaration`, `LooksLikeIfExpression`) had
/// no scan bound and ran to EOF on malformed/unbalanced input. Since each is
/// invoked per statement/position, an unbalanced construct repeated many
/// times made parsing O(N^2). All five are now capped at the same
/// `LookaheadMaxScan` bound already used by `LooksLikeLambdaStart`,
/// so a malformed lookahead bails out quickly instead of scanning to EOF.
open class Issue1607UnboundedLookaheadPerfParserTests {
    @Fact
    func Many_Unbalanced_Index_Assignments_Parse_Quickly() {
        // Each `a[` opens TryFindMatchingCloseBracketFollowedByEquals with no
        // matching `]` anywhere in the file. Before the fix, each occurrence
        // rescanned the remaining tokens to EOF -> O(N^2). The index content is
        // a literal (not another unclosed `ident[`) so each statement's index
        // expression terminates on its own instead of chaining into the next
        // statement's unclosed bracket (a separate, pre-existing recursion
        // concern unrelated to this lookahead-bound fix).
        const statementCount = 3000
        let source = `package p
func F() {
` + string.Join("\n", Enumerable.Range(0, statementCount).Select((i int32) -> "a$i[$i")) + "\n}"
        // Warm up JIT once, then take the best (minimum) of several runs.
        // Minimum excludes cold-JIT and GC/scheduler spikes that make a
        // single wall-clock sample flaky on shared CI hardware; the 2000ms
        // bound still has ~1000x headroom over the linear parse while
        // catching a regression back to the quadratic scan-to-EOF.
        SyntaxTree.Parse(source)
        var bestMs = int64.MaxValue
        var tree SyntaxTree? = nil
        for var run = 0; run < 3; run++ {
            let stopwatch = Stopwatch.StartNew()
            tree = SyntaxTree.Parse(source)
            stopwatch.Stop()
            if stopwatch.ElapsedMilliseconds < bestMs {
                bestMs = stopwatch.ElapsedMilliseconds
            }
        }
        Assert.NotEmpty(tree!!.Diagnostics)
        Assert.True(
            bestMs < int64(2000),
            "Parsing $statementCount unbalanced '[' statements took ${bestMs}ms, expected < 2000ms (quadratic before issue #1607 fix)."
        )
    }

    @Fact
    func Many_Unclosed_If_Blocks_Parse_Quickly() {
        // Each nested `if` inside a block expression invokes LooksLikeIfExpression,
        // which used to walk to EOF when the `{` never closes.
        const nestCount = 3000
        let source = `package p
let x = {
` + string.Join("\n", Enumerable.Range(0, nestCount).Select((i int32) -> "if true {")) + "\n}"
        // Warm up JIT once, then take the best (minimum) of several runs to
        // avoid cold-JIT / GC-spike flakiness on shared CI hardware.
        SyntaxTree.Parse(source)
        var bestMs = int64.MaxValue
        for var run = 0; run < 3; run++ {
            let stopwatch = Stopwatch.StartNew()
            SyntaxTree.Parse(source)
            stopwatch.Stop()
            if stopwatch.ElapsedMilliseconds < bestMs {
                bestMs = stopwatch.ElapsedMilliseconds
            }
        }
        Assert.True(
            bestMs < int64(2000),
            "Parsing $nestCount unclosed 'if' blocks took ${bestMs}ms, expected < 2000ms (quadratic before issue #1607 fix)."
        )
    }

    @Fact
    func Valid_Index_Assignment_Still_Parses() {
        const source = `package p
func F() {
 a[0] = 1
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func Valid_Yield_Tuple_Literal_Still_Parses() {
        const source = `package p
class C {
    shared {
        func F() sequence[(int32, int32)] {
            yield (1, 2)
        }
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func Valid_If_Expression_Chain_Still_Parses() {
        const source = "package P\nlet x = if true { 1 } else { 2 }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }
}
