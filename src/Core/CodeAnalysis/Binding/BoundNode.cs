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
    private ImmutableArray<BoundNode> childNodes;

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
    /// children are listed in their place. Three shapes follow Roslyn's
    /// operation tree rather than the compiler walker:
    /// <list type="bullet">
    /// <item>a function literal's child is its body, as an
    /// <c>IAnonymousFunctionOperation</c>'s is (the walker treats the body as
    /// a separate scope and does not enter it);</item>
    /// <item>an assignment's children are its target, then its value;</item>
    /// <item>a plain <c>x is T</c> has only its operand as a child, as an
    /// <c>IIsTypeOperation</c> does; the type pattern G# binds under it is not
    /// listed.</item>
    /// </list>
    /// </summary>
    public ImmutableArray<BoundNode> ChildNodes
    {
        get
        {
            // A bound tree does not change once built, so each node's one-level
            // list is built once. Across a tree that is one entry per node, the
            // size of the tree itself.
            if (childNodes.IsDefault)
            {
                var collector = new NodeCollector(this);
                collector.Visit(this);

                // The builder is not reused, so its contents move without a copy.
                ImmutableInterlocked.InterlockedInitialize(ref childNodes, collector.Nodes.DrainToImmutable());
            }

            return childNodes;
        }
    }

    /// <summary>
    /// Enumerates every node below this one, depth first — the Roslyn
    /// <c>OperationExtensions.Descendants()</c> analogue.
    /// </summary>
    /// <returns>The descendants, excluding this node.</returns>
    public IEnumerable<BoundNode> Descendants()
    {
        // Lazy and pre-order, like Roslyn's: it walks the cached ChildNodes
        // lists, so a partial enumeration stops early and nothing retains a
        // copy of the subtree.
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
    /// The syntax of the first node, in pre-order, that has one. Stops at the
    /// first hit rather than listing the subtree.
    /// </summary>
    /// <returns>The first anchored syntax, or null.</returns>
    internal SyntaxNode? FirstAnchoredSyntax()
    {
        if (Syntax is { } own)
        {
            return own;
        }

        var finder = new FirstSyntaxFinder();
        finder.Visit(this);
        return finder.Found;
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

    private sealed class FirstSyntaxFinder : BoundTreeWalker
    {
        public SyntaxNode? Found { get; private set; }

        public override void VisitStatement(BoundStatement? node)
        {
            if (Look(node))
            {
                base.VisitStatement(node);
            }
        }

        public override void VisitExpression(BoundExpression? node)
        {
            if (Look(node))
            {
                base.VisitExpression(node);
            }
        }

        public override void VisitPattern(BoundPattern? node)
        {
            if (Look(node))
            {
                base.VisitPattern(node);
            }
        }

        // Whether to keep descending: false once anything has been found.
        private bool Look(BoundNode? node)
        {
            if (Found != null || node == null)
            {
                return false;
            }

            Found = node.Syntax;
            return Found == null;
        }
    }

    /// <summary>
    /// Records the statements, expressions and patterns one level below a
    /// root, in the order the default walker visits them, with the
    /// operation-tree overrides described on <see cref="ChildNodes"/>.
    /// </summary>
    private sealed class NodeCollector : BoundTreeWalker
    {
        private readonly BoundNode root;

        public NodeCollector(BoundNode root)
        {
            this.root = root;
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
            if (!Take(node))
            {
                return;
            }

            // The walker leaves a function literal opaque; the operation tree
            // does not. Only the literal itself (the root) lists its body: a
            // literal met as a child was recorded by Take and not entered, so
            // its body never becomes a sibling in its parent's list.
            if (node is BoundFunctionLiteralExpression literal)
            {
                VisitStatement(literal.Body);
                return;
            }

            base.VisitExpression(node);
        }

        public override void VisitPattern(BoundPattern? node)
        {
            if (Take(node))
            {
                base.VisitPattern(node);
            }
        }

        protected override void VisitAssignmentExpression(BoundAssignmentExpression node)
        {
            VisitExpression(node.Target);
            VisitExpression(node.Value);
        }

        protected override void VisitIsExpression(BoundIsExpression node)
        {
            if (node.IsSimpleTypeTest)
            {
                VisitExpression(node.Expression);
                return;
            }

            base.VisitIsExpression(node);
        }

        // Whether the base walker descends into the node: only the root. Any
        // other node is recorded as a child and not entered.
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
            return false;
        }
    }
}
