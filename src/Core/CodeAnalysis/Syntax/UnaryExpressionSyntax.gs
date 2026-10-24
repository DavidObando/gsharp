// <copyright file="UnaryExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a unary expression in the language.
@SyntaxChildSourceOrder
open partial class UnaryExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:UnaryExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param operatorToken The operator.
    /// @param operand The operand.
    init(syntaxTree SyntaxTree, operatorToken SyntaxToken, operand ExpressionSyntax) : base(syntaxTree) {
        OperatorToken = operatorToken
        Operand = operand
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override prop Kind SyntaxKind -> SyntaxKind.UnaryExpression

    /// Gets the operator.
    prop OperatorToken SyntaxToken {
        get;
    }

    /// Gets the operand.
    prop Operand ExpressionSyntax {
        get;
    }
}
