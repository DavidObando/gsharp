// <copyright file="DiscardPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>Represents a discard pattern <c>_</c>.</summary>
public sealed class DiscardPatternSyntax : PatternSyntax
{
    /// <summary>Initializes a new instance of the <see cref="DiscardPatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="underscoreToken">The underscore identifier token.</param>
    public DiscardPatternSyntax(SyntaxTree syntaxTree, SyntaxToken underscoreToken)
        : base(syntaxTree)
    {
        UnderscoreToken = underscoreToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.DiscardPattern;

    /// <summary>Gets the underscore token.</summary>
    public SyntaxToken UnderscoreToken { get; }
}
