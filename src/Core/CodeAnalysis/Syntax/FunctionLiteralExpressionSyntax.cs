// <copyright file="FunctionLiteralExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// A function literal expression <c>func(p1 T1, p2 T2) R { body }</c>
/// (Phase 4.7). Same shape as a function declaration but without a name,
/// receiver, or modifiers; produces a first-class function value.
/// Optionally preceded by <c>async</c> (Phase 5.1+).
/// </summary>
public sealed class FunctionLiteralExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="FunctionLiteralExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="funcKeyword">The <c>func</c> keyword token.</param>
    /// <param name="openParenToken">The opening <c>(</c>.</param>
    /// <param name="parameters">The parameter list.</param>
    /// <param name="closeParenToken">The closing <c>)</c>.</param>
    /// <param name="returnTypeClause">The optional return-type clause.</param>
    /// <param name="body">The function body.</param>
    public FunctionLiteralExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken funcKeyword,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenToken,
        TypeClauseSyntax returnTypeClause,
        BlockStatementSyntax body)
        : this(syntaxTree, asyncModifier: null, funcKeyword, openParenToken, parameters, closeParenToken, returnTypeClause, body)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="FunctionLiteralExpressionSyntax"/> class with an optional <c>async</c> modifier.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="asyncModifier">Optional <c>async</c> modifier token.</param>
    /// <param name="funcKeyword">The <c>func</c> keyword token.</param>
    /// <param name="openParenToken">The opening <c>(</c>.</param>
    /// <param name="parameters">The parameter list.</param>
    /// <param name="closeParenToken">The closing <c>)</c>.</param>
    /// <param name="returnTypeClause">The optional return-type clause.</param>
    /// <param name="body">The function body.</param>
    public FunctionLiteralExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken asyncModifier,
        SyntaxToken funcKeyword,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenToken,
        TypeClauseSyntax returnTypeClause,
        BlockStatementSyntax body)
        : base(syntaxTree)
    {
        AsyncModifier = asyncModifier;
        FuncKeyword = funcKeyword;
        OpenParenToken = openParenToken;
        Parameters = parameters;
        CloseParenToken = closeParenToken;
        ReturnTypeClause = returnTypeClause;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.FunctionLiteralExpression;

    /// <summary>Gets the optional <c>async</c> modifier token.</summary>
    public SyntaxToken AsyncModifier { get; }

    /// <summary>Gets a value indicating whether this function literal is async.</summary>
    public bool IsAsync => AsyncModifier != null;

    /// <summary>Gets the <c>func</c> keyword token.</summary>
    public SyntaxToken FuncKeyword { get; }

    /// <summary>Gets the opening parenthesis token.</summary>
    public SyntaxToken OpenParenToken { get; }

    /// <summary>Gets the parameter list.</summary>
    public SeparatedSyntaxList<ParameterSyntax> Parameters { get; }

    /// <summary>Gets the closing parenthesis token.</summary>
    public SyntaxToken CloseParenToken { get; }

    /// <summary>Gets the optional return-type clause.</summary>
    public TypeClauseSyntax ReturnTypeClause { get; }

    /// <summary>Gets the function body.</summary>
    public BlockStatementSyntax Body { get; }
}
