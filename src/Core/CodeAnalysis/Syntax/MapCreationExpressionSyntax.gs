// <copyright file="MapCreationExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a map creation expression `map[K,V]{k1: v1, k2: v2, …}`
/// (ADR-0104).
class MapCreationExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:MapCreationExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param typeClause The leading `map[K,V]` type clause.
    /// @param openBraceToken The opening `{` token.
    /// @param entries The comma-separated key/value entries.
    /// @param closeBraceToken The closing `}` token.
    init(
        syntaxTree SyntaxTree,
        typeClause TypeClauseSyntax,
        openBraceToken SyntaxToken,
        entries SeparatedSyntaxList[MapEntrySyntax],
        closeBraceToken SyntaxToken
    ) : base(syntaxTree) {
        TypeClause = typeClause
        OpenBraceToken = openBraceToken
        Entries = entries
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.MapCreationExpression

    /// Gets the `map[K,V]` type clause.
    prop TypeClause TypeClauseSyntax {
        get;
    }

    /// Gets the opening `{` token.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the comma-separated key/value entries.
    prop Entries SeparatedSyntaxList[MapEntrySyntax] {
        get;
    }

    /// Gets the closing `}` token.
    prop CloseBraceToken SyntaxToken {
        get;
    }
}
