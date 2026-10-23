// <copyright file="WhileStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `while cond { body }` statement (ADR-0070).
/// @remarks Binds identically to (cref:ForConditionStatementSyntax) — the binder
/// lowers both shapes to the same goto/label sequence. Introducing a dedicated
/// syntax node (rather than rewriting at parse time) keeps the syntax-tree
/// pretty-printer faithful to the surface form authors wrote.
partial class WhileStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:WhileStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param whileKeyword The `while` keyword.
    /// @param condition The loop condition expression.
    /// @param body The body statement.
    init(syntaxTree SyntaxTree, whileKeyword SyntaxToken, condition ExpressionSyntax, body StatementSyntax) : base(
        syntaxTree
    ) {
        WhileKeyword = whileKeyword
        Condition = condition
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.WhileStatement

    /// Gets the `while` keyword.
    prop WhileKeyword SyntaxToken {
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
