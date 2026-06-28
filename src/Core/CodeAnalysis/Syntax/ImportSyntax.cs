#nullable disable

// <copyright file="ImportSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an import declaration in the language.
/// </summary>
public sealed class ImportSyntax : MemberSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ImportSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="importKeyword">The import keyword.</param>
    /// <param name="aliasIdentifier">Optional alias identifier (the LHS of an <c>import alias = path</c> form).</param>
    /// <param name="equalsToken">Optional equals token paired with <paramref name="aliasIdentifier"/>.</param>
    /// <param name="identifiers">The identifiers forming the imported path (dot-included tokens).</param>
    public ImportSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken importKeyword,
        SyntaxToken aliasIdentifier,
        SyntaxToken equalsToken,
        ImmutableArray<SyntaxToken> identifiers)
        : base(syntaxTree)
    {
        ImportKeyword = importKeyword;
        AliasIdentifier = aliasIdentifier;
        EqualsToken = equalsToken;
        IdentifiersWithDots = identifiers;
        Identifiers = identifiers.Where(t => t.Kind == SyntaxKind.IdentifierToken).ToImmutableArray();
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ImportDeclaration;

    /// <summary>
    /// Gets the import keyword.
    /// </summary>
    public SyntaxToken ImportKeyword { get; }

    /// <summary>
    /// Gets the alias identifier when the import uses the <c>import alias = path</c> form, or <c>null</c>.
    /// </summary>
    public SyntaxToken AliasIdentifier { get; }

    /// <summary>
    /// Gets the equals token paired with <see cref="AliasIdentifier"/>, or <c>null</c>.
    /// </summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>
    /// Gets the import statement identifiers, excluding dots.
    /// </summary>
    public ImmutableArray<SyntaxToken> Identifiers { get; }

    /// <summary>
    /// Gets the import statement identifiers, including dots.
    /// </summary>
    public ImmutableArray<SyntaxToken> IdentifiersWithDots { get; }
}
