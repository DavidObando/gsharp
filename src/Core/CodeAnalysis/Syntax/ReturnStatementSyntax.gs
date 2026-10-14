// <copyright file="ReturnStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents the return statement syntax in the language.
class ReturnStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:ReturnStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param returnKeyword The return keyword.
    /// @param expression The expression.
    convenience init(syntaxTree SyntaxTree, returnKeyword SyntaxToken, expression ExpressionSyntax?) {
        init(syntaxTree, returnKeyword, nil, expression)
    }

    /// Initializes a new instance of the (cref:ReturnStatementSyntax) class with an optional
    /// `ref` contextual modifier (issue #490 — `return ref <lvalue>`).
    /// @param syntaxTree The parent syntax tree.
    /// @param returnKeyword The return keyword.
    /// @param refKeyword The optional `ref` contextual modifier; `null` when absent.
    /// @param expression The expression.
    init(
        syntaxTree SyntaxTree,
        returnKeyword SyntaxToken,
        refKeyword SyntaxToken?,
        expression ExpressionSyntax?
    ) : base(syntaxTree) {
        ReturnKeyword = returnKeyword
        RefKeyword = refKeyword
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ReturnStatement

    /// Gets the return keyword.
    prop ReturnKeyword SyntaxToken {
        get;
    }

    /// Gets the optional `ref` contextual modifier immediately following the
    /// `return` keyword (issue #490 / ADR-0060 follow-up). Non-null when the source
    /// is `return ref <lvalue>`.
    prop RefKeyword SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this is a `return ref` statement (issue #490).
    prop IsRefReturn bool -> RefKeyword != nil

    /// Gets the expression.
    prop Expression ExpressionSyntax? {
        get;
    }
}
