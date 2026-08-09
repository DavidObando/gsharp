// <copyright file="IfLetExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0151: an <c>if let</c> expression in value position —
/// <c>if let name = expr [, let n2 = e2]* [&amp;&amp; guard] { value } else { value }</c>.
/// It combines the nullable-binding header of the ADR-0071 <c>if let</c>
/// STATEMENT (the binding list is the very same
/// <see cref="IfLetBindingClauseSyntax"/> list) with the value-producing
/// branch shape of the ADR-0064 if-EXPRESSION. The binder lowers it into the
/// existing <c>BoundBlockExpression</c> / <c>BoundConditionalExpression</c>
/// pair, so no new bound-node kind or backend path is introduced.
/// </summary>
public sealed class IfLetExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IfLetExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="ifKeyword">The <c>if</c> keyword token.</param>
    /// <param name="bindings">The comma-separated list of <c>let</c> bindings.</param>
    /// <param name="ampersandAmpersandToken">The optional <c>&amp;&amp;</c> token that introduces the guard (null when absent).</param>
    /// <param name="guard">The optional guard expression (null when absent).</param>
    /// <param name="thenBlock">The then-block expression.</param>
    /// <param name="elseKeyword">The <c>else</c> keyword token (null only in erroneous source).</param>
    /// <param name="elseExpression">The else branch: a <see cref="BlockExpressionSyntax"/>, an <see cref="IfExpressionSyntax"/>, or a nested <see cref="IfLetExpressionSyntax"/> (null only in erroneous source).</param>
    public IfLetExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken ifKeyword,
        SeparatedSyntaxList<IfLetBindingClauseSyntax> bindings,
        SyntaxToken? ampersandAmpersandToken,
        ExpressionSyntax? guard,
        BlockExpressionSyntax thenBlock,
        SyntaxToken? elseKeyword,
        ExpressionSyntax? elseExpression)
        : base(syntaxTree)
    {
        IfKeyword = ifKeyword;
        Bindings = bindings;
        AmpersandAmpersandToken = ampersandAmpersandToken;
        Guard = guard;
        ThenBlock = thenBlock;
        ElseKeyword = elseKeyword;
        ElseExpression = elseExpression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.IfLetExpression;

    /// <summary>Gets the <c>if</c> keyword token.</summary>
    public SyntaxToken IfKeyword { get; }

    /// <summary>Gets the comma-separated list of bindings.</summary>
    public SeparatedSyntaxList<IfLetBindingClauseSyntax> Bindings { get; }

    /// <summary>Gets the optional <c>&amp;&amp;</c> token introducing the guard; <c>null</c> when there is no guard.</summary>
    public SyntaxToken? AmpersandAmpersandToken { get; }

    /// <summary>
    /// Gets the optional guard expression evaluated after every binding
    /// succeeded (with all bound names in scope); <c>null</c> when absent.
    /// </summary>
    public ExpressionSyntax? Guard { get; }

    /// <summary>Gets the then-block expression.</summary>
    public BlockExpressionSyntax ThenBlock { get; }

    /// <summary>Gets the <c>else</c> keyword token; <c>null</c> only when the source omitted it.</summary>
    public SyntaxToken? ElseKeyword { get; }

    /// <summary>
    /// Gets the else branch: a <see cref="BlockExpressionSyntax"/> for a plain
    /// else, or another <see cref="IfExpressionSyntax"/> /
    /// <see cref="IfLetExpressionSyntax"/> for an <c>else if</c> chain.
    /// <c>null</c> only when the source omitted the else branch (GS0276).
    /// </summary>
    public ExpressionSyntax? ElseExpression { get; }
}
