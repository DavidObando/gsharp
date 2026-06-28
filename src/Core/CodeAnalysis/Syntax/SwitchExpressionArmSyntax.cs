#nullable disable

// <copyright file="SwitchExpressionArmSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a single arm of a <c>switch</c> expression.
/// </summary>
public sealed class SwitchExpressionArmSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SwitchExpressionArmSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The <c>case</c> or <c>default</c> keyword.</param>
    /// <param name="value">The case value pattern, or null for <c>default</c>.</param>
    /// <param name="whenKeyword">The optional <c>when</c> contextual keyword introducing a guard, or null.</param>
    /// <param name="guard">The optional boolean guard expression following <c>when</c>, or null.</param>
    /// <param name="arrowToken">The <c>:</c> (preferred) or <c>-&gt;</c> (deprecated, ADR-0074) separator token.</param>
    /// <param name="result">The result expression for this arm.</param>
    public SwitchExpressionArmSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken keyword,
        PatternSyntax value,
        SyntaxToken whenKeyword,
        ExpressionSyntax guard,
        SyntaxToken arrowToken,
        ExpressionSyntax result)
        : base(syntaxTree)
    {
        Keyword = keyword;
        Value = value;
        WhenKeyword = whenKeyword;
        Guard = guard;
        ArrowToken = arrowToken;
        Result = result;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.SwitchExpressionArm;

    /// <summary>Gets the <c>case</c> or <c>default</c> keyword.</summary>
    public SyntaxToken Keyword { get; }

    /// <summary>Gets the case value pattern, or null when this arm is <c>default</c>.</summary>
    public PatternSyntax Value { get; }

    /// <summary>Gets the optional <c>when</c> contextual keyword token introducing a guard, or null when the arm has no guard.</summary>
    public SyntaxToken WhenKeyword { get; }

    /// <summary>Gets the optional boolean guard expression following <c>when</c>, or null when the arm has no guard.</summary>
    public ExpressionSyntax Guard { get; }

    /// <summary>Gets the separator token between the pattern and the result expression. Either <c>:</c> (ADR-0074, preferred) or <c>-&gt;</c> (deprecated, warns with GS0302).</summary>
    public SyntaxToken ArrowToken { get; }

    /// <summary>Gets the result expression.</summary>
    public ExpressionSyntax Result { get; }

    /// <summary>Gets a value indicating whether this is the <c>default</c> arm.</summary>
    public bool IsDefault => Keyword.Kind == SyntaxKind.DefaultKeyword;
}
