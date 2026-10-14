// <copyright file="AsyncBoundTreeQueries.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic

/// Lightweight read-only queries over a bound subtree that the async
/// lowering passes share. None of these methods mutate the tree.
/// @remarks These helpers are intentionally implemented on top of
/// (cref:BoundTreeRewriter) rather than a separate visitor: the
/// rewriter's overrides return the same node when nothing changes, so
/// no allocation is triggered when a query merely observes nodes. This
/// avoids adding yet another tree-walking infrastructure to the codebase
/// while still letting each query short-circuit cheaply (see
/// (cref:HasAwait(BoundStatement))).
shared class AsyncBoundTreeQueries {
    /// Walks a subtree looking for an await, optionally memoizing per-node
    /// results (reference-keyed) so overlapping queries over the same tree
    /// reuse work instead of re-walking already-visited subtrees (issue #1625).
    /// (cref:VisitStatement) and (cref:VisitExpression) are the
    /// sole dispatch entry points every recursive descent in
    /// (cref:BoundTreeWalker) funnels through, so overriding them here
    /// is sufficient to intercept — and memoize — every node in the walk.
    private class AwaitDetector : BoundTreeWalker {
        private let memo Dictionary[BoundNode, bool]?

        init(memo Dictionary[BoundNode, bool]?) {
            this.memo = memo
        }

        prop Found bool {
            get;
            private set;
        }

        override func VisitStatement(node BoundStatement?) {
            if node == nil {
                return
            }
            if memo != nil && memo.TryGetValue(node, out var cached) {
                Found = Found || cached
                return
            }
            let outerFound = Found
            Found = false
            base.VisitStatement(node)
            memo?.Add(node, Found)
            Found = Found || outerFound
        }

        override func VisitExpression(node BoundExpression?) {
            if node == nil {
                return
            }
            if memo != nil && memo.TryGetValue(node, out var cached) {
                Found = Found || cached
                return
            }
            let outerFound = Found
            Found = false
            base.VisitExpression(node)
            memo?.Add(node, Found)
            Found = Found || outerFound
        }

        protected override func VisitAwaitExpression(node BoundAwaitExpression) {
            Found = true
        }
    }

    private class AwaitSyntaxFinder : BoundTreeWalker {
        prop Syntax SyntaxNode? {
            get;
            private set;
        }

        protected override func VisitAwaitExpression(node BoundAwaitExpression) {
            Syntax ??= node.Syntax
        }
    }

    /// Creates a fresh, reference-keyed memo for (cref:HasAwait(BoundStatement, Dictionary{BoundNode,
    /// bool}))
    /// and (cref:HasAwait(BoundExpression, Dictionary{BoundNode, bool})). Callers that query the
    /// same bound tree (or overlapping subtrees) many times during one lowering pass — e.g.
    /// `SpillSequenceSpiller`'s per-recursion-level probes — should create one memo per pass and
    /// pass it to every call so each node's "contains await" result is computed once and reused (issue
    /// #1625). (cref:BoundNode) does not override `Equals`/`GetHashCode`, so the default
    /// dictionary comparer already keys by reference identity; rewriting a subtree produces new node
    /// instances, so a stale entry can never be observed for a node that was actually mutated.
    /// @returns A new, empty memo dictionary.
    func CreateHasAwaitMemo() Dictionary[BoundNode, bool] -> Dictionary[BoundNode, bool]()

    /// Returns `true` when the given bound statement subtree
    /// contains at least one (cref:BoundAwaitExpression).
    /// @param statement The bound statement to inspect.
    /// @returns Whether the subtree contains an `await`.
    func HasAwait(statement BoundStatement) bool -> HasAwait(statement, memo: nil)

    /// Returns `true` when the given bound statement subtree
    /// contains at least one (cref:BoundAwaitExpression), consulting and
    /// populating [`memo`](paramref) (see (cref:CreateHasAwaitMemo))
    /// so repeated/nested queries over the same nodes are O(1) after the first visit.
    /// @param statement The bound statement to inspect.
    /// @param memo An optional reference-keyed cache shared across calls in one lowering pass.
    /// @returns Whether the subtree contains an `await`.
    func HasAwait(statement BoundStatement?, memo Dictionary[BoundNode, bool]?) bool {
        if statement == nil {
            return false
        }
        let probe = AwaitDetector(memo)
        probe.VisitStatement(statement)
        return probe.Found
    }

    /// Returns `true` when the given bound expression subtree
    /// contains at least one (cref:BoundAwaitExpression).
    /// @param expression The bound expression to inspect.
    /// @returns Whether the subtree contains an `await`.
    func HasAwait(expression BoundExpression) bool -> HasAwait(expression, memo: nil)

    /// Returns `true` when the given bound expression subtree
    /// contains at least one (cref:BoundAwaitExpression), consulting and
    /// populating [`memo`](paramref) (see (cref:CreateHasAwaitMemo))
    /// so repeated/nested queries over the same nodes are O(1) after the first visit.
    /// @param expression The bound expression to inspect.
    /// @param memo An optional reference-keyed cache shared across calls in one lowering pass.
    /// @returns Whether the subtree contains an `await`.
    func HasAwait(expression BoundExpression?, memo Dictionary[BoundNode, bool]?) bool {
        if expression == nil {
            return false
        }
        let probe = AwaitDetector(memo)
        probe.VisitExpression(expression)
        return probe.Found
    }

    /// Finds the syntax of the first (cref:BoundAwaitExpression) in
    /// the given subtree, or `null` when none is found.
    /// Used by `SpillSequenceSpiller` (issue #1619) to anchor a
    /// diagnostic at the actual `await` keyword when the enclosing
    /// composite expression's own `Syntax` is unavailable — some
    /// upstream rewriter passes rebuild nodes with a `null` syntax when
    /// nothing else about them changes structurally.
    /// @param expression The bound expression to inspect.
    /// @returns The first await's syntax node, or `null`.
    func FindFirstAwaitSyntax(expression BoundExpression?) SyntaxNode? {
        if expression == nil {
            return nil
        }
        let probe = AwaitSyntaxFinder()
        probe.Visit(expression)
        return probe.Syntax
    }
}
