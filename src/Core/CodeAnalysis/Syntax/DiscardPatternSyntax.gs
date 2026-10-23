// <copyright file="DiscardPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a discard pattern `_`.
partial class DiscardPatternSyntax : PatternSyntax {
    /// Initializes a new instance of the (cref:DiscardPatternSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param underscoreToken The underscore identifier token.
    init(syntaxTree SyntaxTree, underscoreToken SyntaxToken) : base(syntaxTree) {
        UnderscoreToken = underscoreToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.DiscardPattern

    /// Gets the underscore token.
    prop UnderscoreToken SyntaxToken {
        get;
    }
}
