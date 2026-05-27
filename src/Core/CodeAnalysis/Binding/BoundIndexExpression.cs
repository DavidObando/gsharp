// <copyright file="BoundIndexExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound index expression <c>target[index]</c>.
/// </summary>
public sealed class BoundIndexExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundIndexExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="target">The target expression (must have an array type).</param>
    /// <param name="index">The index expression (must be int).</param>
    /// <param name="resultType">The element type.</param>
    public BoundIndexExpression(SyntaxNode syntax, BoundExpression target, BoundExpression index, TypeSymbol resultType)
        : base(syntax)
    {
        Target = target;
        Index = index;
        Type = resultType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.IndexExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>Gets the target expression.</summary>
    public BoundExpression Target { get; }

    /// <summary>Gets the index expression.</summary>
    public BoundExpression Index { get; }
}
