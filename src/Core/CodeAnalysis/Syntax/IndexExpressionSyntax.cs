// <copyright file="IndexExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable SA1611
#pragma warning disable SA1642

/// <summary>
/// Represents an index expression <c>target[index]</c> or the
/// ADR-0073 / issue #710 null-conditional form <c>target?[index]</c>.
/// </summary>
public sealed class IndexExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IndexExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="target">The expression being indexed.</param>
    /// <param name="openBracketToken">The opening bracket token. Either
    /// <see cref="SyntaxKind.OpenSquareBracketToken"/> for plain indexing
    /// or <see cref="SyntaxKind.QuestionOpenBracketToken"/> for the
    /// null-conditional form.</param>
    /// <param name="index">The index expression.</param>
    /// <param name="closeBracketToken">The closing bracket token.</param>
    public IndexExpressionSyntax(
        SyntaxTree syntaxTree,
        ExpressionSyntax target,
        SyntaxToken openBracketToken,
        ExpressionSyntax index,
        SyntaxToken closeBracketToken)
        : this(
            syntaxTree,
            target,
            openBracketToken,
            new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray.Create<SyntaxNode>(index)),
            closeBracketToken)
    {
    }

    #pragma warning restore SA1642
    #pragma warning restore SA1611

    /// <summary>Initializes a new instance of the <see cref="IndexExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">Parent syntax tree.</param>
    /// <param name="target">Indexed target.</param>
    /// <param name="openBracketToken">Opening bracket.</param>
    /// <param name="indices">Index expressions.</param>
    /// <param name="closeBracketToken">Closing bracket.</param>
    public IndexExpressionSyntax(
        SyntaxTree syntaxTree,
        ExpressionSyntax target,
        SyntaxToken openBracketToken,
        SeparatedSyntaxList<ExpressionSyntax> indices,
        SyntaxToken closeBracketToken)
        : base(syntaxTree)
    {
        Target = target;
        OpenBracketToken = openBracketToken;
        Indices = indices;
        CloseBracketToken = closeBracketToken;
        IsNullConditional = openBracketToken.Kind == SyntaxKind.QuestionOpenBracketToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.IndexExpression;

    /// <summary>Gets the expression being indexed.</summary>
    public ExpressionSyntax Target { get; }

    /// <summary>Gets the opening bracket token (either <c>[</c> or <c>?[</c>).</summary>
    public SyntaxToken OpenBracketToken { get; }

    /// <summary>Gets the index expression.</summary>
    [SyntaxChildIgnore]
    public ExpressionSyntax Index => Indices[0];

    /// <summary>Gets index expressions.</summary>
    public SeparatedSyntaxList<ExpressionSyntax> Indices { get; }

    /// <summary>Gets the closing bracket token.</summary>
    public SyntaxToken CloseBracketToken { get; }

    /// <summary>
    /// Gets a value indicating whether this index expression uses the
    /// null-conditional form (<c>?[</c>) introduced by ADR-0073 / issue #710.
    /// </summary>
    public bool IsNullConditional { get; }
}
