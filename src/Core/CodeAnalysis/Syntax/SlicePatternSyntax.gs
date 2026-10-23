// <copyright file="SlicePatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a slice ("rest") subpattern inside a list? pattern, e.g. the
/// `..` in `[1, .., 3]`, an optional named capture `..rest`
/// binding the middle slice, or an optional sub-pattern `..[> 0]`
/// matched against the middle slice.
partial class SlicePatternSyntax : PatternSyntax {
    /// Initializes a new instance of the (cref:SlicePatternSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param dotDotToken The `..` token.
    /// @param captureIdentifier The optional capture identifier (e.g. `rest` in `..rest`), or `null`.
    /// @param pattern The optional sub-pattern matched against the middle slice, or `null`.
    init(syntaxTree SyntaxTree, dotDotToken SyntaxToken, captureIdentifier SyntaxToken?, pattern PatternSyntax?) : base(
        syntaxTree
    ) {
        DotDotToken = dotDotToken
        CaptureIdentifier = captureIdentifier
        Pattern = pattern
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.SlicePattern

    /// Gets the `..` token.
    prop DotDotToken SyntaxToken {
        get;
    }

    /// Gets the optional capture identifier, or `null` for a discard slice.
    prop CaptureIdentifier SyntaxToken? {
        get;
    }

    /// Gets the optional sub-pattern matched against the middle slice, or `null`.
    prop Pattern PatternSyntax? {
        get;
    }
}
