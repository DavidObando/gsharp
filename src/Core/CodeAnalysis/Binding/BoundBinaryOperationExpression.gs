// <copyright file="BoundBinaryOperationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// The shape shared by every bound node that applies a BINARY OPERATOR to two
/// operands (ADR-0169, issue #3920).
/// @remarks G# binds `a == b` to two different nodes depending on where the
/// operator comes from: (cref:BoundBinaryExpression) when it is one of
/// the language's built-in operators, and
/// (cref:BoundClrBinaryOperatorExpression) when it resolves to an
/// `op_Equality`-style operator method on a CLR or same-compilation type.
/// Both are "a binary operation" to anything reasoning about the program
/// rather than about codegen — Roslyn models the pair as one
/// `IBinaryOperation`.
///
/// Without a shared shape an analyzer registered for binary operations has to
/// know the split and cast twice, and one that does not know it silently sees
/// half the program: GSA0002 police reflection (cref:System.Type)
/// comparisons, whose operands are IMPORTED by construction, and so matched
/// exactly none of the code it exists for. This base is the analyzer-facing
/// answer; the concrete nodes and their (cref:BoundNode.Kind) values are
/// unchanged, so nothing in lowering or emit is affected.
abstract class BoundBinaryOperationExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundBinaryOperationExpression) class.
    /// @param syntax The originating syntax.
    internal init(syntax SyntaxNode?) : base(syntax) { }

    /// Gets the left operand.
    abstract prop Left BoundExpression {
        get;
    }

    /// Gets the right operand.
    abstract prop Right BoundExpression {
        get;
    }

    /// Gets the operator this node applies, in the language's operator
    /// vocabulary. (cref:BoundBinaryOperatorKind.Undefined) when the
    /// operator token does not name a language-level binary operator.
    abstract prop BinaryOperatorKind BoundBinaryOperatorKind {
        get;
    }

    shared {
        /// Maps an operator TOKEN kind to the language-level operator it spells.
        /// Used by nodes that carry the token rather than a bound operator.
        /// @param syntaxKind The operator token kind.
        /// @returns The operator kind, or (cref:BoundBinaryOperatorKind.Undefined).
        internal func FromSyntaxKind(syntaxKind SyntaxKind) BoundBinaryOperatorKind -> switch syntaxKind {
            case SyntaxKind.PlusToken: BoundBinaryOperatorKind.Sum
            case SyntaxKind.MinusToken: BoundBinaryOperatorKind.Difference
            case SyntaxKind.StarToken: BoundBinaryOperatorKind.Product
            case SyntaxKind.SlashToken: BoundBinaryOperatorKind.Quotient
            case SyntaxKind.PercentToken: BoundBinaryOperatorKind.Remainder
            case SyntaxKind.AmpersandToken: BoundBinaryOperatorKind.BitwiseAnd
            case SyntaxKind.AmpersandHatToken: BoundBinaryOperatorKind.BitClear
            case SyntaxKind.PipeToken: BoundBinaryOperatorKind.BitwiseOr
            case SyntaxKind.HatToken: BoundBinaryOperatorKind.BitwiseXor
            case SyntaxKind.ShiftLeftToken: BoundBinaryOperatorKind.ShiftLeft
            case SyntaxKind.ShiftRightToken: BoundBinaryOperatorKind.ShiftRight
            case SyntaxKind.UnsignedShiftRightToken: BoundBinaryOperatorKind.UnsignedShiftRight
            case SyntaxKind.QuestionQuestionToken: BoundBinaryOperatorKind.NullCoalesce
            case SyntaxKind.AmpersandAmpersandToken: BoundBinaryOperatorKind.LogicalAnd
            case SyntaxKind.PipePipeToken: BoundBinaryOperatorKind.LogicalOr
            case SyntaxKind.EqualsEqualsToken: BoundBinaryOperatorKind.Equals
            case SyntaxKind.BangEqualsToken: BoundBinaryOperatorKind.NotEquals
            case SyntaxKind.LessToken: BoundBinaryOperatorKind.Less
            case SyntaxKind.LessOrEqualsToken: BoundBinaryOperatorKind.LessOrEquals
            case SyntaxKind.GreaterToken: BoundBinaryOperatorKind.Greater
            case SyntaxKind.GreaterOrEqualsToken: BoundBinaryOperatorKind.GreaterOrEquals
            default: BoundBinaryOperatorKind.Undefined
        }
    }
}
