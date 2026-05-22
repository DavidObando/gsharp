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
        : base(syntaxTree)
    {
        TypeKeyword = typeKeyword;
        Identifier = identifier;
        EqualsToken = equalsToken;
        AliasedType = aliasedType;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TypeAliasDeclaration;

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
