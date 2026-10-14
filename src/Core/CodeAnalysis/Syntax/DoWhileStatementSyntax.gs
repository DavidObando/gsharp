// <copyright file="DoWhileStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `do { body } while cond` statement (ADR-0070).
/// @remarks The body runs unconditionally once before the condition is consulted; the
/// binder lowers the form to a goto-based block (see
/// `BindDoWhileStatement`). No new (cref:Binding.BoundNodeKind) is
/// introduced — the lowering produces a (cref:BlockStatementSyntax)-
/// shaped bound block on the existing label/goto rails.
class DoWhileStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:DoWhileStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param doKeyword The `do` keyword.
    /// @param body The body statement.
    /// @param whileKeyword The trailing `while` keyword.
    /// @param condition The loop condition expression.
    init(
        syntaxTree SyntaxTree,
        doKeyword SyntaxToken,
        body StatementSyntax,
        whileKeyword SyntaxToken,
        condition ExpressionSyntax
    ) : base(syntaxTree) {
        DoKeyword = doKeyword
        Body = body
        WhileKeyword = whileKeyword
        Condition = condition
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.DoWhileStatement

    /// Gets the leading `do` keyword.
    prop DoKeyword SyntaxToken {
        get;
    }

    /// Gets the body statement.
    prop Body StatementSyntax {
        get;
    }

    /// Gets the trailing `while` keyword.
    prop WhileKeyword SyntaxToken {
        get;
    }

    /// Gets the loop condition expression.
    prop Condition ExpressionSyntax {
        get;
    }
}
