// <copyright file="LambdaExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0074 / issue #714: a lambda-expression of the form
/// <c>(p1 T1, p2 T2) -&gt; body</c>. The parameter list is always
/// parenthesised; the body may be either a single expression or a
/// brace-delimited <see cref="BlockExpressionSyntax"/>. Bound to a
/// bound function-literal node, reusing every downstream consumer
/// (closure capture, emit, interpreter, etc.) that already handles
/// function literals.
/// </summary>
public sealed class LambdaExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="LambdaExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openParenToken">The opening <c>(</c> token of the parameter list.</param>
    /// <param name="parameters">The (possibly empty) parenthesised parameter list.</param>
    /// <param name="closeParenToken">The closing <c>)</c> token of the parameter list.</param>
    /// <param name="arrowToken">The <c>-&gt;</c> token separating the parameter list from the body.</param>
    /// <param name="body">The lambda body — a single expression, or a brace-delimited block expression.</param>
    public LambdaExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenToken,
        SyntaxToken arrowToken,
        ExpressionSyntax body)
        : base(syntaxTree)
    {
        OpenParenToken = openParenToken;
        Parameters = parameters;
        CloseParenToken = closeParenToken;
        ArrowToken = arrowToken;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.LambdaExpression;

    /// <summary>Gets the opening <c>(</c> token of the parameter list.</summary>
    public SyntaxToken OpenParenToken { get; }

    /// <summary>Gets the parenthesised parameter list (possibly empty).</summary>
    public SeparatedSyntaxList<ParameterSyntax> Parameters { get; }

    /// <summary>Gets the closing <c>)</c> token of the parameter list.</summary>
    public SyntaxToken CloseParenToken { get; }

    /// <summary>Gets the <c>-&gt;</c> arrow token.</summary>
    public SyntaxToken ArrowToken { get; }

    /// <summary>Gets the lambda body — either a single expression, or a brace-delimited block expression.</summary>
    public ExpressionSyntax Body { get; }
}
