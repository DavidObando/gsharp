// <copyright file="ProtectedRegionBranchRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Collections.Immutable

/// Routes branches that enter a protected try region through
/// legal outside-entry and inside-dispatch points.
internal shared class ProtectedRegionBranchRewriter {
    private struct Route {
        init(selector int32, entryLabel BoundLabel) {
            Selector = selector
            EntryLabel = entryLabel
        }

        prop Selector int32 {
            get;
        }

        prop EntryLabel BoundLabel {
            get;
        }
    }

    private struct DispatchEntry {
        init(selector int32, target BoundLabel) {
            Selector = selector
            Target = target
        }

        prop Selector int32 {
            get;
        }

        prop Target BoundLabel {
            get;
        }
    }

    private class Plan {
        init() {
            Routes = Dictionary[BoundStatement, Route]()
            EntryLabels = Dictionary[BoundTryStatement, BoundLabel]()
            DispatchEntries = Dictionary[BoundTryStatement, List[DispatchEntry]]()
            RoutedTargets = HashSet[BoundLabel]()
        }

        prop Routes Dictionary[BoundStatement, Route] {
            get;
        }

        prop EntryLabels Dictionary[BoundTryStatement, BoundLabel] {
            get;
        }

        prop DispatchEntries Dictionary[BoundTryStatement, List[DispatchEntry]] {
            get;
        }

        prop RoutedTargets HashSet[BoundLabel] {
            get;
        }

        prop HasRoutes bool -> Routes.Count != 0
    }

    private class Planner {
        private let analysis ProtectedRegionBranchAnalysis

        private init(analysis ProtectedRegionBranchAnalysis) {
            this.analysis = analysis
        }

        private func Build() Plan {
            let plan = Plan()
            let selectors = Dictionary[BoundLabel, int32]()
            var nextSelector = 1
            var nextEntry = 0
            for branch in analysis.Branches {
                if !analysis.TryGetLabelRegions(branch.Target, out var targetRegions) {
                    continue
                }
                var commonDepth = 0
                while commonDepth < branch
                    .Regions
                    .Length &&
                    commonDepth < targetRegions.Length &&
                    object.ReferenceEquals(branch.Regions[commonDepth], targetRegions[commonDepth]) {
                    commonDepth++
                }
                if commonDepth == targetRegions.Length {
                    continue
                }
                if !selectors.TryGetValue(branch.Target, out var selector) {
                    selector = nextSelector
                    nextSelector++
                    selectors[branch.Target] = selector
                    plan.RoutedTargets.Add(branch.Target)
                }
                let EntryLabel = func (tryStatement BoundTryStatement) BoundLabel {
                    if !plan.EntryLabels.TryGetValue(tryStatement, out var label) {
                        label = BoundLabel("<>ai_seh_entry_" + nextEntry.ToString())
                        nextEntry++
                        plan.EntryLabels[tryStatement] = label
                    }
                    return label
                }
                plan.Routes[branch.Statement] = Route(selector, EntryLabel(targetRegions[commonDepth]))
                for var depth = commonDepth; depth < targetRegions.Length; depth++ {
                    let region = targetRegions[depth]
                    let dispatchTarget = if depth + 1 == targetRegions.Length {
                        branch.Target
                    } else {
                        EntryLabel(targetRegions[depth + 1])
                    }
                    if !plan.DispatchEntries.TryGetValue(region, out var entries) {
                        entries = List[DispatchEntry]()
                        plan.DispatchEntries[region] = entries
                    }
                    var duplicate = false
                    for entry in entries {
                        if entry.Selector == selector && object.ReferenceEquals(entry.Target, dispatchTarget) {
                            duplicate = true
                            break
                        }
                    }
                    if !duplicate {
                        entries.Add(DispatchEntry(selector, dispatchTarget))
                    }
                }
            }
            return plan
        }

        shared {
            func Create(body BoundStatement) Plan -> Planner(ProtectedRegionBranchAnalysis.Create(body)).Build()
        }
    }

    private class Rewriter : BoundTreeRewriter {
        private let plan Plan
        private let selector LocalVariableSymbol
        private var skipOrdinal int32

        init(plan Plan, selector LocalVariableSymbol) {
            this.plan = plan
            this.selector = selector
        }

        protected override func RewriteGotoStatement(node BoundGotoStatement) BoundStatement {
            if !plan.Routes.TryGetValue(node, out var route) {
                return node
            }
            return BoundBlockStatement(
                nil,
                ImmutableArray.Create[BoundStatement](
                    AssignSelector(route.Selector),
                    BoundGotoStatement(nil, route.EntryLabel)
                )
            )
        }

        protected override func RewriteConditionalGotoStatement(node BoundConditionalGotoStatement) BoundStatement {
            if !plan.Routes.TryGetValue(node, out var route) {
                return base.RewriteConditionalGotoStatement(node)
            }
            let skip = BoundLabel("<>ai_seh_skip_" + skipOrdinal++.ToString())
            return BoundBlockStatement(
                nil,
                ImmutableArray.Create[BoundStatement](
                    BoundConditionalGotoStatement(
                        nil,
                        skip,
                        RewriteExpression(node.Condition),
                        jumpIfTrue: !node.JumpIfTrue
                    ),
                    AssignSelector(route.Selector),
                    BoundGotoStatement(nil, route.EntryLabel),
                    BoundLabelStatement(nil, skip)
                )
            )
        }

        protected override func RewriteLabelStatement(node BoundLabelStatement) BoundStatement {
            if !plan.RoutedTargets.Contains(node.Label) {
                return node
            }
            return BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](node, AssignSelector(0)))
        }

        protected override func RewriteTryStatement(node BoundTryStatement) BoundStatement {
            var result = cast[BoundTryStatement](base.RewriteTryStatement(node))
            if plan.DispatchEntries.TryGetValue(node, out var entries) {
                let statements = ImmutableArray.CreateBuilder[BoundStatement]()
                for entry in entries {
                    statements.Add(
                        BoundConditionalGotoStatement(
                            nil,
                            entry.Target,
                            BoundBinaryExpression(
                                nil,
                                BoundVariableExpression(nil, selector),
                                Invariant.Required(
                                    BoundBinaryOperator.Bind(
                                        SyntaxKind.EqualsEqualsToken,
                                        TypeSymbol.Int32,
                                        TypeSymbol.Int32
                                    ),
                                    "int32 equality operator exists for protected-region dispatch",
                                    expression: `BoundBinaryOperator.Bind(
                                    SyntaxKind.EqualsEqualsToken,
                                    TypeSymbol.Int32,
                                    TypeSymbol.Int32)`
                                ),
                                BoundLiteralExpression(nil, entry.Selector)
                            ),
                            jumpIfTrue: true
                        )
                    )
                }
                if result.TryBlock is BoundBlockStatement block {
                    statements.AddRange(block.Statements)
                } else {
                    statements.Add(result.TryBlock)
                }
                result = BoundTryStatement(
                    nil,
                    BoundBlockStatement(nil, statements.ToImmutable()),
                    result.CatchClauses,
                    result.FinallyBlock
                )
            }
            if !plan.EntryLabels.TryGetValue(node, out var entryLabel) {
                return result
            }
            return BoundBlockStatement(
                nil,
                ImmutableArray.Create[BoundStatement](
                    BoundLabelStatement(nil, entryLabel),
                    BoundExpressionStatement(nil, BoundVariableExpression(nil, selector)),
                    result
                )
            )
        }

        private func AssignSelector(value int32) BoundStatement {
            return BoundExpressionStatement(
                nil,
                BoundAssignmentExpression(nil, selector, BoundLiteralExpression(nil, value))
            )
        }
    }

    func Rewrite(body BoundBlockStatement) BoundBlockStatement {
        let plan = Planner.Create(body)
        if !plan.HasRoutes {
            return body
        }
        let selector = LocalVariableSymbol("<>ai_seh_branch", isReadOnly: false, TypeSymbol.Int32)
        let rewritten = cast[BoundBlockStatement](
            ProtectedRegionBranchRewriter.Rewriter(plan, selector).RewriteStatement(body)
        )
        let statements = ImmutableArray.CreateBuilder[BoundStatement](rewritten.Statements.Length + 1)
        statements.Add(BoundVariableDeclaration(nil, selector, BoundLiteralExpression(nil, 0)))
        statements.AddRange(rewritten.Statements)
        return BoundBlockStatement(nil, statements.ToImmutable())
    }
}
