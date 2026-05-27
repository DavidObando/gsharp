// <copyright file="BoundYieldStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound yield statement — produces the next value in an iterator function (ADR-0040).
/// </summary>
public sealed class BoundYieldStatement : BoundStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundYieldStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The expression whose value is yielded.</param>
    public BoundYieldStatement(SyntaxNode syntax, BoundExpression expression)
        : base(syntax)
    {
        Expression = expression;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.YieldStatement;

    /// <summary>Gets the expression whose value is yielded to the caller.</summary>
    public BoundExpression Expression { get; }
}
