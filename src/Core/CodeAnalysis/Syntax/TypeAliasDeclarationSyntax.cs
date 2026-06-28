#nullable disable

// <copyright file="TypeAliasDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>type Name = Other</c> alias declaration (Phase 2.7).
/// Aliases are erased at bind time — they are not emitted into CIL.
/// </summary>
public sealed class TypeAliasDeclarationSyntax : MemberSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TypeAliasDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The alias identifier.</param>
    /// <param name="equalsToken">The <c>=</c> token.</param>
    /// <param name="aliasedType">The aliased type clause.</param>
    public TypeAliasDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken equalsToken,
        TypeClauseSyntax aliasedType)
        : this(syntaxTree, accessibilityModifier: null, typeKeyword, identifier, equalsToken, aliasedType)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="TypeAliasDeclarationSyntax"/> class with an explicit accessibility modifier.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The alias identifier.</param>
    /// <param name="equalsToken">The <c>=</c> token.</param>
    /// <param name="aliasedType">The aliased type clause.</param>
    public TypeAliasDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken equalsToken,
        TypeClauseSyntax aliasedType)
        : base(syntaxTree)
    {
        AccessibilityModifier = accessibilityModifier;
        TypeKeyword = typeKeyword;
        Identifier = identifier;
        EqualsToken = equalsToken;
        AliasedType = aliasedType;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TypeAliasDeclaration;

    /// <summary>
    /// Gets the optional accessibility modifier token.
    /// </summary>
    public SyntaxToken AccessibilityModifier { get; }

    /// <summary>
    /// Gets the <c>type</c> keyword.
    /// </summary>
    public SyntaxToken TypeKeyword { get; }

    /// <summary>
    /// Gets the alias identifier.
    /// </summary>
    public SyntaxToken Identifier { get; }

    /// <summary>
    /// Gets the <c>=</c> token.
    /// </summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>
    /// Gets the aliased type clause.
    /// </summary>
    public TypeClauseSyntax AliasedType { get; }
}
