#nullable disable

// <copyright file="BoundIsExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound expression-level type-test: <c>expr is T</c> → <c>bool</c>.
/// Issue #575.
/// </summary>
public sealed class BoundIsExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundIsExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The expression whose runtime type is tested.</param>
    /// <param name="targetType">The type to test against.</param>
    public BoundIsExpression(SyntaxNode syntax, BoundExpression expression, TypeSymbol targetType)
        : base(syntax)
    {
        Expression = expression;
        TargetType = targetType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.IsExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => TypeSymbol.Bool;

    /// <summary>Gets the expression being type-tested.</summary>
    public BoundExpression Expression { get; }

    /// <summary>Gets the target type for the <c>isinst</c> check.</summary>
    public TypeSymbol TargetType { get; }
}
