// <copyright file="ForTupleRangeStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a deconstructing for-in loop, `for (a, b, ...) in coll { ... }`
/// (issue #1922). Each loop iteration binds one read-only local per
/// identifier to the corresponding element of the current tuple- or
/// data-struct-typed sequence value, instead of requiring a separate hidden
/// loop variable plus a `let (a, b) = tmp` deconstruction statement.
partial class ForTupleRangeStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:ForTupleRangeStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The `for` keyword.
    /// @param openParenToken The opening `(`.
    /// @param identifiers The comma-separated deconstruction target identifiers.
    /// @param closeParenToken The closing `)`.
    /// @param inToken The contextual `in` token.
    /// @param collection The collection expression.
    /// @param body The loop body.
    init(
        syntaxTree SyntaxTree,
        keyword SyntaxToken,
        openParenToken SyntaxToken,
        identifiers SeparatedSyntaxList[SyntaxToken],
        closeParenToken SyntaxToken,
        inToken SyntaxToken,
        collection ExpressionSyntax,
        body StatementSyntax
    ) : base(syntaxTree) {
        Keyword = keyword
        OpenParenToken = openParenToken
        Identifiers = identifiers
        CloseParenToken = closeParenToken
        InToken = inToken
        Collection = collection
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ForTupleRangeStatement

    /// Gets the `for` keyword.
    prop Keyword SyntaxToken {
        get;
    }

    /// Gets the opening parenthesis token.
    prop OpenParenToken SyntaxToken {
        get;
    }

    /// Gets the deconstruction target identifiers.
    prop Identifiers SeparatedSyntaxList[SyntaxToken] {
        get;
    }

    /// Gets the closing parenthesis token.
    prop CloseParenToken SyntaxToken {
        get;
    }

    /// Gets the contextual `in` token.
    prop InToken SyntaxToken {
        get;
    }

    /// Gets the collection expression.
    prop Collection ExpressionSyntax {
        get;
    }

    /// Gets the loop body.
    prop Body StatementSyntax {
        get;
    }
}
