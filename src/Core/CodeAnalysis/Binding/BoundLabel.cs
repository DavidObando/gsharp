// <copyright file="BoundLabel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound label.
/// </summary>
public sealed class BoundLabel
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundLabel"/> class.
    /// </summary>
    /// <param name="name">The label name.</param>
    /// <param name="declaringSyntax">
    /// The originating label-declaration syntax (may be <see langword="null"/>
    /// for compiler-synthesised labels — break/continue/exit anchors emitted by
    /// the lowering pipeline, async-resume points, etc.). Used by the Portable
    /// PDB emitter to anchor branch-target sequence points per ADR-0027 §7.7a.
    /// </param>
    public BoundLabel(string name, SyntaxNode declaringSyntax = null)
    {
        Name = name;
        DeclaringSyntax = declaringSyntax;
    }

    /// <summary>
    /// Gets the label name.
    /// </summary>
    public string Name { get; }

    /// <summary>
    /// Gets the originating label-declaration syntax for this label, or
    /// <see langword="null"/> when the label is compiler-synthesised.
    /// </summary>
    public SyntaxNode DeclaringSyntax { get; }

    /// <inheritdoc/>
    public override string ToString() => Name;
}
