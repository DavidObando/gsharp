// <copyright file="TypeOfExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents the built-in <c>typeof(T)</c> operator (issue #143).
/// <c>typeof</c> is recognized as a contextual identifier when followed by
/// <c>(</c> and a type clause. The result is a <see cref="System.Type"/>
/// obtained from the type's metadata token.
/// </summary>
public sealed class TypeOfExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="TypeOfExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="typeOfIdentifier">The <c>typeof</c> identifier token.</param>
    /// <param name="openParenthesis">The <c>(</c> token.</param>
    /// <param name="typeClause">The type-clause argument.</param>
    /// <param name="closeParenthesis">The <c>)</c> token.</param>
    public TypeOfExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken typeOfIdentifier,
        SyntaxToken openParenthesis,
        TypeClauseSyntax typeClause,
        SyntaxToken closeParenthesis)
        : base(syntaxTree)
    {
        TypeOfIdentifier = typeOfIdentifier;
        OpenParenthesis = openParenthesis;
        TypeClause = typeClause;
        CloseParenthesis = closeParenthesis;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TypeOfExpression;

    /// <summary>Gets the <c>typeof</c> identifier token.</summary>
    public SyntaxToken TypeOfIdentifier { get; }

    /// <summary>Gets the opening <c>(</c> token.</summary>
    public SyntaxToken OpenParenthesis { get; }

    /// <summary>Gets the type-clause argument.</summary>
    public TypeClauseSyntax TypeClause { get; }

    /// <summary>Gets the closing <c>)</c> token.</summary>
    public SyntaxToken CloseParenthesis { get; }
}
