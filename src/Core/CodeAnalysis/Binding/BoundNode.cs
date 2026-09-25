// <copyright file="BoundNode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Abstract base for a bound node.
/// </summary>
public abstract class BoundNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundNode"/> class.
    /// </summary>
    /// <param name="syntax">
    /// The originating <see cref="SyntaxNode"/> this bound node was produced from, or
    /// <c>null</c> when the node was synthesised by a lowering pass and has no direct
    /// source counterpart (in which case the emitter will anchor a hidden
    /// <c>0xfeefee</c> sequence point on it).
    /// </param>
    protected BoundNode(SyntaxNode? syntax)
    {
        Syntax = syntax;
    }

    /// <summary>
    /// Gets the kind of bound node for this instance.
    /// </summary>
    public abstract BoundNodeKind Kind { get; }

    /// <summary>
    /// Gets the originating <see cref="SyntaxNode"/>, or <c>null</c> when this node was
    /// synthesised by a lowering pass and has no direct source counterpart.
    /// On the pre-lowering <see cref="BoundProgram"/> the binder guarantees an
    /// anchor on every statement, expression, and pattern (ADR-0169): nodes the
    /// construction site did not anchor are stamped by the bind dispatchers
    /// and, failing that, inherit the nearest anchored ancestor's syntax.
    /// </summary>
    public SyntaxNode? Syntax { get; private set; }

    /// <summary>
    /// Gets this node's immediate child statements, expressions and patterns,
    /// in the order <see cref="BoundTreeWalker"/> visits them — the Roslyn
    /// <c>IOperation.ChildOperations</c> analogue (ADR-0169, issue #4436).
    /// Helper nodes that are not themselves statements, expressions or
    /// patterns (a switch arm, a catch clause) are transparent: their own
    /// children are listed in their place.
    /// </summary>
    public ImmutableArray<BoundNode> ChildNodes
    {
        get
        {
            var collector = new NodeCollector(this, recurse: false);
            collector.Visit(this);
            return collector.Nodes.ToImmutable();
        }
    }

    /// <summary>
    /// Enumerates every node below this one, depth first — the Roslyn
    /// <c>OperationExtensions.Descendants()</c> analogue.
    /// </summary>
    /// <returns>The descendants, excluding this node.</returns>
    public IEnumerable<BoundNode> Descendants()
    {
        // One walk over the whole subtree, in pre-order: the same order as
        // recursing through ChildNodes, without building a child list per node.
        var collector = new NodeCollector(this, recurse: true);
        collector.Visit(this);
        return collector.Nodes.ToImmutable();
    }

    /// <summary>
    /// Enumerates this node and every node below it, depth first — the Roslyn
    /// <c>OperationExtensions.DescendantsAndSelf()</c> analogue.
    /// </summary>
    /// <returns>This node, then its descendants.</returns>
    public IEnumerable<BoundNode> DescendantsAndSelf()
    {
        yield return this;
        foreach (var descendant in Descendants())
        {
            yield return descendant;
        }
    }

    /// <inheritdoc/>
    public override string ToString()
    {
        using (var writer = new StringWriter())
        {
            this.WriteTo(writer);
            return writer.ToString();
        }
    }

    /// <summary>
    /// Anchors this node to <paramref name="syntax"/> if it has no anchor yet.
    /// Idempotent by construction — an existing anchor is never replaced — so
    /// re-binding or body-cache reuse cannot change an observed location.
    /// </summary>
    /// <param name="syntax">The syntax to anchor to.</param>
    internal void AnchorSyntax(SyntaxNode? syntax)
    {
        if (Syntax is null && syntax is not null)
        {
            Syntax = syntax;
        }
    }

    /// <summary>
    /// Records the statements, expressions and patterns below a root, in the
    /// order the default walker visits them: one level below it
    /// (<c>recurse: false</c>), or the whole subtree in pre-order
    /// (<c>recurse: true</c>).
    /// </summary>
    private sealed class NodeCollector : BoundTreeWalker
    {
        private readonly BoundNode root;
        private readonly bool recurse;

        public NodeCollector(BoundNode root, bool recurse)
        {
            this.root = root;
            this.recurse = recurse;
        }

        public ImmutableArray<BoundNode>.Builder Nodes { get; } = ImmutableArray.CreateBuilder<BoundNode>();

        public override void VisitStatement(BoundStatement? node)
        {
            if (Take(node))
            {
                base.VisitStatement(node);
            }
        }

        public override void VisitExpression(BoundExpression? node)
        {
            if (Take(node))
            {
                base.VisitExpression(node);
            }
        }

        public override void VisitPattern(BoundPattern? node)
        {
            if (Take(node))
            {
                base.VisitPattern(node);
            }
        }

        // Whether the base walker descends into the node. The root is never
        // recorded; any other node is recorded, and descended into only when
        // collecting the whole subtree.
        private bool Take(BoundNode? node)
        {
            if (node == null)
            {
                return false;
            }

            if (ReferenceEquals(node, root))
            {
                return true;
            }

            Nodes.Add(node);
            return recurse;
        }
    }
}
