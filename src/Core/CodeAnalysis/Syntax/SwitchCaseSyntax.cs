// <copyright file="SwitchCaseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a single arm of a <c>switch</c> statement: either a <c>case</c> with
/// a value expression or a <c>default</c> arm. The body is always a block.
/// </summary>
public sealed class SwitchCaseSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SwitchCaseSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The <c>case</c> or <c>default</c> keyword.</param>
    /// <param name="value">The case value pattern (null for <c>default</c>).</param>
    /// <param name="whenKeyword">The optional <c>when</c> contextual keyword introducing a guard, or null.</param>
    /// <param name="guard">The optional boolean guard expression following <c>when</c>, or null.</param>
    /// <param name="body">The case body block.</param>
    public SwitchCaseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken keyword,
        PatternSyntax value,
        SyntaxToken whenKeyword,
        ExpressionSyntax guard,
        BlockStatementSyntax body)
        : base(syntaxTree)
    {
        Keyword = keyword;
        Value = value;
        WhenKeyword = whenKeyword;
        Guard = guard;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.SwitchCase;

    /// <summary>
    /// Gets the <c>case</c> or <c>default</c> keyword.
    /// </summary>
    public SyntaxToken Keyword { get; }

    /// <summary>
    /// Gets the case value pattern, or null when this arm is <c>default</c>.
    /// </summary>
    public PatternSyntax Value { get; }

    /// <summary>
    /// Gets the optional <c>when</c> contextual keyword token introducing a guard, or null when the arm has no guard.
    /// </summary>
    public SyntaxToken WhenKeyword { get; }

    /// <summary>
    /// Gets the optional boolean guard expression following <c>when</c>, or null when the arm has no guard.
    /// </summary>
    public ExpressionSyntax Guard { get; }

    /// <summary>
    /// Gets the case body block.
    /// </summary>
    public BlockStatementSyntax Body { get; }

    /// <summary>
    /// Gets a value indicating whether this is the <c>default</c> arm.
    /// </summary>
    public bool IsDefault => Keyword.Kind == SyntaxKind.DefaultKeyword;
}
