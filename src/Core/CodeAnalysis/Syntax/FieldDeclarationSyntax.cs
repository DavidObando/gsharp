// <copyright file="FieldDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

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
        Annotations = ImmutableArray<AnnotationSyntax>.Empty;
        AccessibilityModifier = accessibilityModifier;
        Identifier = identifier;
        Type = type;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.FieldDeclaration;

    /// <summary>
    /// Gets the Kotlin-style annotations (ADR-0047) attached to this field
    /// declaration. Empty when no <c>@</c> lead-ins are present. Populated by
    /// the parser via <see cref="WithAnnotations"/> so existing constructor
    /// overloads do not need to be touched. Declared before
    /// <see cref="AccessibilityModifier"/> so that
    /// <see cref="SyntaxNode.GetChildren"/> visits annotations first —
    /// keeping spans and first/last-token lookups stable.
    /// </summary>
    public ImmutableArray<AnnotationSyntax> Annotations { get; private set; }

    /// <summary>Gets the optional accessibility modifier token.</summary>
    public SyntaxToken AccessibilityModifier { get; }

    /// <summary>Gets the field identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the field type clause.</summary>
    public TypeClauseSyntax Type { get; }

    /// <summary>Attaches the given annotation list to this field declaration and returns this same instance for fluent parser use.</summary>
    /// <param name="annotations">The annotation list to attach (may be empty).</param>
    /// <returns>This same <see cref="FieldDeclarationSyntax"/>, with <see cref="Annotations"/> updated.</returns>
    internal FieldDeclarationSyntax WithAnnotations(ImmutableArray<AnnotationSyntax> annotations)
    {
        Annotations = annotations.IsDefault ? ImmutableArray<AnnotationSyntax>.Empty : annotations;
        return this;
    }
}
