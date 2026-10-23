// <copyright file="TypeParameterListSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// A `[T any, U any]`-style bracketed list of type parameters attached to a generic
/// declaration (Phase 4.1 / ADR-0020).
partial class TypeParameterListSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:TypeParameterListSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param openBracketToken The opening `[` token.
    /// @param parameters The (comma-separated) list of type parameters.
    /// @param closeBracketToken The closing `]` token.
    init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken,
        parameters SeparatedSyntaxList[TypeParameterSyntax],
        closeBracketToken SyntaxToken
    ) : base(syntaxTree) {
        OpenBracketToken = openBracketToken
        Parameters = parameters
        CloseBracketToken = closeBracketToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.TypeParameterList

    /// Gets the opening `[` token.
    prop OpenBracketToken SyntaxToken {
        get;
    }

    /// Gets the (comma-separated) list of type parameters.
    prop Parameters SeparatedSyntaxList[TypeParameterSyntax] {
        get;
    }

    /// Gets the closing `]` token.
    prop CloseBracketToken SyntaxToken {
        get;
    }
}
