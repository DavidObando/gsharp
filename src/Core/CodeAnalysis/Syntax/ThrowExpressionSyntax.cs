// <copyright file="ThrowExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1018: represents a <c>throw expr</c> used in expression position
/// (a throw-expression), e.g. as the right-hand side of <c>??</c>, a branch of
/// the conditional operator, an arrow body, a returned operand, or an
/// argument. Mirrors C# throw-expressions. The statement form
/// (<see cref="ThrowStatementSyntax"/>) is unchanged.
/// </summary>
public sealed class ThrowExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="ThrowExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="throwKeyword">The <c>throw</c> keyword.</param>
    /// <param name="expression">The exception expression.</param>
    public ThrowExpressionSyntax(SyntaxTree syntaxTree, SyntaxToken throwKeyword, ExpressionSyntax expression)
        : base(syntaxTree)
    {
        ThrowKeyword = throwKeyword;
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ThrowExpression;

    /// <summary>Gets the <c>throw</c> keyword.</summary>
    public SyntaxToken ThrowKeyword { get; }

    /// <summary>Gets the exception expression.</summary>
    public ExpressionSyntax Expression { get; }
}
