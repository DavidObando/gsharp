#nullable disable

// <copyright file="IfExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #669: an if-expression of the form
/// <c>if cond { expr } else { expr }</c> (value-producing) or
/// <c>if cond { expr } else if ... { expr } else { expr }</c> (chained).
/// The else branch is either another <see cref="IfExpressionSyntax"/> (for
/// <c>else if</c> chains) or a <see cref="BlockExpressionSyntax"/>.
/// </summary>
public sealed class IfExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IfExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="ifKeyword">The <c>if</c> keyword token.</param>
    /// <param name="condition">The condition expression.</param>
    /// <param name="thenBlock">The then-block expression.</param>
    /// <param name="elseKeyword">The optional <c>else</c> keyword token (null when absent).</param>
    /// <param name="elseExpression">The optional else-branch: a <see cref="BlockExpressionSyntax"/> or another <see cref="IfExpressionSyntax"/> (null when absent).</param>
    public IfExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken ifKeyword,
        ExpressionSyntax condition,
        BlockExpressionSyntax thenBlock,
        SyntaxToken elseKeyword,
        ExpressionSyntax elseExpression)
        : base(syntaxTree)
    {
        IfKeyword = ifKeyword;
        Condition = condition;
        ThenBlock = thenBlock;
        ElseKeyword = elseKeyword;
        ElseExpression = elseExpression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.IfExpression;

    /// <summary>Gets the <c>if</c> keyword token.</summary>
    public SyntaxToken IfKeyword { get; }

    /// <summary>Gets the condition expression.</summary>
    public ExpressionSyntax Condition { get; }

    /// <summary>Gets the then-block expression.</summary>
    public BlockExpressionSyntax ThenBlock { get; }

    /// <summary>Gets the optional <c>else</c> keyword token.</summary>
    public SyntaxToken ElseKeyword { get; }

    /// <summary>
    /// Gets the else branch: a <see cref="BlockExpressionSyntax"/> for a plain else,
    /// or another <see cref="IfExpressionSyntax"/> for an <c>else if</c> chain.
    /// Null when no else branch is present.
    /// </summary>
    public ExpressionSyntax ElseExpression { get; }
}
