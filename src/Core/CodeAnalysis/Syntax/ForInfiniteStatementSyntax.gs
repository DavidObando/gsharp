// <copyright file="ForInfiniteStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a for infinite statement syntax in the language.
class ForInfiniteStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:ForInfiniteStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The for keyword.
    /// @param body The body statement.
    init(syntaxTree SyntaxTree, keyword SyntaxToken, body StatementSyntax) : base(syntaxTree) {
        Keyword = keyword
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ForInfiniteStatement

    /// Gets the for keyword.
    prop Keyword SyntaxToken {
        get;
    }

    /// Gets the body statement.
    prop Body StatementSyntax {
        get;
    }
}
