// <copyright file="AwaitExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents an `await` expression (Phase 5.1 / ADR-0023).
partial class AwaitExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:AwaitExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param awaitKeyword The `await` keyword token.
    /// @param expression The expression being awaited (must evaluate to a `Task` / `Task[T]`).
    init(syntaxTree SyntaxTree, awaitKeyword SyntaxToken, expression ExpressionSyntax) : base(syntaxTree) {
        AwaitKeyword = awaitKeyword
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.AwaitExpression

    /// Gets the `await` keyword token.
    prop AwaitKeyword SyntaxToken {
        get;
    }

    /// Gets the awaited expression.
    prop Expression ExpressionSyntax {
        get;
    }
}
