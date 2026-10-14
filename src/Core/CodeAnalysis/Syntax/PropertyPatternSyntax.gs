// <copyright file="PropertyPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a property pattern `{ Name: pattern }`, optionally followed by a designation
/// `{ Name: pattern } name`.
class PropertyPatternSyntax : PatternSyntax {
    /// Initializes a new instance of the (cref:PropertyPatternSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param openBraceToken The opening brace token.
    /// @param fields The field patterns.
    /// @param closeBraceToken The closing brace token.
    /// @param designation The optional ADR-0166 designation that names the matched (non-nil) value.
    init(
        syntaxTree SyntaxTree,
        openBraceToken SyntaxToken,
        fields SeparatedSyntaxList[PropertyPatternFieldSyntax],
        closeBraceToken SyntaxToken,
        designation SyntaxToken? = nil
    ) : base(syntaxTree) {
        OpenBraceToken = openBraceToken
        Fields = fields
        CloseBraceToken = closeBraceToken
        Designation = designation
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.PropertyPattern

    /// Gets the opening brace token.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the field patterns.
    prop Fields SeparatedSyntaxList[PropertyPatternFieldSyntax] {
        get;
    }

    /// Gets the closing brace token.
    prop CloseBraceToken SyntaxToken {
        get;
    }

    /// Gets the optional designation identifier written after the closing brace
    /// (`{ Length: > 0 } text`). ADR-0166: the designation binds the
    /// matched, non-nil value at the pattern's input type.
    prop Designation SyntaxToken? {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    @SyntaxChildIgnore
    override prop BindingIdentifier SyntaxToken? -> Designation
}
