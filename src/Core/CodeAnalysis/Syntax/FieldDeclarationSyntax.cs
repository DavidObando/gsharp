// <copyright file="FieldDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a field declaration inside a struct (Phase 3.B.1).
/// </summary>
public sealed class FieldDeclarationSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="FieldDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="identifier">The field identifier.</param>
    /// <param name="type">The field type clause.</param>
    public FieldDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken identifier,
        TypeClauseSyntax type)
        : base(syntaxTree)
    {
        AccessibilityModifier = accessibilityModifier;
        Identifier = identifier;
        Type = type;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.FieldDeclaration;

    /// <summary>Gets the optional accessibility modifier token.</summary>
    public SyntaxToken AccessibilityModifier { get; }

    /// <summary>Gets the field identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the field type clause.</summary>
    public TypeClauseSyntax Type { get; }
}
