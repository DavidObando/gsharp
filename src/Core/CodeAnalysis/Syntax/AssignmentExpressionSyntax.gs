// <copyright file="AssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents an assignment expression in the language.
partial class AssignmentExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:AssignmentExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param identifierToken The identifier of the assignment (left side).
    /// @param equalsToken The equals token.
    /// @param expression The expression of the assignment (right side).
    init(
        syntaxTree SyntaxTree,
        identifierToken SyntaxToken,
        equalsToken SyntaxToken,
        expression ExpressionSyntax
    ) : base(syntaxTree) {
        IdentifierToken = identifierToken
        EqualsToken = equalsToken
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.AssignmentExpression

    /// Gets the identifier of the assignment.
    prop IdentifierToken SyntaxToken {
        get;
    }

    /// Gets the equals token.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the expression of the assignment.
    prop Expression ExpressionSyntax {
        get;
    }
}
