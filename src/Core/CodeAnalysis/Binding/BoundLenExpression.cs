#nullable disable

// <copyright file="BoundLenExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound built-in <c>len(x)</c> expression. Returns the element count
/// of an array, slice, or string.
/// </summary>
public sealed class BoundLenExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundLenExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="operand">The operand expression.</param>
    public BoundLenExpression(SyntaxNode syntax, BoundExpression operand)
        : base(syntax)
    {
        Operand = operand;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.LenExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => TypeSymbol.Int32;

    /// <summary>Gets the operand expression.</summary>
    public BoundExpression Operand { get; }
}
