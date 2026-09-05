// <copyright file="BoundBinaryOperationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// The shape shared by every bound node that applies a BINARY OPERATOR to two
/// operands (ADR-0169, issue #3920).
/// </summary>
/// <remarks>
/// <para>
/// G# binds <c>a == b</c> to two different nodes depending on where the
/// operator comes from: <see cref="BoundBinaryExpression"/> when it is one of
/// the language's built-in operators, and
/// <see cref="BoundClrBinaryOperatorExpression"/> when it resolves to an
/// <c>op_Equality</c>-style operator method on a CLR or same-compilation type.
/// Both are "a binary operation" to anything reasoning about the program
/// rather than about codegen — Roslyn models the pair as one
/// <c>IBinaryOperation</c>.
/// </para>
/// <para>
/// Without a shared shape an analyzer registered for binary operations has to
/// know the split and cast twice, and one that does not know it silently sees
/// half the program: GSA0002 police reflection <see cref="System.Type"/>
/// comparisons, whose operands are IMPORTED by construction, and so matched
/// exactly none of the code it exists for. This base is the analyzer-facing
/// answer; the concrete nodes and their <see cref="BoundNode.Kind"/> values are
/// unchanged, so nothing in lowering or emit is affected.
/// </para>
/// </remarks>
public abstract class BoundBinaryOperationExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundBinaryOperationExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    private protected BoundBinaryOperationExpression(SyntaxNode? syntax)
        : base(syntax)
    {
    }

    /// <summary>Gets the left operand.</summary>
    public abstract BoundExpression Left { get; }

    /// <summary>Gets the right operand.</summary>
    public abstract BoundExpression Right { get; }

    /// <summary>
    /// Gets the operator this node applies, in the language's operator
    /// vocabulary. <see cref="BoundBinaryOperatorKind.Undefined"/> when the
    /// operator token does not name a language-level binary operator.
    /// </summary>
    public abstract BoundBinaryOperatorKind BinaryOperatorKind { get; }

    /// <summary>
    /// Maps an operator TOKEN kind to the language-level operator it spells.
    /// Used by nodes that carry the token rather than a bound operator.
    /// </summary>
    /// <param name="syntaxKind">The operator token kind.</param>
    /// <returns>The operator kind, or <see cref="BoundBinaryOperatorKind.Undefined"/>.</returns>
    private protected static BoundBinaryOperatorKind FromSyntaxKind(SyntaxKind syntaxKind)
        => syntaxKind switch
        {
            SyntaxKind.PlusToken => BoundBinaryOperatorKind.Sum,
            SyntaxKind.MinusToken => BoundBinaryOperatorKind.Difference,
            SyntaxKind.StarToken => BoundBinaryOperatorKind.Product,
            SyntaxKind.SlashToken => BoundBinaryOperatorKind.Quotient,
            SyntaxKind.PercentToken => BoundBinaryOperatorKind.Remainder,
            SyntaxKind.AmpersandToken => BoundBinaryOperatorKind.BitwiseAnd,
            SyntaxKind.AmpersandHatToken => BoundBinaryOperatorKind.BitClear,
            SyntaxKind.PipeToken => BoundBinaryOperatorKind.BitwiseOr,
            SyntaxKind.HatToken => BoundBinaryOperatorKind.BitwiseXor,
            SyntaxKind.ShiftLeftToken => BoundBinaryOperatorKind.ShiftLeft,
            SyntaxKind.ShiftRightToken => BoundBinaryOperatorKind.ShiftRight,
            SyntaxKind.UnsignedShiftRightToken => BoundBinaryOperatorKind.UnsignedShiftRight,
            SyntaxKind.QuestionQuestionToken => BoundBinaryOperatorKind.NullCoalesce,
            SyntaxKind.AmpersandAmpersandToken => BoundBinaryOperatorKind.LogicalAnd,
            SyntaxKind.PipePipeToken => BoundBinaryOperatorKind.LogicalOr,
            SyntaxKind.EqualsEqualsToken => BoundBinaryOperatorKind.Equals,
            SyntaxKind.BangEqualsToken => BoundBinaryOperatorKind.NotEquals,
            SyntaxKind.LessToken => BoundBinaryOperatorKind.Less,
            SyntaxKind.LessOrEqualsToken => BoundBinaryOperatorKind.LessOrEquals,
            SyntaxKind.GreaterToken => BoundBinaryOperatorKind.Greater,
            SyntaxKind.GreaterOrEqualsToken => BoundBinaryOperatorKind.GreaterOrEquals,
            _ => BoundBinaryOperatorKind.Undefined,
        };
}
