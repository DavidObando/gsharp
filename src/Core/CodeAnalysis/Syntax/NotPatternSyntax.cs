// <copyright file="NotPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a negated pattern such as <c>not &gt; 0</c>. The <c>not</c>
/// operator is a contextual keyword matched as an identifier in pattern
/// position and binds more tightly than <c>and</c> / <c>or</c>.
/// </summary>
public sealed class NotPatternSyntax : PatternSyntax
{
    /// <summary>Initializes a new instance of the <see cref="NotPatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="notKeyword">The <c>not</c> contextual keyword token.</param>
    /// <param name="pattern">The negated sub-pattern.</param>
    public NotPatternSyntax(SyntaxTree syntaxTree, SyntaxToken notKeyword, PatternSyntax pattern)
        : base(syntaxTree)
    {
        NotKeyword = notKeyword;
        Pattern = pattern;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.NotPattern;

    /// <summary>Gets the <c>not</c> keyword token.</summary>
    public SyntaxToken NotKeyword { get; }

    /// <summary>Gets the negated sub-pattern.</summary>
    public PatternSyntax Pattern { get; }
}
