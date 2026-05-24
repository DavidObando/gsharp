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
    /// <param name="arrowToken">The <c>-&gt;</c> token.</param>
    /// <param name="result">The result expression for this arm.</param>
    public SwitchExpressionArmSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken keyword,
        PatternSyntax value,
        SyntaxToken arrowToken,
        ExpressionSyntax result)
        : base(syntaxTree)
    {
        Keyword = keyword;
        Value = value;
        ArrowToken = arrowToken;
        Result = result;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.SwitchExpressionArm;

    /// <summary>Gets the <c>case</c> or <c>default</c> keyword.</summary>
    public SyntaxToken Keyword { get; }

    /// <summary>Gets the case value pattern, or null when this arm is <c>default</c>.</summary>
    public PatternSyntax Value { get; }

    /// <summary>Gets the <c>-&gt;</c> token.</summary>
    public SyntaxToken ArrowToken { get; }

    /// <summary>Gets the result expression.</summary>
    public ExpressionSyntax Result { get; }

    /// <summary>Gets a value indicating whether this is the <c>default</c> arm.</summary>
    public bool IsDefault => Keyword.Kind == SyntaxKind.DefaultKeyword;
}
