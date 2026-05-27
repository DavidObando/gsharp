// <copyright file="BoundAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound assignment expression.
/// </summary>
public sealed class BoundAssignmentExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundAssignmentExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="variable">The variable symbol.</param>
    /// <param name="expression">The expression.</param>
    public BoundAssignmentExpression(SyntaxNode syntax, VariableSymbol variable, BoundExpression expression)
        : base(syntax)
    {
        Variable = variable;
        Expression = expression;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.AssignmentExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => Expression.Type;

    /// <summary>
    /// Gets the variable symbol.
    /// </summary>
    public VariableSymbol Variable { get; }

    /// <summary>
    /// Gets the expression.
    /// </summary>
    public BoundExpression Expression { get; }
}
