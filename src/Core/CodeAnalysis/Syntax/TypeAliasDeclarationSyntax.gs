// <copyright file="TypeAliasDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `type Name = Other` alias declaration (Phase 2.7).
/// Aliases are erased at bind time — they are not emitted into CIL.
partial class TypeAliasDeclarationSyntax : MemberSyntax {
    /// Initializes a new instance of the (cref:TypeAliasDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The alias identifier.
    /// @param equalsToken The `=` token.
    /// @param aliasedType The aliased type clause.
    convenience init(
        syntaxTree SyntaxTree,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        equalsToken SyntaxToken,
        aliasedType TypeClauseSyntax
    ) {
        init(syntaxTree, nil, typeKeyword, identifier, equalsToken, aliasedType)
    }

    /// Initializes a new instance of the (cref:TypeAliasDeclarationSyntax) class with an explicit
    /// accessibility modifier.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The alias identifier.
    /// @param equalsToken The `=` token.
    /// @param aliasedType The aliased type clause.
    init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        equalsToken SyntaxToken,
        aliasedType TypeClauseSyntax
    ) : base(syntaxTree) {
        AccessibilityModifier = accessibilityModifier
        TypeKeyword = typeKeyword
        Identifier = identifier
        EqualsToken = equalsToken
        AliasedType = aliasedType
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.TypeAliasDeclaration

    /// Gets the optional accessibility modifier token.
    prop AccessibilityModifier SyntaxToken? {
        get;
    }

    /// Gets the `type` keyword.
    prop TypeKeyword SyntaxToken? {
        get;
    }

    /// Gets the alias identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the `=` token.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the aliased type clause.
    prop AliasedType TypeClauseSyntax {
        get;
    }
}
