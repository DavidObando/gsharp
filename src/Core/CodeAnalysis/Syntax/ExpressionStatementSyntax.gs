// <copyright file="ExpressionStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents an expression statement in the language.
open class ExpressionStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:ExpressionStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param expression The expression.
    init(syntaxTree SyntaxTree, expression ExpressionSyntax) : base(syntaxTree) {
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override prop Kind SyntaxKind -> SyntaxKind.ExpressionStatement

    /// Gets the expression.
    prop Expression ExpressionSyntax {
        get;
    }
}
