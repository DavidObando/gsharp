// <copyright file="BoundThrowStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound <c>throw expr</c> statement.
/// </summary>
public sealed class BoundThrowStatement : BoundStatement
{
    /// <summary>Initializes a new instance of the <see cref="BoundThrowStatement"/> class.</summary>
    /// <param name="expression">The bound exception expression.</param>
    public BoundThrowStatement(BoundExpression expression)
    {
        Expression = expression;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ThrowStatement;

    /// <summary>Gets the bound exception expression.</summary>
    public BoundExpression Expression { get; }
}
