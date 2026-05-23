// <copyright file="CallExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a call expression syntax in the language.
/// </summary>
public sealed class CallExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="CallExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="identifier">The identifier.</param>
    /// <param name="openParenthesisToken">The open parenthesis token.</param>
    /// <param name="arguments">The arguments.</param>
    /// <param name="closeParenthesisToken">The close parenthesis token.</param>
    public CallExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken identifier,
        SyntaxToken openParenthesisToken,
        SeparatedSyntaxList<ExpressionSyntax> arguments,
        SyntaxToken closeParenthesisToken)
        : this(syntaxTree, identifier, typeArgumentList: null, openParenthesisToken, arguments, closeParenthesisToken)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="CallExpressionSyntax"/> class with an optional explicit type-argument list (Phase 4.1 / ADR-0020).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="identifier">The identifier.</param>
    /// <param name="typeArgumentList">Optional explicit type-argument list (e.g. <c>[int]</c> in <c>Identity[int](5)</c>).</param>
    /// <param name="openParenthesisToken">The open parenthesis token.</param>
    /// <param name="arguments">The arguments.</param>
    /// <param name="closeParenthesisToken">The close parenthesis token.</param>
    public CallExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken identifier,
        TypeArgumentListSyntax typeArgumentList,
        SyntaxToken openParenthesisToken,
        SeparatedSyntaxList<ExpressionSyntax> arguments,
        SyntaxToken closeParenthesisToken)
        : base(syntaxTree)
    {
        Identifier = identifier;
        TypeArgumentList = typeArgumentList;
        OpenParenthesisToken = openParenthesisToken;
        Arguments = arguments;
        CloseParenthesisToken = closeParenthesisToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.CallExpression;

    /// <summary>
    /// Gets the identifier.
    /// </summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the optional explicit type-argument list <c>[T1, T2]</c> attached to this call site (Phase 4.1 / ADR-0020); <c>null</c> when the call has no explicit type arguments.</summary>
    public TypeArgumentListSyntax TypeArgumentList { get; }

    /// <summary>
    /// Gets the open parenthesis token.
    /// </summary>
    public SyntaxToken OpenParenthesisToken { get; }

    /// <summary>
    /// Gets the arguments.
    /// </summary>
    public SeparatedSyntaxList<ExpressionSyntax> Arguments { get; }

    /// <summary>
    /// Gets the close parenthesis token.
    /// </summary>
    public SyntaxToken CloseParenthesisToken { get; }
}
