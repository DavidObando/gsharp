#nullable disable

// <copyright file="TypeParameterListSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// A <c>[T any, U any]</c>-style bracketed list of type parameters attached to a generic
/// declaration (Phase 4.1 / ADR-0020).
/// </summary>
public sealed class TypeParameterListSyntax : SyntaxNode
{
    /// <summary>Initializes a new instance of the <see cref="TypeParameterListSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBracketToken">The opening <c>[</c> token.</param>
    /// <param name="parameters">The (comma-separated) list of type parameters.</param>
    /// <param name="closeBracketToken">The closing <c>]</c> token.</param>
    public TypeParameterListSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBracketToken,
        SeparatedSyntaxList<TypeParameterSyntax> parameters,
        SyntaxToken closeBracketToken)
        : base(syntaxTree)
    {
        OpenBracketToken = openBracketToken;
        Parameters = parameters;
        CloseBracketToken = closeBracketToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TypeParameterList;

    /// <summary>Gets the opening <c>[</c> token.</summary>
    public SyntaxToken OpenBracketToken { get; }

    /// <summary>Gets the (comma-separated) list of type parameters.</summary>
    public SeparatedSyntaxList<TypeParameterSyntax> Parameters { get; }

    /// <summary>Gets the closing <c>]</c> token.</summary>
    public SyntaxToken CloseBracketToken { get; }
}
