// <copyright file="ParameterSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a parameter in the language.
/// </summary>
public sealed class ParameterSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ParameterSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="identifier">The parameter identifier.</param>
    /// <param name="ellipsisToken">Optional <c>...</c> token preceding the type clause for variadic parameters (Phase 4.8).</param>
    /// <param name="type">The parameter type.</param>
    public ParameterSyntax(SyntaxTree syntaxTree, SyntaxToken identifier, SyntaxToken ellipsisToken, TypeClauseSyntax type)
        : base(syntaxTree)
    {
        Identifier = identifier;
        EllipsisToken = ellipsisToken;
        Type = type;
        Annotations = ImmutableArray<AnnotationSyntax>.Empty;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="ParameterSyntax"/> class for a non-variadic parameter.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="identifier">The parameter identifier.</param>
    /// <param name="type">The parameter type.</param>
    public ParameterSyntax(SyntaxTree syntaxTree, SyntaxToken identifier, TypeClauseSyntax type)
        : this(syntaxTree, identifier, ellipsisToken: null, type)
    {
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.Parameter;

    /// <summary>
    /// Gets the Kotlin-style annotations (ADR-0047) attached to this parameter.
    /// Empty when the parameter has no <c>@</c> lead-ins. Populated by the
    /// parser via <see cref="WithAnnotations"/>.
    /// </summary>
    public ImmutableArray<AnnotationSyntax> Annotations { get; private set; }

    /// <summary>
    /// Gets the parameter identifier.
    /// </summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the optional <c>...</c> token marking the parameter as variadic (Phase 4.8).</summary>
    public SyntaxToken EllipsisToken { get; }

    /// <summary>
    /// Gets the parameter type.
    /// </summary>
    public TypeClauseSyntax Type { get; }

    /// <summary>Gets a value indicating whether this is a variadic parameter (Phase 4.8).</summary>
    public bool IsVariadic => EllipsisToken != null;

    /// <summary>
    /// Gets or sets the optional <c>scoped</c> contextual modifier token (ADR-0058 / issue #376).
    /// When non-null, the parameter is <c>scoped</c> — its safe-to-escape scope is restricted to
    /// the current function body and the value may not be returned.
    /// Assigned by the parser; <c>null</c> otherwise.
    /// </summary>
    public SyntaxToken ScopedModifier { get; set; }

    /// <summary>Gets a value indicating whether this parameter carries the <c>scoped</c> modifier (ADR-0058).</summary>
    public bool IsScoped => ScopedModifier != null;

    /// <summary>Attaches the given annotation list to this parameter and returns this same instance for fluent parser use.</summary>
    /// <param name="annotations">The annotation list to attach (may be empty).</param>
    /// <returns>This same <see cref="ParameterSyntax"/>, with <see cref="Annotations"/> updated.</returns>
    internal ParameterSyntax WithAnnotations(ImmutableArray<AnnotationSyntax> annotations)
    {
        Annotations = annotations.IsDefault ? ImmutableArray<AnnotationSyntax>.Empty : annotations;
        return this;
    }
}
