// <copyright file="AsExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an expression-level safe cast: <c>expr as T</c> → <c>T</c> or <c>null</c>.
/// Issue #575.
/// </summary>
public sealed class AsExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="AsExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="expression">The expression being cast.</param>
    /// <param name="asKeyword">The <c>as</c> keyword token.</param>
    /// <param name="typeClause">The target type clause.</param>
    public AsExpressionSyntax(SyntaxTree syntaxTree, ExpressionSyntax expression, SyntaxToken asKeyword, TypeClauseSyntax typeClause)
        : base(syntaxTree)
    {
        Expression = expression;
        AsKeyword = asKeyword;
        TypeClause = typeClause;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.AsExpression;

    /// <summary>Gets the left-hand expression being cast.</summary>
    public ExpressionSyntax Expression { get; }

    /// <summary>Gets the <c>as</c> keyword token.</summary>
    public SyntaxToken AsKeyword { get; }

    /// <summary>Gets the target type clause.</summary>
    public TypeClauseSyntax TypeClause { get; }
}
