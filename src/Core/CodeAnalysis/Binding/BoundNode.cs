#nullable disable

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
    protected BoundNode(SyntaxNode syntax)
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
    /// </summary>
    public SyntaxNode Syntax { get; }

    /// <inheritdoc/>
    public override string ToString()
    {
        using (var writer = new StringWriter())
        {
            this.WriteTo(writer);
            return writer.ToString();
        }
    }
}
