#nullable disable

// <copyright file="BoundDefaultExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound expression representing <c>default(T)</c> — the zero/null value of a type.
/// For reference types this is <c>null</c>; for value types it is the all-zeros bit pattern.
/// </summary>
public sealed class BoundDefaultExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundDefaultExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="type">The type whose default value this expression produces.</param>
    public BoundDefaultExpression(SyntaxNode syntax, TypeSymbol type)
        : base(syntax)
    {
        Type = type;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.DefaultExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }
}
