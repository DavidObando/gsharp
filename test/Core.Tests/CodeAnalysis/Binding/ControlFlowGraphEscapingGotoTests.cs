// <copyright file="ControlFlowGraphEscapingGotoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Focused, binder-analyzer-independent tests for issue #2360's fix in
/// <see cref="ControlFlowGraph.GraphBuilder"/>: a <c>goto</c> (or conditional
/// <c>goto</c>) whose target label is not declared anywhere in the
/// <see cref="BoundBlockStatement"/> passed to <see cref="ControlFlowGraph.Create"/>
/// must not throw; instead it must be treated exactly like a
/// <c>return</c>/<c>throw</c> and routed to <see cref="ControlFlowGraph.End"/>.
/// This is the exact situation <see cref="RefStructAsyncLivenessAnalyzer"/> and
/// <see cref="RefKindDefiniteAssignmentAnalyzer"/> create when they build a
/// region-scoped graph for just a try/catch body whose lowered <c>return</c>
/// has been rewritten into a <c>goto</c> targeting a method-exit label that
/// lives outside that region (see <c>Lowerer.RewriteReturnStatement</c> /
/// <c>WrapWithMethodExitEpilogue</c>).
/// </summary>
public class ControlFlowGraphEscapingGotoTests
{
    [Fact]
    public void Create_UnconditionalGotoToUndeclaredLabel_DoesNotThrow_AndConnectsToEnd()
    {
        var escapingLabel = new BoundLabel("Label1");
        var body = new BoundBlockStatement(
            null,
            ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(null, new BoundLiteralExpression(null, 1)),
                new BoundGotoStatement(null, escapingLabel)));

        var graph = ControlFlowGraph.Create(body);

        var gotoBlock = graph.Blocks.Single(b => b.Statements.Any(s => s.Kind == BoundNodeKind.GotoStatement));
        Assert.Contains(graph.End, gotoBlock.Outgoing.Select(branch => branch.To));
    }

    [Fact]
    public void Create_ConditionalGotoToUndeclaredLabel_DoesNotThrow_AndConnectsToEnd()
    {
        var escapingLabel = new BoundLabel("Label2");
        var condition = new BoundLiteralExpression(null, true);
        var body = new BoundBlockStatement(
            null,
            ImmutableArray.Create<BoundStatement>(
                new BoundConditionalGotoStatement(null, escapingLabel, condition),
                new BoundExpressionStatement(null, new BoundLiteralExpression(null, 2))));

        var graph = ControlFlowGraph.Create(body);

        var gotoBlock = graph.Blocks.Single(b => b.Statements.Any(s => s.Kind == BoundNodeKind.ConditionalGotoStatement));
        Assert.Contains(graph.End, gotoBlock.Outgoing.Select(branch => branch.To));
    }

    [Fact]
    public void Create_GotoToDeclaredLabelWithinSameBlock_StillConnectsToThatBlock()
    {
        // Control: a goto whose target label *is* present in the region must
        // keep resolving to that block, not fall through to End — the fix
        // must not regress the ordinary, in-region goto case.
        var label = new BoundLabel("L");
        var body = new BoundBlockStatement(
            null,
            ImmutableArray.Create<BoundStatement>(
                new BoundGotoStatement(null, label),
                new BoundLabelStatement(null, label),
                new BoundExpressionStatement(null, new BoundLiteralExpression(null, 3))));

        var graph = ControlFlowGraph.Create(body);

        var gotoBlock = graph.Blocks.Single(b => b.Statements.Any(s => s.Kind == BoundNodeKind.GotoStatement));
        var labelBlock = graph.Blocks.Single(b => b.Statements.Any(s => s.Kind == BoundNodeKind.LabelStatement));
        Assert.Contains(labelBlock, gotoBlock.Outgoing.Select(branch => branch.To));
        Assert.DoesNotContain(graph.End, gotoBlock.Outgoing.Select(branch => branch.To));
    }
}
