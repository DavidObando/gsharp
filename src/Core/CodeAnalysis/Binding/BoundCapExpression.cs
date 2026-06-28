#nullable disable

// <copyright file="BoundCapExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound built-in <c>cap(x)</c> expression. Returns the capacity of
/// a slice or array. Phase 3.A.2 implementation aliases this to
/// length per ADR-0016 (no independent capacity tracking).
/// </summary>
public sealed class BoundCapExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundCapExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="operand">The operand expression.</param>
    public BoundCapExpression(SyntaxNode syntax, BoundExpression operand)
        : base(syntax)
    {
        Operand = operand;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.CapExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => TypeSymbol.Int32;

    /// <summary>Gets the operand expression.</summary>
    public BoundExpression Operand { get; }
}
