#nullable disable

// <copyright file="SwitchExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>switch</c> expression of the form
/// <c>switch expr { case A -> r1 default -> r2 }</c>.
/// </summary>
public sealed class SwitchExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SwitchExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="switchKeyword">The <c>switch</c> keyword.</param>
    /// <param name="expression">The switched-on discriminant expression.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="arms">The switch-expression arms.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public SwitchExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken switchKeyword,
        ExpressionSyntax expression,
        SyntaxToken openBraceToken,
        ImmutableArray<SwitchExpressionArmSyntax> arms,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        SwitchKeyword = switchKeyword;
        Expression = expression;
        OpenBraceToken = openBraceToken;
        Arms = arms;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.SwitchExpression;

    /// <summary>Gets the <c>switch</c> keyword.</summary>
    public SyntaxToken SwitchKeyword { get; }

    /// <summary>Gets the discriminant expression.</summary>
    public ExpressionSyntax Expression { get; }

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the switch-expression arms.</summary>
    public ImmutableArray<SwitchExpressionArmSyntax> Arms { get; }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
