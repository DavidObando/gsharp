// <copyright file="NullCoalescingAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// ADR-0072 / issue #709: a null-coalescing compound assignment
/// `target ??= value`. The right-hand side is evaluated only when the target
/// reads as nil, and the target's receiver and indices are evaluated once.
/// Issue #4967: this is an expression, like every other assignment
/// operator. Its value is the target's final value; at statement level it is
/// the expression of an (cref:ExpressionStatementSyntax). The target must be
/// a nullable lvalue (local, parameter, field, property, or indexer); the
/// binder reports `GS0298` when the target type is not nullable.
class NullCoalescingAssignmentExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the
    /// (cref:NullCoalescingAssignmentExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param target The target lvalue (left-hand side).
    /// @param operatorToken The `??=` operator token.
    /// @param value The right-hand-side value expression.
    init(syntaxTree SyntaxTree, target ExpressionSyntax, operatorToken SyntaxToken, value ExpressionSyntax) : base(
        syntaxTree
    ) {
        Target = target
        OperatorToken = operatorToken
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.NullCoalescingAssignmentExpression

    /// Gets the target lvalue expression.
    prop Target ExpressionSyntax {
        get;
    }

    /// Gets the `??=` operator token.
    prop OperatorToken SyntaxToken {
        get;
    }

    /// Gets the right-hand-side value expression.
    prop Value ExpressionSyntax {
        get;
    }
}
