// <copyright file="ParenthesizedPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a parenthesized pattern <c>( ... )</c> used to override the
/// default combinator precedence (<c>not</c> &gt; <c>and</c> &gt; <c>or</c>).
/// </summary>
public sealed class ParenthesizedPatternSyntax : PatternSyntax
{
    /// <summary>Initializes a new instance of the <see cref="ParenthesizedPatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openParenthesisToken">The opening parenthesis.</param>
    /// <param name="pattern">The inner pattern.</param>
    /// <param name="closeParenthesisToken">The closing parenthesis.</param>
    public ParenthesizedPatternSyntax(SyntaxTree syntaxTree, SyntaxToken openParenthesisToken, PatternSyntax pattern, SyntaxToken closeParenthesisToken)
        : base(syntaxTree)
    {
        OpenParenthesisToken = openParenthesisToken;
        Pattern = pattern;
        CloseParenthesisToken = closeParenthesisToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ParenthesizedPattern;

    /// <summary>Gets the opening parenthesis token.</summary>
    public SyntaxToken OpenParenthesisToken { get; }

    /// <summary>Gets the inner pattern.</summary>
    public PatternSyntax Pattern { get; }

    /// <summary>Gets the closing parenthesis token.</summary>
    public SyntaxToken CloseParenthesisToken { get; }
}
