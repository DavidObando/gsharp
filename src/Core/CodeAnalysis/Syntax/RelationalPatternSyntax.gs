// <copyright file="RelationalPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a relational pattern such as `> 0`.
class RelationalPatternSyntax : PatternSyntax {
    /// Initializes a new instance of the (cref:RelationalPatternSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param operatorToken The operator token.
    /// @param expression The right-hand expression.
    init(syntaxTree SyntaxTree, operatorToken SyntaxToken, expression ExpressionSyntax) : base(syntaxTree) {
        OperatorToken = operatorToken
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.RelationalPattern

    /// Gets the operator token.
    prop OperatorToken SyntaxToken {
        get;
    }

    /// Gets the right-hand expression.
    prop Expression ExpressionSyntax {
        get;
    }
}
