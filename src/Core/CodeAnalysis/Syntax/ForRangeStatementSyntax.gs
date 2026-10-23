// <copyright file="ForRangeStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a for-range statement: legacy `for v := range coll { ... }`
/// or canonical `for v in coll { ... }`. For arrays and slices the first
/// identifier binds the int index; for maps / CLR dictionaries the first
/// identifier binds the key. The second identifier (when present) binds
/// the element / value.
partial class ForRangeStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:ForRangeStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The `for` keyword.
    /// @param firstIdentifier The first identifier (index/key, or value when alone).
    /// @param typeClause Optional declared type for the single iteration variable.
    /// @param commaToken Optional comma separating the two identifiers.
    /// @param secondIdentifier Optional second identifier (the value).
    /// @param colonEqualsToken The legacy `:=` token, or null for canonical `in`.
    /// @param rangeKeyword The legacy `range` keyword, or null for canonical `in`.
    /// @param inToken The contextual `in` token, or null for legacy `:= range`.
    /// @param collection The collection expression.
    /// @param body The loop body.
    init(
        syntaxTree SyntaxTree,
        keyword SyntaxToken,
        firstIdentifier SyntaxToken,
        typeClause TypeClauseSyntax?,
        commaToken SyntaxToken?,
        secondIdentifier SyntaxToken?,
        colonEqualsToken SyntaxToken?,
        rangeKeyword SyntaxToken?,
        inToken SyntaxToken,
        collection ExpressionSyntax,
        body StatementSyntax
    ) : base(syntaxTree) {
        Keyword = keyword
        FirstIdentifier = firstIdentifier
        TypeClause = typeClause
        CommaToken = commaToken
        SecondIdentifier = secondIdentifier
        ColonEqualsToken = colonEqualsToken
        RangeKeyword = rangeKeyword
        InToken = inToken
        Collection = collection
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ForRangeStatement

    /// Gets the `for` keyword.
    prop Keyword SyntaxToken {
        get;
    }

    /// Gets the first identifier (index/key, or value when no second identifier is present).
    prop FirstIdentifier SyntaxToken {
        get;
    }

    /// Gets the optional declared type for the single iteration variable.
    prop TypeClause TypeClauseSyntax? {
        get;
    }

    /// Gets the optional comma separating the two identifiers.
    prop CommaToken SyntaxToken? {
        get;
    }

    /// Gets the optional second identifier (the value).
    prop SecondIdentifier SyntaxToken? {
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

    /// Gets the collection expression.
    prop Collection ExpressionSyntax {
        get;
    }

    /// Gets the loop body.
    prop Body StatementSyntax {
        get;
    }
}
