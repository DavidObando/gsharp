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
    /// <param name="assignedValueType">The static type of the right-hand side
    /// value <em>before</em> any conversion to the variable's declared type.
    /// Issue #1123: the statement binder consults this to decide whether an
    /// assignment of a non-nullable value narrows a nullable <c>var</c> local
    /// for subsequent reads. <see langword="null"/> falls back to
    /// <see cref="Expression"/>'s (post-conversion) type.</param>
    public BoundAssignmentExpression(SyntaxNode syntax, VariableSymbol variable, BoundExpression expression, TypeSymbol assignedValueType = null)
        : base(syntax)
    {
        Variable = variable;
        Expression = expression;
        AssignedValueType = assignedValueType ?? expression.Type;
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

    /// <summary>
    /// Gets the static type of the right-hand side value before conversion to
    /// the variable's declared type (issue #1123). Used by the statement binder
    /// to drive assignment-based smart-cast narrowing of nullable <c>var</c>
    /// locals.
    /// </summary>
    public TypeSymbol AssignedValueType { get; }
}
