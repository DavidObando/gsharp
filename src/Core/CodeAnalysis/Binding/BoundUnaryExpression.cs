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
    /// <param name="platformCheckMessage">
    /// ADR-0186 §4: when non-<see langword="null"/>, this node is a
    /// <em>synthesized</em> platform coercion check rather than a user-written
    /// <c>!!</c>, and the string is the message its
    /// <see cref="System.NullReferenceException"/> carries — naming the
    /// expression and the boundary that failed. Only observed for
    /// <see cref="BoundUnaryOperatorKind.NullAssertion"/>; every other operator
    /// ignores it.
    /// </param>
    public BoundUnaryExpression(
        SyntaxNode? syntax,
        BoundUnaryOperator op,
        BoundExpression operand,
        bool isChecked = false,
        string? platformCheckMessage = null)
        : base(syntax)
    {
        Op = op;
        Operand = operand;
        IsChecked = isChecked;
        PlatformCheckMessage = platformCheckMessage;
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

    /// <summary>
    /// Gets ADR-0186 §4's runtime-check message, or <see langword="null"/> for
    /// a user-written <c>!!</c>.
    /// <para>
    /// A non-null value marks this node as the check the compiler inserted at
    /// a <c>T! -&gt; T</c> coercion. The distinction is observable in three
    /// places and nowhere else: the emitter selects the
    /// <c>NullReferenceException(string)</c> constructor instead of the
    /// parameterless one, the interpreter raises the same message, and
    /// <c>--platform-nil-checks=off</c> suppresses insertion of these nodes
    /// while leaving every user-written <c>!!</c> exactly as it is.
    /// </para>
    /// </summary>
    public string? PlatformCheckMessage { get; }
}
