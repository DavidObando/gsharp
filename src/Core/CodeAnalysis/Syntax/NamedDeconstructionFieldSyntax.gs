// <copyright file="NamedDeconstructionFieldSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents one `Field = local` binding inside named data-struct deconstruction.
class NamedDeconstructionFieldSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:NamedDeconstructionFieldSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param fieldIdentifier The field name.
    /// @param equalsToken The equals separator.
    /// @param localIdentifier The local identifier to declare.
    init(
        syntaxTree SyntaxTree,
        fieldIdentifier SyntaxToken,
        equalsToken SyntaxToken,
        localIdentifier SyntaxToken
    ) : base(syntaxTree) {
        FieldIdentifier = fieldIdentifier
        EqualsToken = equalsToken
        LocalIdentifier = localIdentifier
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.NamedDeconstructionField

    /// Gets the field name.
    prop FieldIdentifier SyntaxToken {
        get;
    }

    /// Gets the equals separator.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the local identifier to declare.
    prop LocalIdentifier SyntaxToken {
        get;
    }
}
