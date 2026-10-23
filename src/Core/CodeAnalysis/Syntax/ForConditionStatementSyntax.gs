// <copyright file="ForConditionStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `for cond { body }` ("for-as-while") statement.
partial class ForConditionStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:ForConditionStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The `for` keyword.
    /// @param condition The loop condition.
    /// @param body The body statement.
    init(syntaxTree SyntaxTree, keyword SyntaxToken, condition ExpressionSyntax, body StatementSyntax) : base(
        syntaxTree
    ) {
        Keyword = keyword
        Condition = condition
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ForConditionStatement

    /// Gets the `for` keyword.
    prop Keyword SyntaxToken {
        get;
    }

    /// Gets the loop condition expression.
    prop Condition ExpressionSyntax {
        get;
    }

    /// Gets the body statement.
    prop Body StatementSyntax {
        get;
    }
}
