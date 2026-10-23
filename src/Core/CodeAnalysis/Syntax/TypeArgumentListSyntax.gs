// <copyright file="TypeArgumentListSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// A `[T1, T2]`-style bracketed list of type arguments attached to a generic
/// reference or call site (Phase 4.1 / ADR-0020), e.g. `Map[int, string](xs, f)`.
partial class TypeArgumentListSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:TypeArgumentListSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param openBracketToken The opening `[` token.
    /// @param arguments The (comma-separated) list of type-clause arguments.
    /// @param closeBracketToken The closing `]` token.
    init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken,
        arguments SeparatedSyntaxList[TypeClauseSyntax],
        closeBracketToken SyntaxToken
    ) : base(syntaxTree) {
        OpenBracketToken = openBracketToken
        Arguments = arguments
        CloseBracketToken = closeBracketToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.TypeArgumentList

    /// Gets the opening `[` token.
    prop OpenBracketToken SyntaxToken {
        get;
    }

    /// Gets the (comma-separated) list of type-clause arguments.
    prop Arguments SeparatedSyntaxList[TypeClauseSyntax] {
        get;
    }

    /// Gets the closing `]` token.
    prop CloseBracketToken SyntaxToken {
        get;
    }
}
