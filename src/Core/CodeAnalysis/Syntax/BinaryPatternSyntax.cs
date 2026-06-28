#nullable disable

// <copyright file="BinaryPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a binary pattern combinator such as <c>&gt; 0 and &lt; 10</c>
/// (conjunction) or <c>&lt; 0 or &gt; 100</c> (disjunction). The operator is a
/// contextual keyword (<c>and</c> / <c>or</c>) matched as an identifier in
/// pattern position.
/// </summary>
public sealed class BinaryPatternSyntax : PatternSyntax
{
    /// <summary>Initializes a new instance of the <see cref="BinaryPatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="left">The left-hand sub-pattern.</param>
    /// <param name="operatorToken">The <c>and</c> / <c>or</c> contextual keyword token.</param>
    /// <param name="right">The right-hand sub-pattern.</param>
    public BinaryPatternSyntax(SyntaxTree syntaxTree, PatternSyntax left, SyntaxToken operatorToken, PatternSyntax right)
        : base(syntaxTree)
    {
        Left = left;
        OperatorToken = operatorToken;
        Right = right;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.BinaryPattern;

    /// <summary>Gets the left-hand sub-pattern.</summary>
    public PatternSyntax Left { get; }

    /// <summary>Gets the operator token (<c>and</c> or <c>or</c>).</summary>
    public SyntaxToken OperatorToken { get; }

    /// <summary>Gets the right-hand sub-pattern.</summary>
    public PatternSyntax Right { get; }
}
