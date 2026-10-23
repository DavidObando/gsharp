// <copyright file="DeferStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `defer f(args)` statement (Phase 7.1 / ADR-0030).
/// The expression must be a call.
partial class DeferStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:DeferStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param deferKeyword The `defer` keyword token.
    /// @param expression The call expression to run when the enclosing block exits.
    init(syntaxTree SyntaxTree, deferKeyword SyntaxToken, expression ExpressionSyntax) : base(syntaxTree) {
        DeferKeyword = deferKeyword
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.DeferStatement

    /// Gets the `defer` keyword token.
    prop DeferKeyword SyntaxToken {
        get;
    }

    /// Gets the call expression to run when the enclosing block exits.
    prop Expression ExpressionSyntax {
        get;
    }
}
