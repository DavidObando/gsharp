// <copyright file="SyntaxAnchoringWalker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Fills the <see cref="BoundNode.Syntax"/> anchor of every statement,
/// expression, and pattern that construction and the bind dispatchers left
/// unanchored, inheriting the nearest anchored ancestor's syntax (ADR-0169).
/// Runs once per member body at the end of <c>Binder.BindProgram</c>, so the
/// pre-lowering-visible <see cref="BoundProgram"/> guarantees a non-null
/// anchor on every dispatchable node — synthesized lowering nodes report at
/// their enclosing construct, mirroring how the emitter anchors hidden
/// sequence points. Idempotent: an existing anchor is never replaced.
/// </summary>
internal sealed class SyntaxAnchoringWalker : BoundTreeWalker
{
    private SyntaxNode? anchor;

    /// <summary>
    /// Anchors every node reachable from <paramref name="body"/>.
    /// </summary>
    /// <param name="body">The bound body to anchor.</param>
    /// <param name="fallbackAnchor">The anchor used until a node with its own syntax is found (the member's declaration).</param>
    public static void Anchor(BoundNode? body, SyntaxNode? fallbackAnchor)
    {
        if (body is null)
        {
            return;
        }

        new SyntaxAnchoringWalker { anchor = fallbackAnchor }.Visit(body);
    }

    /// <inheritdoc/>
    public override void VisitStatement(BoundStatement? node) => VisitAnchored(node, base.VisitStatement);

    /// <inheritdoc/>
    public override void VisitExpression(BoundExpression? node) => VisitAnchored(node, base.VisitExpression);

    /// <inheritdoc/>
    public override void VisitPattern(BoundPattern? node) => VisitAnchored(node, base.VisitPattern);

    private void VisitAnchored<TNode>(TNode? node, System.Action<TNode?> visitBase)
        where TNode : BoundNode
    {
        if (node is null)
        {
            return;
        }

        var saved = anchor;
        if (node.Syntax is null)
        {
            // BoundErrorExpression keeps its null anchor: null-vs-non-null
            // Syntax is the binder's defer-and-rebind sentinel, and cached
            // bodies may hold error nodes from partially-bound programs.
            if (node is not BoundErrorExpression)
            {
                node.AnchorSyntax(anchor);
            }
        }
        else
        {
            anchor = node.Syntax;
        }

        visitBase(node);
        anchor = saved;
    }
}
