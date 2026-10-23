// <copyright file="EventAccessorSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a single `add` or `remove` accessor inside an event body (ADR-0052).
partial class EventAccessorSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:EventAccessorSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessorKeyword The `add` or `remove` identifier token.
    /// @param body The optional block body.
    /// @param semicolonToken The optional semicolon (for shorthand `add;` / `remove;`).
    init(
        syntaxTree SyntaxTree,
        accessorKeyword SyntaxToken,
        body BlockStatementSyntax?,
        semicolonToken SyntaxToken?
    ) : base(syntaxTree) {
        AccessorKeyword = accessorKeyword
        Body = body
        SemicolonToken = semicolonToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.EventAccessor

    /// Gets the `add` or `remove` identifier token.
    prop AccessorKeyword SyntaxToken {
        get;
    }

    /// Gets the optional block body. Null for bare `add;` / `remove;` accessors.
    prop Body BlockStatementSyntax? {
        get;
    }

    /// Gets the optional semicolon token (present for `add;` / `remove;` shorthand).
    prop SemicolonToken SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this accessor is an `add` accessor.
    prop IsAdd bool -> AccessorKeyword?.Text == "add"

    /// Gets a value indicating whether this accessor is a `remove` accessor.
    prop IsRemove bool -> AccessorKeyword?.Text == "remove"

    /// Gets a value indicating whether this accessor is a `raise` accessor (issue #257).
    prop IsRaise bool -> AccessorKeyword?.Text == "raise"
}
