// <copyright file="GoStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `go f(args)` statement (Phase 5.3 / ADR-0022).
/// The expression must be a call.
partial class GoStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:GoStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param goKeyword The `go` keyword token.
    /// @param expression The call expression to start.
    init(syntaxTree SyntaxTree, goKeyword SyntaxToken, expression ExpressionSyntax) : base(syntaxTree) {
        GoKeyword = goKeyword
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.GoStatement

    /// Gets the `go` keyword token.
    prop GoKeyword SyntaxToken {
        get;
    }

    /// Gets the call expression to launch on a Task.
    prop Expression ExpressionSyntax {
        get;
    }
}
