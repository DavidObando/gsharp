// <copyright file="ThrowExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Issue #1018: represents a `throw expr` used in expression position
/// (a throw-expression), e.g. as the right-hand side of `??`, a branch of
/// the conditional operator, an arrow body, a returned operand, or an
/// argument. Mirrors C# throw-expressions. The statement form
/// ((cref:ThrowStatementSyntax)) is unchanged.
class ThrowExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:ThrowExpressionSyntax) class.
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
    override prop Kind SyntaxKind -> SyntaxKind.ThrowExpression

    /// Gets the `throw` keyword.
    prop ThrowKeyword SyntaxToken {
        get;
    }

    /// Gets the exception expression.
    prop Expression ExpressionSyntax {
        get;
    }
}
