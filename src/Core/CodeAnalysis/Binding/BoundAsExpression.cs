#nullable disable

// <copyright file="BoundAsExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound expression-level safe cast: <c>expr as T</c> → <c>T</c> (reference) or <c>T?</c> (value).
/// Issue #575.
/// </summary>
public sealed class BoundAsExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundAsExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The expression being cast.</param>
    /// <param name="targetType">The target type (already includes nullable wrapping if needed).</param>
    public BoundAsExpression(SyntaxNode syntax, BoundExpression expression, TypeSymbol targetType)
        : base(syntax)
    {
        Expression = expression;
        TargetType = targetType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.AsExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => TargetType;

    /// <summary>Gets the expression being cast.</summary>
    public BoundExpression Expression { get; }

    /// <summary>Gets the result type of the safe cast.</summary>
    public TypeSymbol TargetType { get; }
}
