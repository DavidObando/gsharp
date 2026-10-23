// <copyright file="ListPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a fixed-length list pattern.
partial class ListPatternSyntax : PatternSyntax {
    /// Initializes a new instance of the (cref:ListPatternSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param openSquareBracketToken The opening bracket token.
    /// @param elements The element patterns.
    /// @param closeSquareBracketToken The closing bracket token.
    init(
        syntaxTree SyntaxTree,
        openSquareBracketToken SyntaxToken,
        elements SeparatedSyntaxList[PatternSyntax],
        closeSquareBracketToken SyntaxToken
    ) : base(syntaxTree) {
        OpenSquareBracketToken = openSquareBracketToken
        Elements = elements
        CloseSquareBracketToken = closeSquareBracketToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ListPattern

    /// Gets the opening bracket token.
    prop OpenSquareBracketToken SyntaxToken {
        get;
    }

    /// Gets the element patterns.
    prop Elements SeparatedSyntaxList[PatternSyntax] {
        get;
    }

    /// Gets the closing bracket token.
    prop CloseSquareBracketToken SyntaxToken {
        get;
    }
}
