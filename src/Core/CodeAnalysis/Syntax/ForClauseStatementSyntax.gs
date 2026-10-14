// <copyright file="ForClauseStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a C-style `for init; cond; post { body }` statement.
/// All three header parts are optional.
class ForClauseStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:ForClauseStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The `for` keyword.
    /// @param initializer The optional initializer statement.
    /// @param firstSemicolon The first semicolon separator.
    /// @param condition The optional loop condition.
    /// @param secondSemicolon The second semicolon separator.
    /// @param post The optional post statement.
    /// @param body The body statement.
    init(
        syntaxTree SyntaxTree,
        keyword SyntaxToken,
        initializer StatementSyntax?,
        firstSemicolon SyntaxToken,
        condition ExpressionSyntax?,
        secondSemicolon SyntaxToken,
        post StatementSyntax?,
        body StatementSyntax
    ) : base(syntaxTree) {
        Keyword = keyword
        Initializer = initializer
        FirstSemicolon = firstSemicolon
        Condition = condition
        SecondSemicolon = secondSemicolon
        Post = post
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ForClauseStatement

    /// Gets the `for` keyword.
    prop Keyword SyntaxToken {
        get;
    }

    /// Gets the optional initializer statement.
    prop Initializer StatementSyntax? {
        get;
    }

    /// Gets the first semicolon separator.
    prop FirstSemicolon SyntaxToken {
        get;
    }

    /// Gets the optional loop condition expression.
    prop Condition ExpressionSyntax? {
        get;
    }

    /// Gets the second semicolon separator.
    prop SecondSemicolon SyntaxToken {
        get;
    }

    /// Gets the optional post statement.
    prop Post StatementSyntax? {
        get;
    }

    /// Gets the body statement.
    prop Body StatementSyntax {
        get;
    }
}
