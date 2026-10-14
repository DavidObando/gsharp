// <copyright file="ThrowStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `throw expr` statement.
class ThrowStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:ThrowStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param throwKeyword The `throw` keyword.
    /// @param expression The exception expression.
    init(syntaxTree SyntaxTree, throwKeyword SyntaxToken, expression ExpressionSyntax) : base(syntaxTree) {
        ThrowKeyword = throwKeyword
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ThrowStatement

    /// Gets the `throw` keyword.
    prop ThrowKeyword SyntaxToken {
        get;
    }

    /// Gets the exception expression.
    prop Expression ExpressionSyntax {
        get;
    }
}
