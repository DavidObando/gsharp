// <copyright file="ControlFlowGraphEscapingGotoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable
import System.Linq
import Xunit

/// Focused, binder-analyzer-independent tests for issue #2360's fix in
/// (cref:ControlFlowGraph.GraphBuilder): a `goto` (or conditional
/// `goto`) whose target label is not declared anywhere in the
/// (cref:BoundBlockStatement) passed to (cref:ControlFlowGraph.Create)
/// must not throw; instead it must be treated exactly like a
/// `return`/`throw` and routed to (cref:ControlFlowGraph.End).
/// This is the exact situation (cref:RefStructAsyncLivenessAnalyzer) and
/// (cref:DefiniteAssignmentAnalyzer) create when they build a
/// region-scoped graph for just a try/catch body whose lowered `return`
/// has been rewritten into a `goto` targeting a method-exit label that
/// lives outside that region (see `Lowerer.RewriteReturnStatement` /
/// `WrapWithMethodExitEpilogue`).
open class ControlFlowGraphEscapingGotoTests {
    @Fact
    func Create_UnconditionalGotoToUndeclaredLabel_DoesNotThrow_AndConnectsToEnd() {
        let escapingLabel = BoundLabel("Label1")
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundLiteralExpression(nil, 1)),
                BoundGotoStatement(nil, escapingLabel)
            )
        )
        let graph = ControlFlowGraph.Create(body)
        let gotoBlock = graph.Blocks.Single(
            (b ControlFlowGraph.BasicBlock) -> b.Statements.Any(
                (s BoundStatement) -> s.Kind == BoundNodeKind.GotoStatement
            )
        )
        Assert.Contains(graph.End, gotoBlock.Outgoing.Select((branch ControlFlowGraph.BasicBlockBranch) -> branch.To))
    }

    @Fact
    func Create_ConditionalGotoToUndeclaredLabel_DoesNotThrow_AndConnectsToEnd() {
        let escapingLabel = BoundLabel("Label2")
        let condition = BoundLiteralExpression(nil, true)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundConditionalGotoStatement(nil, escapingLabel, condition),
                BoundExpressionStatement(nil, BoundLiteralExpression(nil, 2))
            )
        )
        let graph = ControlFlowGraph.Create(body)
        let gotoBlock = graph.Blocks.Single(
            (b ControlFlowGraph.BasicBlock) -> b.Statements.Any(
                (s BoundStatement) -> s.Kind == BoundNodeKind.ConditionalGotoStatement
            )
        )
        Assert.Contains(graph.End, gotoBlock.Outgoing.Select((branch ControlFlowGraph.BasicBlockBranch) -> branch.To))
    }

    @Fact
    func Create_GotoToDeclaredLabelWithinSameBlock_StillConnectsToThatBlock() {
        // Control: a goto whose target label *is* present in the region must
        // keep resolving to that block, not fall through to End — the fix
        // must not regress the ordinary, in-region goto case.
        let label = BoundLabel("L")
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundGotoStatement(nil, label),
                BoundLabelStatement(nil, label),
                BoundExpressionStatement(nil, BoundLiteralExpression(nil, 3))
            )
        )
        let graph = ControlFlowGraph.Create(body)
        let gotoBlock = graph.Blocks.Single(
            (b ControlFlowGraph.BasicBlock) -> b.Statements.Any(
                (s BoundStatement) -> s.Kind == BoundNodeKind.GotoStatement
            )
        )
        let labelBlock = graph.Blocks.Single(
            (b ControlFlowGraph.BasicBlock) -> b.Statements.Any(
                (s BoundStatement) -> s.Kind == BoundNodeKind.LabelStatement
            )
        )
        Assert.Contains(labelBlock, gotoBlock.Outgoing.Select((branch ControlFlowGraph.BasicBlockBranch) -> branch.To))
        Assert.DoesNotContain(
            graph.End,
            gotoBlock.Outgoing.Select((branch ControlFlowGraph.BasicBlockBranch) -> branch.To)
        )
    }
}
