// <copyright file="TypeParameterSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// A single type parameter in a generic declaration, e.g. <c>T any</c> in
/// <c>func Map[T any, U any](…)</c> (Phase 4.1 / ADR-0020).
/// </summary>
public sealed class TypeParameterSyntax : SyntaxNode
{
    /// <summary>Initializes a new instance of the <see cref="TypeParameterSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="varianceModifier">Optional <c>in</c>/<c>out</c> variance contextual keyword (ADR-0021); only valid on interface type parameters.</param>
    /// <param name="identifier">The type-parameter identifier token (e.g. <c>T</c>).</param>
    /// <param name="constraint">Optional constraint identifier (e.g. <c>any</c>); when <c>null</c>, the parameter is unconstrained (treated as <c>any</c>).</param>
    public TypeParameterSyntax(SyntaxTree syntaxTree, SyntaxToken varianceModifier, SyntaxToken identifier, SyntaxToken constraint)
        : base(syntaxTree)
    {
        VarianceModifier = varianceModifier;
        Identifier = identifier;
        Constraint = constraint;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TypeParameter;

    /// <summary>Gets the optional variance modifier token (<c>in</c> / <c>out</c>); Phase 4.3 / ADR-0021.</summary>
    public SyntaxToken VarianceModifier { get; }

    /// <summary>Gets the type-parameter identifier token.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the optional constraint identifier token (e.g. <c>any</c>, <c>comparable</c>, or a sealed-interface name).</summary>
    public SyntaxToken Constraint { get; }
}
