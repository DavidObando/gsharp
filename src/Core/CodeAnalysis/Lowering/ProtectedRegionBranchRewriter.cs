// <copyright file="ProtectedRegionBranchRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Routes branches that enter a protected try region through
/// legal outside-entry and inside-dispatch points.
/// </summary>
internal static class ProtectedRegionBranchRewriter
{
    public static BoundBlockStatement Rewrite(BoundBlockStatement body)
    {
        var plan = Planner.Create(body);
        if (!plan.HasRoutes)
        {
            return body;
        }

        var selector = new LocalVariableSymbol("<>ai_seh_branch", isReadOnly: false, TypeSymbol.Int32);
        var rewritten = (BoundBlockStatement)new Rewriter(plan, selector).RewriteStatement(body);
        var statements = ImmutableArray.CreateBuilder<BoundStatement>(rewritten.Statements.Length + 1);
        statements.Add(new BoundVariableDeclaration(null, selector, new BoundLiteralExpression(null, 0)));
        statements.AddRange(rewritten.Statements);
        return new BoundBlockStatement(null, statements.ToImmutable());
    }

    private readonly struct Route
    {
        public Route(int selector, BoundLabel entryLabel)
        {
            Selector = selector;
            EntryLabel = entryLabel;
        }

        public int Selector { get; }

        public BoundLabel EntryLabel { get; }
    }

    private readonly struct DispatchEntry
    {
        public DispatchEntry(int selector, BoundLabel target)
        {
            Selector = selector;
            Target = target;
        }

        public int Selector { get; }

        public BoundLabel Target { get; }
    }

    private sealed class Plan
    {
        public Dictionary<BoundStatement, Route> Routes { get; } = new();

        public Dictionary<BoundTryStatement, BoundLabel> EntryLabels { get; } = new();

        public Dictionary<BoundTryStatement, List<DispatchEntry>> DispatchEntries { get; } = new();

        public HashSet<BoundLabel> RoutedTargets { get; } = new();

        public bool HasRoutes => Routes.Count != 0;
    }

    private sealed class Planner
    {
        private readonly ProtectedRegionBranchAnalysis analysis;

        private Planner(ProtectedRegionBranchAnalysis analysis)
        {
            this.analysis = analysis;
        }

        public static Plan Create(BoundStatement body)
            => new Planner(ProtectedRegionBranchAnalysis.Create(body)).Build();

        private Plan Build()
        {
            var plan = new Plan();
            var selectors = new Dictionary<BoundLabel, int>();
            var nextSelector = 1;
            var nextEntry = 0;

            foreach (var branch in analysis.Branches)
            {
                if (!analysis.TryGetLabelRegions(branch.Target, out var targetRegions))
                {
                    continue;
                }

                var commonDepth = 0;
                while (commonDepth < branch.Regions.Length
                    && commonDepth < targetRegions.Length
                    && ReferenceEquals(branch.Regions[commonDepth], targetRegions[commonDepth]))
                {
                    commonDepth++;
                }

                if (commonDepth == targetRegions.Length)
                {
                    continue;
                }

                if (!selectors.TryGetValue(branch.Target, out var selector))
                {
                    selector = nextSelector++;
                    selectors[branch.Target] = selector;
                    plan.RoutedTargets.Add(branch.Target);
                }

                BoundLabel EntryLabel(BoundTryStatement tryStatement)
                {
                    if (!plan.EntryLabels.TryGetValue(tryStatement, out var label))
                    {
                        label = new BoundLabel("<>ai_seh_entry_" + nextEntry++);
                        plan.EntryLabels[tryStatement] = label;
                    }

                    return label;
                }

                plan.Routes[branch.Statement] = new Route(selector, EntryLabel(targetRegions[commonDepth]));

                for (var depth = commonDepth; depth < targetRegions.Length; depth++)
                {
                    var region = targetRegions[depth];
                    var dispatchTarget = depth + 1 == targetRegions.Length
                        ? branch.Target
                        : EntryLabel(targetRegions[depth + 1]);

                    if (!plan.DispatchEntries.TryGetValue(region, out var entries))
                    {
                        entries = new List<DispatchEntry>();
                        plan.DispatchEntries[region] = entries;
                    }

                    var duplicate = false;
                    foreach (var entry in entries)
                    {
                        if (entry.Selector == selector && ReferenceEquals(entry.Target, dispatchTarget))
                        {
                            duplicate = true;
                            break;
                        }
                    }

                    if (!duplicate)
                    {
                        entries.Add(new DispatchEntry(selector, dispatchTarget));
                    }
                }
            }

            return plan;
        }
    }

