// <copyright file="BoundReturnStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound return statement.
/// </summary>
public sealed class BoundReturnStatement : BoundStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundReturnStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The expression to return.</param>
    public BoundReturnStatement(SyntaxNode syntax, BoundExpression expression)
        : base(syntax)
    {
        Expression = expression;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ReturnStatement;

    /// <summary>
    /// Gets the expression to return.
    /// </summary>
    public BoundExpression Expression { get; }
}
