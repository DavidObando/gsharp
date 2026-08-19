// <copyright file="BoundNode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
}
