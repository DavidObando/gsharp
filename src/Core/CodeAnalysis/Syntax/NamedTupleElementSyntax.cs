// <copyright file="NamedTupleElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0172: a labeled tuple-literal element <c>name: expr</c>. Only valid as
/// a direct element of a tuple literal of two or more elements; derives from
/// <see cref="ExpressionSyntax"/> so it slots into the tuple literal's
/// existing separated element list, and the binder unwraps it.
/// </summary>
public sealed class NamedTupleElementSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="NamedTupleElementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="nameToken">The element-name identifier.</param>
    /// <param name="colonToken">The <c>:</c> separating name and value.</param>
    /// <param name="expression">The element value expression.</param>
    public NamedTupleElementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken nameToken,
        SyntaxToken colonToken,
        ExpressionSyntax expression)
        : base(syntaxTree)
    {
        NameToken = nameToken;
        ColonToken = colonToken;
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.NamedTupleElement;

    /// <summary>Gets the element-name identifier token.</summary>
    public SyntaxToken NameToken { get; }

    /// <summary>Gets the <c>:</c> token.</summary>
    public SyntaxToken ColonToken { get; }

    /// <summary>Gets the element value expression.</summary>
    public ExpressionSyntax Expression { get; }
}