    private sealed class Rewriter : BoundTreeRewriter
    {
        private readonly Plan plan;
        private readonly LocalVariableSymbol selector;
        private int skipOrdinal;

        public Rewriter(Plan plan, LocalVariableSymbol selector)
        {
            this.plan = plan;
            this.selector = selector;
        }

        protected override BoundStatement RewriteGotoStatement(BoundGotoStatement node)
        {
            if (!plan.Routes.TryGetValue(node, out var route))
            {
                return node;
            }

            return new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(
                AssignSelector(route.Selector),
                new BoundGotoStatement(null, route.EntryLabel)));
        }

        protected override BoundStatement RewriteConditionalGotoStatement(BoundConditionalGotoStatement node)
        {
            if (!plan.Routes.TryGetValue(node, out var route))
            {
                return base.RewriteConditionalGotoStatement(node);
            }

            var skip = new BoundLabel("<>ai_seh_skip_" + skipOrdinal++);
            return new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(
                new BoundConditionalGotoStatement(
                    null,
                    skip,
                    RewriteExpression(node.Condition),
                    jumpIfTrue: !node.JumpIfTrue),
                AssignSelector(route.Selector),
                new BoundGotoStatement(null, route.EntryLabel),
                new BoundLabelStatement(null, skip)));
        }

        protected override BoundStatement RewriteLabelStatement(BoundLabelStatement node)
        {
            if (!plan.RoutedTargets.Contains(node.Label))
            {
                return node;
            }

            return new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(
                node,
                AssignSelector(0)));
        }

        protected override BoundStatement RewriteTryStatement(BoundTryStatement node)
        {
            var result = (BoundTryStatement)base.RewriteTryStatement(node);
            if (plan.DispatchEntries.TryGetValue(node, out var entries))
            {
                var statements = ImmutableArray.CreateBuilder<BoundStatement>();
                foreach (var entry in entries)
                {
                    statements.Add(new BoundConditionalGotoStatement(
                        null,
                        entry.Target,
                        new BoundBinaryExpression(
                            null,
                            new BoundVariableExpression(null, selector),
                            BoundBinaryOperator.Bind(
                                SyntaxKind.EqualsEqualsToken,
                                TypeSymbol.Int32,
                                TypeSymbol.Int32),
                            new BoundLiteralExpression(null, entry.Selector)),
                        jumpIfTrue: true));
                }

                if (result.TryBlock is BoundBlockStatement block)
                {
                    statements.AddRange(block.Statements);
                }
                else
                {
                    statements.Add(result.TryBlock);
                }

                result = new BoundTryStatement(
                    null,
                    new BoundBlockStatement(null, statements.ToImmutable()),
                    result.CatchClauses,
                    result.FinallyBlock);
            }

            if (!plan.EntryLabels.TryGetValue(node, out var entryLabel))
            {
                return result;
            }

            return new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(
                new BoundLabelStatement(null, entryLabel),
                new BoundExpressionStatement(null, new BoundVariableExpression(null, selector)),
                result));
        }

        private BoundStatement AssignSelector(int value)
        {
            return new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(
                    null,
                    selector,
                    new BoundLiteralExpression(null, value)));
        }
    }
}
