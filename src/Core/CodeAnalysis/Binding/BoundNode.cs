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
            var collector = new ChildCollector(this);
            collector.Visit(this);
            return collector.Children.ToImmutable();
        }
    }

    /// <summary>
    /// Enumerates every node below this one, depth first — the Roslyn
    /// <c>OperationExtensions.Descendants()</c> analogue.
    /// </summary>
    /// <returns>The descendants, excluding this node.</returns>
    public IEnumerable<BoundNode> Descendants()
    {
        var pending = new Stack<BoundNode>();
        PushChildren(pending, this);
        while (pending.Count > 0)
        {
            var current = pending.Pop();
            yield return current;
            PushChildren(pending, current);
        }
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

    private static void PushChildren(Stack<BoundNode> pending, BoundNode node)
    {
        var children = node.ChildNodes;
        for (var i = children.Length - 1; i >= 0; i--)
        {
            pending.Push(children[i]);
        }
    }

    /// <summary>
    /// Records the statements, expressions and patterns one level below a
    /// root, by letting the default walker recurse from the root only.
    /// </summary>
    private sealed class ChildCollector : BoundTreeWalker
    {
        private readonly BoundNode root;

        public ChildCollector(BoundNode root)
        {
            this.root = root;
        }

        public ImmutableArray<BoundNode>.Builder Children { get; } = ImmutableArray.CreateBuilder<BoundNode>();

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

        // True only for the root, whose children the base walker then visits;
        // every other node is recorded as a child and not descended into.
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

            Children.Add(node);
            return false;
        }
    }
}
