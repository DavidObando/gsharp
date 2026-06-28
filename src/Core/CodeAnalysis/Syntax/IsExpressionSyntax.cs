#nullable disable

// <copyright file="IsExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an expression-level type-test: <c>expr is T</c> → <c>bool</c>.
/// Issue #575.
/// </summary>
public sealed class IsExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="IsExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="expression">The expression whose runtime type is tested.</param>
    /// <param name="isKeyword">The <c>is</c> keyword token.</param>
    /// <param name="typeClause">The target type clause.</param>
    public IsExpressionSyntax(SyntaxTree syntaxTree, ExpressionSyntax expression, SyntaxToken isKeyword, TypeClauseSyntax typeClause)
        : base(syntaxTree)
    {
        Expression = expression;
        IsKeyword = isKeyword;
        TypeClause = typeClause;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.IsExpression;

    /// <summary>Gets the left-hand expression being type-tested.</summary>
    public ExpressionSyntax Expression { get; }

    /// <summary>Gets the <c>is</c> keyword token.</summary>
    public SyntaxToken IsKeyword { get; }

    /// <summary>Gets the target type clause.</summary>
    public TypeClauseSyntax TypeClause { get; }
}
