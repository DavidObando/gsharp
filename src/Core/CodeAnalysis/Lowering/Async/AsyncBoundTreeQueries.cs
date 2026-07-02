// <copyright file="AsyncBoundTreeQueries.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
    /// Returns <see langword="true"/> when the given bound statement subtree
    /// contains at least one <see cref="BoundAwaitExpression"/>.
    /// </summary>
    /// <param name="statement">The bound statement to inspect.</param>
    /// <returns>Whether the subtree contains an <c>await</c>.</returns>
    public static bool HasAwait(BoundStatement statement)
    {
        if (statement == null)
        {
            return false;
        }

        var probe = new AwaitDetector();
        probe.Visit(statement);
        return probe.Found;
    }

    /// <summary>
    /// Returns <see langword="true"/> when the given bound expression subtree
    /// contains at least one <see cref="BoundAwaitExpression"/>.
    /// </summary>
    /// <param name="expression">The bound expression to inspect.</param>
    /// <returns>Whether the subtree contains an <c>await</c>.</returns>
    public static bool HasAwait(BoundExpression expression)
    {
        if (expression == null)
        {
            return false;
        }

        var probe = new AwaitDetector();
        probe.Visit(expression);
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

    private sealed class AwaitDetector : BoundTreeWalker
    {
        public bool Found { get; private set; }

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
