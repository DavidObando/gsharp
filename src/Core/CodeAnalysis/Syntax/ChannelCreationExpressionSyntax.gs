// <copyright file="ChannelCreationExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents channel construction (ADR-0174 D12): the channel type clause
/// applied to arguments — `chan[T]()` for a rendezvous channel and
/// `chan[T](n)` for a buffered one — the exact parallel of
/// `map[K,V]{…}` constructing a dictionary and of `List[int32]()`.
class ChannelCreationExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:ChannelCreationExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param typeClause The `chan[T]` type clause.
    /// @param openParenthesis The `(` token.
    /// @param arguments The capacity argument list (empty or one expression).
    /// @param closeParenthesis The `)` token.
    init(
        syntaxTree SyntaxTree,
        typeClause TypeClauseSyntax,
        openParenthesis SyntaxToken,
        arguments SeparatedSyntaxList[ExpressionSyntax],
        closeParenthesis SyntaxToken
    ) : base(syntaxTree) {
        TypeClause = typeClause
        OpenParenthesis = openParenthesis
        Arguments = arguments
        CloseParenthesis = closeParenthesis
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ChannelCreationExpression

    /// Gets the `chan[T]` type clause being constructed.
    prop TypeClause TypeClauseSyntax {
        get;
    }

    /// Gets the opening `(` token.
    prop OpenParenthesis SyntaxToken {
        get;
    }

    /// Gets the argument list: empty for a rendezvous channel, one capacity expression for a buffered one.
    prop Arguments SeparatedSyntaxList[ExpressionSyntax] {
        get;
    }

    /// Gets the closing `)` token.
    prop CloseParenthesis SyntaxToken {
        get;
    }
}
