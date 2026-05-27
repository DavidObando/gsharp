// <copyright file="BoundExpressionStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound expression statement.
/// </summary>
public sealed class BoundExpressionStatement : BoundStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundExpressionStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The expression.</param>
    public BoundExpressionStatement(SyntaxNode syntax, BoundExpression expression)
        : base(syntax)
    {
        Expression = expression;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ExpressionStatement;

    /// <summary>
    /// Gets the expression.
    /// </summary>
    public BoundExpression Expression { get; }
}
