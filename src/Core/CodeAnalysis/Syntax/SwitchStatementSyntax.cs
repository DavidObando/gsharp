#nullable disable

// <copyright file="SwitchStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>switch</c> statement of the form
/// <c>switch expr { case A { … } case B { … } default { … } }</c>.
/// Cases do not fall through; arms are independent.
/// </summary>
public sealed class SwitchStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SwitchStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="switchKeyword">The <c>switch</c> keyword.</param>
    /// <param name="expression">The switched-on discriminant expression.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="cases">The case arms.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public SwitchStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken switchKeyword,
        ExpressionSyntax expression,
        SyntaxToken openBraceToken,
        ImmutableArray<SwitchCaseSyntax> cases,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        SwitchKeyword = switchKeyword;
        Expression = expression;
        OpenBraceToken = openBraceToken;
        Cases = cases;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.SwitchStatement;

    /// <summary>Gets the <c>switch</c> keyword.</summary>
    public SyntaxToken SwitchKeyword { get; }

    /// <summary>Gets the discriminant expression.</summary>
    public ExpressionSyntax Expression { get; }

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the case arms.</summary>
    public ImmutableArray<SwitchCaseSyntax> Cases { get; }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
