#nullable disable

// <copyright file="BoundThrowExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #1018: bound representation of a <c>throw expr</c> used in expression
/// position. The expression never produces a value — it always transfers
/// control by raising <see cref="System.Exception"/> — so its static
/// <see cref="Type"/> is the bottom (<see cref="TypeSymbol.Never"/>) type,
/// which the conversion / common-type machinery treats as implicitly
/// convertible to any target type.
/// </summary>
public sealed class BoundThrowExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundThrowExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The bound exception expression.</param>
    public BoundThrowExpression(SyntaxNode syntax, BoundExpression expression)
        : base(syntax)
    {
        Expression = expression;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ThrowExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => TypeSymbol.Never;

    /// <summary>Gets the bound exception expression.</summary>
    public BoundExpression Expression { get; }
}
