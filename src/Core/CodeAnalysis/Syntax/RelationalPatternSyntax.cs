#nullable disable

// <copyright file="RelationalPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>Represents a relational pattern such as <c>&gt; 0</c>.</summary>
public sealed class RelationalPatternSyntax : PatternSyntax
{
    /// <summary>Initializes a new instance of the <see cref="RelationalPatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="operatorToken">The operator token.</param>
    /// <param name="expression">The right-hand expression.</param>
    public RelationalPatternSyntax(SyntaxTree syntaxTree, SyntaxToken operatorToken, ExpressionSyntax expression)
        : base(syntaxTree)
    {
        OperatorToken = operatorToken;
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.RelationalPattern;

    /// <summary>Gets the operator token.</summary>
    public SyntaxToken OperatorToken { get; }

    /// <summary>Gets the right-hand expression.</summary>
    public ExpressionSyntax Expression { get; }
}
