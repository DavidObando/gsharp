// <copyright file="PropertyDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>prop Name Type { get; set }</c> declaration inside a type body (ADR-0051).
/// </summary>
public sealed class PropertyDeclarationSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PropertyDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="openModifier">The optional <c>open</c> contextual keyword.</param>
    /// <param name="overrideModifier">The optional <c>override</c> contextual keyword.</param>
    /// <param name="propKeyword">The identifier token whose text is <c>prop</c>.</param>
    /// <param name="identifier">The property name.</param>
    /// <param name="type">The property type.</param>
    /// <param name="openBraceToken">The optional opening brace.</param>
    /// <param name="accessors">The get/set accessor list.</param>
    /// <param name="closeBraceToken">The optional closing brace.</param>
    public PropertyDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken openModifier,
        SyntaxToken overrideModifier,
        SyntaxToken propKeyword,
        SyntaxToken identifier,
        TypeClauseSyntax type,
        SyntaxToken openBraceToken,
        ImmutableArray<PropertyAccessorSyntax> accessors,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        Annotations = ImmutableArray<AnnotationSyntax>.Empty;
        Parameters = new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray<SyntaxNode>.Empty);
        AccessibilityModifier = accessibilityModifier;
        OpenModifier = openModifier;
        OverrideModifier = overrideModifier;
        PropKeyword = propKeyword;
        Identifier = identifier;
        Type = type;
        OpenBraceToken = openBraceToken;
        Accessors = accessors;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.PropertyDeclaration;

    /// <summary>
    /// Gets the Kotlin-style annotations (ADR-0047) attached to this property declaration.
    /// Empty when no <c>@</c> lead-ins are present.
    /// </summary>
    public ImmutableArray<AnnotationSyntax> Annotations { get; private set; }

    /// <summary>Gets the optional accessibility modifier token.</summary>
    public SyntaxToken AccessibilityModifier { get; }

    /// <summary>Gets the optional <c>open</c> contextual keyword.</summary>
    public SyntaxToken OpenModifier { get; }

    /// <summary>Gets the optional <c>override</c> contextual keyword.</summary>
    public SyntaxToken OverrideModifier { get; }

    /// <summary>
    /// Gets or sets the <c>shared</c> contextual keyword token when this property
    /// is a static-virtual interface member declared inside an interface
    /// <c>shared { … }</c> block (ADR-0089 / issue #1019), or
    /// <see langword="null"/> for an ordinary instance property.
    /// </summary>
    public SyntaxToken StaticModifier { get; set; }

    /// <summary>Gets a value indicating whether this property carries a <c>shared</c> static modifier (ADR-0089 / issue #1019).</summary>
    public bool HasStaticModifier => StaticModifier != null;

    /// <summary>Gets the identifier token whose text is <c>prop</c>.</summary>
    public SyntaxToken PropKeyword { get; }

    /// <summary>Gets the property name identifier. For an indexer (ADR-0118) this is the <c>this</c> contextual keyword token.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>
    /// Gets the <c>this</c> contextual keyword token when this declaration is an
    /// indexer member (ADR-0118), or <see langword="null"/> for an ordinary property.
    /// </summary>
    public SyntaxToken ThisKeyword { get; private set; }

    /// <summary>Gets the optional opening bracket token of an indexer parameter list (ADR-0118).</summary>
    public SyntaxToken OpenBracketToken { get; private set; }

    /// <summary>Gets the indexer parameter list (ADR-0118). Empty for an ordinary property.</summary>
    public SeparatedSyntaxList<ParameterSyntax> Parameters { get; private set; }

    /// <summary>Gets the optional closing bracket token of an indexer parameter list (ADR-0118).</summary>
    public SyntaxToken CloseBracketToken { get; private set; }

    /// <summary>Gets a value indicating whether this declaration is an indexer member (ADR-0118).</summary>
    public bool IsIndexer => ThisKeyword != null;

    /// <summary>Gets the property type.</summary>
    public TypeClauseSyntax Type { get; }

    /// <summary>Gets the optional opening brace token.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the get/set accessor list.</summary>
    public ImmutableArray<PropertyAccessorSyntax> Accessors { get; }

    /// <summary>Gets the optional closing brace token.</summary>
    public SyntaxToken CloseBraceToken { get; }

    /// <summary>Attaches the given annotation list to this property declaration and returns this same instance for fluent parser use.</summary>
    /// <param name="annotations">The annotation list to attach (may be empty).</param>
    /// <returns>This same <see cref="PropertyDeclarationSyntax"/>, with <see cref="Annotations"/> updated.</returns>
    internal PropertyDeclarationSyntax WithAnnotations(ImmutableArray<AnnotationSyntax> annotations)
    {
        Annotations = annotations.IsDefault ? ImmutableArray<AnnotationSyntax>.Empty : annotations;
        return this;
    }

    /// <summary>
    /// ADR-0118: marks this declaration as an indexer member by attaching the
    /// <c>this</c> keyword token, the bracket tokens, and the index parameter
    /// list. Returns this same instance for fluent parser use.
    /// </summary>
    /// <param name="thisKeyword">The <c>this</c> contextual keyword token.</param>
    /// <param name="openBracketToken">The opening bracket token.</param>
    /// <param name="parameters">The index parameter list.</param>
    /// <param name="closeBracketToken">The closing bracket token.</param>
    /// <returns>This same <see cref="PropertyDeclarationSyntax"/>, marked as an indexer.</returns>
    internal PropertyDeclarationSyntax WithIndexer(
        SyntaxToken thisKeyword,
        SyntaxToken openBracketToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeBracketToken)
    {
        ThisKeyword = thisKeyword;
        OpenBracketToken = openBracketToken;
        Parameters = parameters ?? new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray<SyntaxNode>.Empty);
        CloseBracketToken = closeBracketToken;
        return this;
    }
}
