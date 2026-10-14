// <copyright file="AwaitForRangeStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Phase 5.8 / ADR-0023 legacy `await for v := range stream { ... }`
/// and Phase 7.2 canonical `await for v in stream { ... }`. Iterates an
/// `IAsyncEnumerable[T]`; each iteration awaits the underlying
/// `MoveNextAsync()`.
class AwaitForRangeStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:AwaitForRangeStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param awaitKeyword The `await` keyword.
    /// @param forKeyword The `for` keyword.
    /// @param identifier The element identifier.
    /// @param typeClause Optional declared type for the iteration variable.
    /// @param colonEqualsToken The legacy `:=` token, or null for canonical `in`.
    /// @param rangeKeyword The legacy `range` keyword, or null for canonical `in`.
    /// @param inToken The contextual `in` token, or null for legacy `:= range`.
    /// @param stream The stream expression.
    /// @param body The loop body.
    init(
        syntaxTree SyntaxTree,
        awaitKeyword SyntaxToken,
        forKeyword SyntaxToken,
        identifier SyntaxToken,
        typeClause TypeClauseSyntax?,
        colonEqualsToken SyntaxToken?,
        rangeKeyword SyntaxToken?,
        inToken SyntaxToken,
        stream ExpressionSyntax,
        body StatementSyntax
    ) : base(syntaxTree) {
        AwaitKeyword = awaitKeyword
        ForKeyword = forKeyword
        Identifier = identifier
        TypeClause = typeClause
        ColonEqualsToken = colonEqualsToken
        RangeKeyword = rangeKeyword
        InToken = inToken
        Stream = stream
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.AwaitForRangeStatement

    /// Gets the `await` keyword.
    prop AwaitKeyword SyntaxToken {
        get;
    }

    /// Gets the `for` keyword.
    prop ForKeyword SyntaxToken {
        get;
    }

    /// Gets the element identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the optional declared type for the iteration variable.
    prop TypeClause TypeClauseSyntax? {
        get;
    }

    /// Gets the `:=` token.
    prop ColonEqualsToken SyntaxToken? {
        get;
    }

    /// Gets the `range` keyword.
    prop RangeKeyword SyntaxToken? {
        get;
    }

    /// Gets the contextual `in` token.
    prop InToken SyntaxToken {
        get;
    }

    /// Gets the stream expression (must be an `IAsyncEnumerable[T]`).
    prop Stream ExpressionSyntax {
        get;
    }

    /// Gets the loop body.
    prop Body StatementSyntax {
        get;
    }
}
