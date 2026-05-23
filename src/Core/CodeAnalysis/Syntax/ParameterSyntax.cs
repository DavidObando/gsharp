// <copyright file="ParameterSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
}
