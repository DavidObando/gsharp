#nullable disable

// <copyright file="TypeArgumentListSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// A <c>[T1, T2]</c>-style bracketed list of type arguments attached to a generic
/// reference or call site (Phase 4.1 / ADR-0020), e.g. <c>Map[int, string](xs, f)</c>.
/// </summary>
public sealed class TypeArgumentListSyntax : SyntaxNode
{
    /// <summary>Initializes a new instance of the <see cref="TypeArgumentListSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBracketToken">The opening <c>[</c> token.</param>
    /// <param name="arguments">The (comma-separated) list of type-clause arguments.</param>
    /// <param name="closeBracketToken">The closing <c>]</c> token.</param>
    public TypeArgumentListSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBracketToken,
        SeparatedSyntaxList<TypeClauseSyntax> arguments,
        SyntaxToken closeBracketToken)
        : base(syntaxTree)
    {
        OpenBracketToken = openBracketToken;
        Arguments = arguments;
        CloseBracketToken = closeBracketToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TypeArgumentList;

    /// <summary>Gets the opening <c>[</c> token.</summary>
    public SyntaxToken OpenBracketToken { get; }

    /// <summary>Gets the (comma-separated) list of type-clause arguments.</summary>
    public SeparatedSyntaxList<TypeClauseSyntax> Arguments { get; }

    /// <summary>Gets the closing <c>]</c> token.</summary>
    public SyntaxToken CloseBracketToken { get; }
}
