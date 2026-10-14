// <copyright file="MakeChannelExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents the built-in `make(chan T)` or
/// `make(chan T, capacity)` expression (Phase 5.4 / ADR-0022).
/// `make` is recognized as a contextual identifier when followed by
/// `(` and a type-clause starter such as `chan`.
class MakeChannelExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:MakeChannelExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param makeIdentifier The `make` identifier token.
    /// @param openParenthesis The `(` token.
    /// @param channelTypeClause The `chan T` type clause argument.
    /// @param commaToken The optional `,` token before the? capacity, or `null`.
    /// @param capacity The optional capacity expression, or `null`.
    /// @param closeParenthesis The `)` token.
    init(
        syntaxTree SyntaxTree,
        makeIdentifier SyntaxToken,
        openParenthesis SyntaxToken,
        channelTypeClause TypeClauseSyntax,
        commaToken SyntaxToken?,
        capacity ExpressionSyntax?,
        closeParenthesis SyntaxToken
    ) : base(syntaxTree) {
        MakeIdentifier = makeIdentifier
        OpenParenthesis = openParenthesis
        ChannelTypeClause = channelTypeClause
        CommaToken = commaToken
        Capacity = capacity
        CloseParenthesis = closeParenthesis
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.MakeChannelExpression

    /// Gets the `make` identifier token.
    prop MakeIdentifier SyntaxToken {
        get;
    }

    /// Gets the opening `(` token.
    prop OpenParenthesis SyntaxToken {
        get;
    }

    /// Gets the `chan T` type-clause argument.
    prop ChannelTypeClause TypeClauseSyntax {
        get;
    }

    /// Gets the optional `,` separator before the? capacity, or `null`.
    prop CommaToken SyntaxToken? {
        get;
    }

    /// Gets the optional capacity expression, or `null` for an unbounded channel.
    prop Capacity ExpressionSyntax? {
        get;
    }

    /// Gets the closing `)` token.
    prop CloseParenthesis SyntaxToken {
        get;
    }
}
