// <copyright file="PackageSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable
import System.Linq

/// Represents a package declaration in the language.
partial class PackageSyntax : MemberSyntax {
    /// Initializes a new instance of the (cref:PackageSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param identifier The package identifier.
    convenience init(syntaxTree SyntaxTree, identifier string) {
        init(
            syntaxTree,
            SyntaxToken(syntaxTree, SyntaxKind.PackageKeyword, -1, string.Empty, nil),
            ImmutableArray.Create[SyntaxToken](
                SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, -1, identifier, identifier)
            )
        )
    }

    /// Initializes a new instance of the (cref:PackageSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param packageKeyword The package keyword.
    /// @param identifiers The package identifiers.
    init(syntaxTree SyntaxTree, packageKeyword SyntaxToken, identifiers ImmutableArray[SyntaxToken]) : base(
        syntaxTree
    ) {
        PackageKeyword = packageKeyword
        IdentifiersWithDots = identifiers
        Identifiers = identifiers.Where((t SyntaxToken) -> t.Kind == SyntaxKind.IdentifierToken).ToImmutableArray()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.PackageDeclaration

    /// Gets the package keyword.
    prop PackageKeyword SyntaxToken {
        get;
    }

    /// Gets the package identifiers, excluding dots.
    /// These are the tokens of (cref:IdentifiersWithDots) without the dots, so they are not a separate child.
    @SyntaxChildIgnore
    prop Identifiers ImmutableArray[SyntaxToken] {
        get;
    }

    /// Gets the package identifiers, including dots.
    prop IdentifiersWithDots ImmutableArray[SyntaxToken] {
        get;
    }
}
