// <copyright file="BoundLabelStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound label statement.
/// </summary>
public sealed class BoundLabelStatement : BoundStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundLabelStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="label">The label.</param>
    public BoundLabelStatement(SyntaxNode syntax, BoundLabel label)
        : base(syntax)
    {
        Label = label;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.LabelStatement;

    /// <summary>
    /// Gets the label.
    /// </summary>
    public BoundLabel Label { get; }
}
