#nullable disable

// <copyright file="ListPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>Represents a fixed-length list pattern.</summary>
public sealed class ListPatternSyntax : PatternSyntax
{
    /// <summary>Initializes a new instance of the <see cref="ListPatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openSquareBracketToken">The opening bracket token.</param>
    /// <param name="elements">The element patterns.</param>
    /// <param name="closeSquareBracketToken">The closing bracket token.</param>
    public ListPatternSyntax(SyntaxTree syntaxTree, SyntaxToken openSquareBracketToken, SeparatedSyntaxList<PatternSyntax> elements, SyntaxToken closeSquareBracketToken)
        : base(syntaxTree)
    {
        OpenSquareBracketToken = openSquareBracketToken;
        Elements = elements;
        CloseSquareBracketToken = closeSquareBracketToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ListPattern;

    /// <summary>Gets the opening bracket token.</summary>
    public SyntaxToken OpenSquareBracketToken { get; }

    /// <summary>Gets the element patterns.</summary>
    public SeparatedSyntaxList<PatternSyntax> Elements { get; }

    /// <summary>Gets the closing bracket token.</summary>
    public SyntaxToken CloseSquareBracketToken { get; }
}
