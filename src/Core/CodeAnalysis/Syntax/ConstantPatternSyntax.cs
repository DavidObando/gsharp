// <copyright file="ConstantPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>Represents a constant pattern wrapping the legacy case expression form.</summary>
public sealed class ConstantPatternSyntax : PatternSyntax
{
    /// <summary>Initializes a new instance of the <see cref="ConstantPatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="expression">The constant expression.</param>
    public ConstantPatternSyntax(SyntaxTree syntaxTree, ExpressionSyntax expression)
        : base(syntaxTree)
    {
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ConstantPattern;

    /// <summary>Gets the constant expression.</summary>
    public ExpressionSyntax Expression { get; }
}
