// <copyright file="ThrowStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>throw expr</c> statement.
/// </summary>
public sealed class ThrowStatementSyntax : StatementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="ThrowStatementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="throwKeyword">The <c>throw</c> keyword.</param>
    /// <param name="expression">The exception expression.</param>
    public ThrowStatementSyntax(SyntaxTree syntaxTree, SyntaxToken throwKeyword, ExpressionSyntax expression)
        : base(syntaxTree)
    {
        ThrowKeyword = throwKeyword;
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ThrowStatement;

    /// <summary>Gets the <c>throw</c> keyword.</summary>
    public SyntaxToken ThrowKeyword { get; }

    /// <summary>Gets the exception expression.</summary>
    public ExpressionSyntax Expression { get; }
}
