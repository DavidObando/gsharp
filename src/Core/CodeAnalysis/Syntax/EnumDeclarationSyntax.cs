// <copyright file="EnumDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>enum Name { ... }</c> declaration.
/// </summary>
public sealed class EnumDeclarationSyntax : MemberSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EnumDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The enum type identifier.</param>
    /// <param name="enumKeyword">The <c>enum</c> keyword.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="members">The comma-separated enum members.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public EnumDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken enumKeyword,
        SyntaxToken openBraceToken,
        SeparatedSyntaxList<EnumMemberSyntax> members,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        AccessibilityModifier = accessibilityModifier;
        TypeKeyword = typeKeyword;
        Identifier = identifier;
        EnumKeyword = enumKeyword;
        OpenBraceToken = openBraceToken;
        Members = members;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.EnumDeclaration;

    /// <summary>Gets the optional accessibility modifier token.</summary>
    public SyntaxToken AccessibilityModifier { get; }

    /// <summary>Gets the <c>type</c> keyword.</summary>
    public SyntaxToken TypeKeyword { get; }

    /// <summary>Gets the enum type identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the <c>enum</c> keyword.</summary>
    public SyntaxToken EnumKeyword { get; }

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the comma-separated enum members.</summary>
    public SeparatedSyntaxList<EnumMemberSyntax> Members { get; }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }

    /// <summary>Gets or sets the optional <c>sealed</c> contextual keyword (ADR-0078). The parser sets this to non-null for an enum declared <c>sealed enum Foo { ... }</c>, but the new grammar rejects that combination — kept as a field only for diagnostic recovery. Discriminated-union enums are already closed-hierarchy by construction.</summary>
    public SyntaxToken SealedKeyword { get; set; }
}
