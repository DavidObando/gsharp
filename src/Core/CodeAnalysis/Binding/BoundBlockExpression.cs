// <copyright file="BoundBlockExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// An expression that evaluates synthetic statements before yielding a final expression value.
/// </summary>
public sealed class BoundBlockExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundBlockExpression"/> class.</summary>
    /// <param name="statements">The synthetic prefix statements.</param>
    /// <param name="expression">The resulting expression.</param>
    public BoundBlockExpression(ImmutableArray<BoundStatement> statements, BoundExpression expression)
    {
        Statements = statements;
        Expression = expression;
    }

    /// <summary>Gets the synthetic prefix statements.</summary>
    public ImmutableArray<BoundStatement> Statements { get; }

    /// <summary>Gets the resulting expression.</summary>
    public BoundExpression Expression { get; }

    /// <inheritdoc/>
    public override TypeSymbol Type => Expression.Type;

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.BlockExpression;
}
