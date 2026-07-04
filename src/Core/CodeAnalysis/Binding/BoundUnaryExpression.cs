// <copyright file="BoundUnaryExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound unary expression.
/// </summary>
public sealed class BoundUnaryExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundUnaryExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="op">The bound unary operator.</param>
    /// <param name="operand">The bound expression.</param>
    /// <param name="isChecked">
    /// When true and <paramref name="op"/> is a <see cref="BoundUnaryOperatorKind.Negation"/>
    /// over an integral operand, the emitter and interpreter use overflow-trapping
    /// arithmetic (issue #2023, follow-up to #1881): a `checked(...)` expression or
    /// `checked { }` statement puts its arithmetic in this context; the default (no
    /// `checked` context) is unchecked, matching the C# project default.
    /// </param>
    public BoundUnaryExpression(SyntaxNode syntax, BoundUnaryOperator op, BoundExpression operand, bool isChecked = false)
        : base(syntax)
    {
        Op = op;
        Operand = operand;
        IsChecked = isChecked;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.UnaryExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => Op.Type;

    /// <summary>
    /// Gets the bound unary operator.
    /// </summary>
    public BoundUnaryOperator Op { get; }

    /// <summary>
    /// Gets the bound expression.
    /// </summary>
    public BoundExpression Operand { get; }

    /// <summary>
    /// Gets a value indicating whether this operator runs in a checked /
    /// overflow-trapping context (issue #2023). Only observed for
    /// <see cref="BoundUnaryOperatorKind.Negation"/> on integral operands.
    /// </summary>
    public bool IsChecked { get; }
}
