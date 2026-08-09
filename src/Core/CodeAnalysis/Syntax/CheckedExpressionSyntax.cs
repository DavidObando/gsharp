// <copyright file="CheckedExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents the built-in <c>checked(expr)</c> / <c>unchecked(expr)</c>
/// operator (issue #1881). <c>checked</c>/<c>unchecked</c> are recognized as
/// contextual identifiers when immediately followed by <c>(</c>. Inside
/// <c>checked(expr)</c>, integral <c>+</c>/<c>-</c>/<c>*</c> and narrowing
/// numeric conversions trap on overflow (throwing
/// <see cref="System.OverflowException"/>) instead of truncating;
/// <c>unchecked(expr)</c> restores the (default) truncating behavior. Nesting
/// is lexical — the innermost <c>checked</c>/<c>unchecked</c> wins.
/// </summary>
public sealed class CheckedExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="CheckedExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The <c>checked</c> or <c>unchecked</c> identifier token.</param>
    /// <param name="openParenthesis">The <c>(</c> token.</param>
    /// <param name="expression">The wrapped expression argument.</param>
    /// <param name="closeParenthesis">The <c>)</c> token.</param>
    /// <param name="isChecked">Whether the keyword was <c>checked</c> (true) or <c>unchecked</c> (false).</param>
    public CheckedExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken keyword,
        SyntaxToken openParenthesis,
        ExpressionSyntax expression,
        SyntaxToken closeParenthesis,
        bool isChecked)
        : base(syntaxTree)
    {
        Keyword = keyword;
        OpenParenthesis = openParenthesis;
        Expression = expression;
        CloseParenthesis = closeParenthesis;
        IsChecked = isChecked;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => IsChecked ? SyntaxKind.CheckedExpression : SyntaxKind.UncheckedExpression;

    /// <summary>Gets the <c>checked</c> or <c>unchecked</c> identifier token.</summary>
    public SyntaxToken Keyword { get; }

    /// <summary>Gets the opening <c>(</c> token.</summary>
    public SyntaxToken OpenParenthesis { get; }

    /// <summary>Gets the wrapped expression argument.</summary>
    public ExpressionSyntax Expression { get; }

    /// <summary>Gets the closing <c>)</c> token.</summary>
    public SyntaxToken CloseParenthesis { get; }

    /// <summary>Gets a value indicating whether the keyword was <c>checked</c> (true) or <c>unchecked</c> (false).</summary>
    public bool IsChecked { get; }
}
