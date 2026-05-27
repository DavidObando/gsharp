// <copyright file="BoundErrorExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound error expression.
/// </summary>
public sealed class BoundErrorExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundErrorExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax (may be <see langword="null"/> for synthesised nodes).</param>
    public BoundErrorExpression(SyntaxNode syntax)
        : base(syntax)
    {
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ErrorExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => TypeSymbol.Error;
}
