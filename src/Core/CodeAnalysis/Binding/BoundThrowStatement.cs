#nullable disable

// <copyright file="BoundThrowStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound <c>throw expr</c> statement.
/// </summary>
public sealed class BoundThrowStatement : BoundStatement
{
    /// <summary>Initializes a new instance of the <see cref="BoundThrowStatement"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The bound exception expression.</param>
    public BoundThrowStatement(SyntaxNode syntax, BoundExpression expression)
        : base(syntax)
    {
        Expression = expression;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ThrowStatement;

    /// <summary>Gets the bound exception expression.</summary>
    public BoundExpression Expression { get; }
}
