// <copyright file="EnumDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `enum Name { ... }` declaration.
class EnumDeclarationSyntax : MemberSyntax {
    // Backing field for the property the parser assigns after construction. Its setter
    // invalidates the node's cached span (issue #1675).
    private var sealedKeyword SyntaxToken?

    /// Initializes a new instance of the (cref:EnumDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The enum type identifier.
    /// @param enumKeyword The `enum` keyword.
    /// @param openBraceToken The opening brace.
    /// @param members The comma-separated enum members.
    /// @param closeBraceToken The closing brace.
    init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        enumKeyword SyntaxToken,
        openBraceToken SyntaxToken,
        members SeparatedSyntaxList[EnumMemberSyntax],
        closeBraceToken SyntaxToken
    ) : base(syntaxTree) {
        AccessibilityModifier = accessibilityModifier
        TypeKeyword = typeKeyword
        Identifier = identifier
        EnumKeyword = enumKeyword
        OpenBraceToken = openBraceToken
        Members = members
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.EnumDeclaration

    /// Gets the optional accessibility modifier token.
    prop AccessibilityModifier SyntaxToken? {
        get;
    }

    /// Gets the `type` keyword.
    prop TypeKeyword SyntaxToken? {
        get;
    }

    /// Gets the enum type identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the `enum` keyword.
    prop EnumKeyword SyntaxToken {
        get;
    }

    /// Gets the opening brace.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the comma-separated enum members.
    prop Members SeparatedSyntaxList[EnumMemberSyntax] {
        get;
    }

    /// Gets the closing brace.
    prop CloseBraceToken SyntaxToken {
        get;
    }

    /// Gets or sets the optional `sealed` contextual keyword (ADR-0078). The parser sets this to non-null
    /// for an enum declared `sealed enum Foo { ... }`, but the new grammar rejects that combination — kept
    /// as a field only for diagnostic recovery. Discriminated-union enums are already closed-hierarchy by
    /// construction.
    prop SealedKeyword SyntaxToken? {
        get -> sealedKeyword
        set {
            sealedKeyword = value
            InvalidateCachedSpan()
        }
    }
}
