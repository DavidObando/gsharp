// <copyright file="BoundGotoStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound goto statement.
/// </summary>
public sealed class BoundGotoStatement : BoundStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundGotoStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="label">The label.</param>
    public BoundGotoStatement(SyntaxNode syntax, BoundLabel label)
        : base(syntax)
    {
        Label = label;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.GotoStatement;

    /// <summary>
    /// Gets the label.
    /// </summary>
    public BoundLabel Label { get; }
}
