// <copyright file="ImportSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable
import System.Linq

/// Represents an import declaration in the language.
partial class ImportSyntax : MemberSyntax {
    /// Initializes a new instance of the (cref:ImportSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param importKeyword The import keyword.
    /// @param aliasIdentifier Optional alias identifier (the LHS of an `import alias = path` form).
    /// @param equalsToken Optional equals token paired with [`aliasIdentifier`](paramref).
    /// @param identifiers The identifiers forming the imported path (dot-included tokens).
    init(
        syntaxTree SyntaxTree,
        importKeyword SyntaxToken,
        aliasIdentifier SyntaxToken?,
        equalsToken SyntaxToken?,
        identifiers ImmutableArray[SyntaxToken]
    ) : base(syntaxTree) {
        ImportKeyword = importKeyword
        AliasIdentifier = aliasIdentifier
        EqualsToken = equalsToken
        IdentifiersWithDots = identifiers
        Identifiers = identifiers.Where((t SyntaxToken) -> t.Kind == SyntaxKind.IdentifierToken).ToImmutableArray()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ImportDeclaration

    /// Gets the import keyword.
    prop ImportKeyword SyntaxToken {
        get;
    }

    /// Gets the alias identifier when the import uses the `import alias = path` form, or `null`.
    prop AliasIdentifier SyntaxToken? {
        get;
    }

    /// Gets the equals token paired with (cref:AliasIdentifier), or `null`.
    prop EqualsToken SyntaxToken? {
        get;
    }

    /// Gets the import statement identifiers, excluding dots.
    /// These are the tokens of (cref:IdentifiersWithDots) without the dots, so they are not a separate child.
    @SyntaxChildIgnore
    prop Identifiers ImmutableArray[SyntaxToken] {
        get;
    }

    /// Gets the import statement identifiers, including dots.
    prop IdentifiersWithDots ImmutableArray[SyntaxToken] {
        get;
    }
}
