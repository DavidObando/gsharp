// <copyright file="VariableDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a variable declaration syntax in the language.
/// </summary>
public sealed class VariableDeclarationSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="VariableDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The var keyword.</param>
    /// <param name="identifier">The variable identifier.</param>
    /// <param name="typeClause">The optional type clause.</param>
    /// <param name="equalsToken">The equals token.</param>
    /// <param name="initializer">The initializer expression.</param>
    public VariableDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken keyword,
        SyntaxToken identifier,
        TypeClauseSyntax typeClause,
        SyntaxToken equalsToken,
        ExpressionSyntax initializer)
        : this(syntaxTree, accessibilityModifier: null, keyword, identifier, typeClause, equalsToken, initializer)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="VariableDeclarationSyntax"/> class with an explicit accessibility modifier.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier (only allowed at top level).</param>
    /// <param name="keyword">The var keyword.</param>
    /// <param name="identifier">The variable identifier.</param>
    /// <param name="typeClause">The optional type clause.</param>
    /// <param name="equalsToken">The equals token.</param>
    /// <param name="initializer">The initializer expression.</param>
    public VariableDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken keyword,
        SyntaxToken identifier,
        TypeClauseSyntax typeClause,
        SyntaxToken equalsToken,
        ExpressionSyntax initializer)
        : base(syntaxTree)
    {
        AccessibilityModifier = accessibilityModifier;
        Keyword = keyword;
        Identifier = identifier;
        TypeClause = typeClause;
        EqualsToken = equalsToken;
        Initializer = initializer;
        Annotations = ImmutableArray<AnnotationSyntax>.Empty;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.VariableDeclaration;

    /// <summary>
    /// Gets the Kotlin-style annotations (ADR-0047) attached to this variable
    /// declaration. Empty when no <c>@</c> lead-ins are present. Populated by
    /// the parser via <see cref="WithAnnotations"/> so existing constructor
    /// overloads do not need to be touched. Declared first so that
    /// <see cref="SyntaxNode.GetChildren"/> visits annotations before the
    /// remaining tokens — keeping spans and first/last-token lookups stable.
    /// </summary>
    public ImmutableArray<AnnotationSyntax> Annotations { get; private set; }

    /// <summary>
    /// Gets the optional accessibility modifier token. Only meaningful for top-level declarations.
    /// </summary>
    public SyntaxToken AccessibilityModifier { get; }

    /// <summary>
    /// Gets the var keyword.
    /// </summary>
    public SyntaxToken Keyword { get; }

    /// <summary>
    /// Gets or sets the optional <c>scoped</c> contextual modifier token (ADR-0058 / issue #376).
    /// When non-null, the local's safe-to-escape scope is restricted to the current function body.
    /// </summary>
    public SyntaxToken ScopedModifier { get; set; }

    /// <summary>Gets a value indicating whether this declaration carries the <c>scoped</c> modifier (ADR-0058).</summary>
    public bool IsScoped => ScopedModifier != null;

    /// <summary>
    /// Gets or sets the optional <c>ref</c> contextual modifier token (ADR-0060 follow-up / issue #491).
    /// When non-null, this declaration is a ref-aliasing local: the slot stores a managed pointer to the
    /// initializer's lvalue and reads/writes through the local indirect through the alias.
    /// </summary>
    public SyntaxToken RefKindModifier { get; set; }

    /// <summary>Gets a value indicating whether this declaration carries the <c>ref</c> aliasing modifier (issue #491).</summary>
    public bool HasRefKindModifier => RefKindModifier != null;

    /// <summary>
    /// Gets the variable identifier.
    /// </summary>
    public SyntaxToken Identifier { get; }

    /// <summary>
    /// GEts the optional type clause.
    /// </summary>
    public TypeClauseSyntax TypeClause { get; }

    /// <summary>
    /// Gets the equals token.
    /// </summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>
    /// Gets the initializer expression.
    /// </summary>
    public ExpressionSyntax Initializer { get; }

    /// <summary>Attaches the given annotation list to this variable declaration and returns this same instance for fluent parser use.</summary>
    /// <param name="annotations">The annotation list to attach (may be empty).</param>
    /// <returns>This same <see cref="VariableDeclarationSyntax"/>, with <see cref="Annotations"/> updated.</returns>
    internal VariableDeclarationSyntax WithAnnotations(ImmutableArray<AnnotationSyntax> annotations)
    {
        Annotations = annotations.IsDefault ? ImmutableArray<AnnotationSyntax>.Empty : annotations;
        return this;
    }
}
