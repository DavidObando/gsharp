// <copyright file="NamedArgumentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a named argument expression <c>Name = value</c> inside the scoped <c>.copy(...)</c> sugar.
/// </summary>
public sealed class NamedArgumentExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="NamedArgumentExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="nameToken">The argument name.</param>
    /// <param name="equalsToken">The equals separator.</param>
    /// <param name="expression">The argument value.</param>
    public NamedArgumentExpressionSyntax(SyntaxTree syntaxTree, SyntaxToken nameToken, SyntaxToken equalsToken, ExpressionSyntax expression)
        : base(syntaxTree)
    {
        NameToken = nameToken;
        EqualsToken = equalsToken;
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.NamedArgumentExpression;

    /// <summary>Gets the argument name.</summary>
    public SyntaxToken NameToken { get; }

    /// <summary>Gets the equals separator.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the argument value.</summary>
    public ExpressionSyntax Expression { get; }
}
