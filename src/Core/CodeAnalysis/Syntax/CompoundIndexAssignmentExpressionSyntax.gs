// <copyright file="CompoundIndexAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a compound indexer assignment of the form
/// `target[index] op= value` (e.g. `d[k] += 1`, `obj.Map[k] -= 2`).
/// Issue #507 follow-up: this complements
/// (cref:IndexAssignmentExpressionSyntax) and
/// (cref:MemberIndexAssignmentExpressionSyntax), which only handle the
/// plain `=` case. The binder evaluates the indexed receiver exactly once
/// (via a synthesized temp local) and lowers the node to the equivalent
/// `target[index] = target[index] op value`.
@SyntaxChildSourceOrder
partial class CompoundIndexAssignmentExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the
    /// (cref:CompoundIndexAssignmentExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param target The parsed indexer access on the left of the operator.
    /// @param operatorToken The compound assignment token (e.g. `+=`).
    /// @param value The value expression on the right of the operator.
    /// @param returnsPreviousValue Whether the expression yields the value read before the write.
    /// @param isIncrementDecrement Whether this node originated from a `++` or `--` expression.
    init(
        syntaxTree SyntaxTree,
        target IndexExpressionSyntax,
        operatorToken SyntaxToken,
        value ExpressionSyntax,
        returnsPreviousValue bool = false,
        isIncrementDecrement bool = false
    ) : base(syntaxTree) {
        Target = target
        OperatorToken = operatorToken
        Value = value
        ReturnsPreviousValue = returnsPreviousValue
        IsIncrementDecrement = isIncrementDecrement
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.CompoundIndexAssignmentExpression

    /// Gets the indexer access expression on the left of the operator.
    prop Target IndexExpressionSyntax {
        get;
    }

    /// Gets the compound assignment operator token.
    prop OperatorToken SyntaxToken {
        get;
    }

    /// Gets the value expression on the right of the operator.
    prop Value ExpressionSyntax {
        get;
    }

    /// Gets a value indicating whether this expression yields the pre-write value.
    prop ReturnsPreviousValue bool {
        get;
    }

    /// Gets a value indicating whether this expression originated from increment/decrement syntax.
    prop IsIncrementDecrement bool {
        get;
    }
}
