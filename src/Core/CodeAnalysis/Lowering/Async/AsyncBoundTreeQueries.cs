// <copyright file="AsyncBoundTreeQueries.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Lightweight read-only queries over a bound subtree that the async
/// lowering passes share. None of these methods mutate the tree.
/// </summary>
/// <remarks>
/// These helpers are intentionally implemented on top of
/// <see cref="BoundTreeRewriter"/> rather than a separate visitor: the
/// rewriter's overrides return the same node when nothing changes, so
/// no allocation is triggered when a query merely observes nodes. This
/// avoids adding yet another tree-walking infrastructure to the codebase
/// while still letting each query short-circuit cheaply (see
/// <see cref="HasAwait(BoundStatement)"/>).
/// </remarks>
public static class AsyncBoundTreeQueries
{
    /// <summary>
    /// Creates a fresh, reference-keyed memo for <see cref="HasAwait(BoundStatement, Dictionary{BoundNode, bool})"/>
    /// and <see cref="HasAwait(BoundExpression, Dictionary{BoundNode, bool})"/>. Callers that query the
    /// same bound tree (or overlapping subtrees) many times during one lowering pass — e.g.
    /// <c>SpillSequenceSpiller</c>'s per-recursion-level probes — should create one memo per pass and
    /// pass it to every call so each node's "contains await" result is computed once and reused (issue
    /// #1625). <see cref="BoundNode"/> does not override <c>Equals</c>/<c>GetHashCode</c>, so the default
    /// dictionary comparer already keys by reference identity; rewriting a subtree produces new node
    /// instances, so a stale entry can never be observed for a node that was actually mutated.
    /// </summary>
    /// <returns>A new, empty memo dictionary.</returns>
    public static Dictionary<BoundNode, bool> CreateHasAwaitMemo() => new();

    /// <summary>
    /// Returns <see langword="true"/> when the given bound statement subtree
    /// contains at least one <see cref="BoundAwaitExpression"/>.
    /// </summary>
    /// <param name="statement">The bound statement to inspect.</param>
    /// <returns>Whether the subtree contains an <c>await</c>.</returns>
    public static bool HasAwait(BoundStatement statement) => HasAwait(statement, memo: null);

    /// <summary>
    /// Returns <see langword="true"/> when the given bound statement subtree
    /// contains at least one <see cref="BoundAwaitExpression"/>, consulting and
    /// populating <paramref name="memo"/> (see <see cref="CreateHasAwaitMemo"/>)
    /// so repeated/nested queries over the same nodes are O(1) after the first visit.
    /// </summary>
    /// <param name="statement">The bound statement to inspect.</param>
    /// <param name="memo">An optional reference-keyed cache shared across calls in one lowering pass.</param>
    /// <returns>Whether the subtree contains an <c>await</c>.</returns>
    public static bool HasAwait(BoundStatement statement, Dictionary<BoundNode, bool> memo)
    {
        if (statement == null)
        {
            return false;
        }

        var probe = new AwaitDetector(memo);
        probe.VisitStatement(statement);
        return probe.Found;
    }

    /// <summary>
    /// Returns <see langword="true"/> when the given bound expression subtree
    /// contains at least one <see cref="BoundAwaitExpression"/>.
    /// </summary>
    /// <param name="expression">The bound expression to inspect.</param>
    /// <returns>Whether the subtree contains an <c>await</c>.</returns>
    public static bool HasAwait(BoundExpression expression) => HasAwait(expression, memo: null);

    /// <summary>
    /// Returns <see langword="true"/> when the given bound expression subtree
    /// contains at least one <see cref="BoundAwaitExpression"/>, consulting and
    /// populating <paramref name="memo"/> (see <see cref="CreateHasAwaitMemo"/>)
    /// so repeated/nested queries over the same nodes are O(1) after the first visit.
    /// </summary>
    /// <param name="expression">The bound expression to inspect.</param>
    /// <param name="memo">An optional reference-keyed cache shared across calls in one lowering pass.</param>
    /// <returns>Whether the subtree contains an <c>await</c>.</returns>
    public static bool HasAwait(BoundExpression expression, Dictionary<BoundNode, bool> memo)
    {
        if (expression == null)
        {
            return false;
        }

        var probe = new AwaitDetector(memo);
        probe.VisitExpression(expression);
        return probe.Found;
    }

    /// <summary>
    /// Finds the syntax of the first <see cref="BoundAwaitExpression"/> in
    /// the given subtree, or <see langword="null"/> when none is found.
    /// Used by <c>SpillSequenceSpiller</c> (issue #1619) to anchor a
    /// diagnostic at the actual <c>await</c> keyword when the enclosing
    /// composite expression's own <c>Syntax</c> is unavailable — some
    /// upstream rewriter passes rebuild nodes with a <c>null</c> syntax when
    /// nothing else about them changes structurally.
    /// </summary>
    /// <param name="expression">The bound expression to inspect.</param>
    /// <returns>The first await's syntax node, or <see langword="null"/>.</returns>
    public static SyntaxNode FindFirstAwaitSyntax(BoundExpression expression)
    {
        if (expression == null)
        {
            return null;
        }

        var probe = new AwaitSyntaxFinder();
        probe.Visit(expression);
        return probe.Syntax;
    }

    /// <summary>
    /// Walks a subtree looking for an await, optionally memoizing per-node
    /// results (reference-keyed) so overlapping queries over the same tree
    /// reuse work instead of re-walking already-visited subtrees (issue #1625).
    /// <see cref="VisitStatement"/> and <see cref="VisitExpression"/> are the
    /// sole dispatch entry points every recursive descent in
    /// <see cref="BoundTreeWalker"/> funnels through, so overriding them here
    /// is sufficient to intercept — and memoize — every node in the walk.
    /// </summary>
    private sealed class AwaitDetector : BoundTreeWalker
    {
        private readonly Dictionary<BoundNode, bool> memo;

        public AwaitDetector(Dictionary<BoundNode, bool> memo)
        {
            this.memo = memo;
        }

        public bool Found { get; private set; }

        public override void VisitStatement(BoundStatement node)
        {
            if (node == null)
            {
                return;
            }

            if (memo != null && memo.TryGetValue(node, out var cached))
            {
                Found = Found || cached;
                return;
            }

            var outerFound = Found;
            Found = false;
            base.VisitStatement(node);
            memo?.Add(node, Found);
            Found = Found || outerFound;
        }

        public override void VisitExpression(BoundExpression node)
        {
            if (node == null)
            {
                return;
            }

            if (memo != null && memo.TryGetValue(node, out var cached))
            {
                Found = Found || cached;
                return;
            }

            var outerFound = Found;
            Found = false;
            base.VisitExpression(node);
            memo?.Add(node, Found);
            Found = Found || outerFound;
        }

        protected override void VisitAwaitExpression(BoundAwaitExpression node)
        {
            Found = true;
        }
    }

    private sealed class AwaitSyntaxFinder : BoundTreeWalker
    {
        public SyntaxNode Syntax { get; private set; }

        protected override void VisitAwaitExpression(BoundAwaitExpression node)
        {
            Syntax ??= node.Syntax;
        }
    }
}
