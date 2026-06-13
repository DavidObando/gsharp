// <copyright file="BaseInterfaceCallExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0091 / issue #757: explicit-base interface call expression of the
/// form <c>base[IFoo].Method(args)</c>. Disambiguates between inherited
/// default interface method (DIM) bodies in a diamond and lets an
/// override delegate to a specific inherited default. The parser commits
/// to this shape when an identifier whose text is <c>"base"</c> is
/// immediately followed by <c>[</c>.
/// </summary>
public sealed class BaseInterfaceCallExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BaseInterfaceCallExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="baseKeyword">The contextual <c>base</c> identifier token.</param>
    /// <param name="openBracketToken">The opening <c>[</c> token.</param>
    /// <param name="interfaceTypeClause">The interface type clause inside the brackets.</param>
    /// <param name="closeBracketToken">The closing <c>]</c> token.</param>
    /// <param name="dotToken">The <c>.</c> token between the bracketed interface selector and the method name.</param>
    /// <param name="methodIdentifier">The method identifier token.</param>
    /// <param name="methodTypeArgumentList">Optional generic method type arguments (reserved; rejected by the binder in this PR).</param>
    /// <param name="openParenthesisToken">The opening <c>(</c> token.</param>
    /// <param name="arguments">The argument list.</param>
    /// <param name="closeParenthesisToken">The closing <c>)</c> token.</param>
    public BaseInterfaceCallExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken baseKeyword,
        SyntaxToken openBracketToken,
        TypeClauseSyntax interfaceTypeClause,
        SyntaxToken closeBracketToken,
        SyntaxToken dotToken,
        SyntaxToken methodIdentifier,
        TypeArgumentListSyntax methodTypeArgumentList,
        SyntaxToken openParenthesisToken,
        SeparatedSyntaxList<ExpressionSyntax> arguments,
        SyntaxToken closeParenthesisToken)
        : base(syntaxTree)
    {
        BaseKeyword = baseKeyword;
        OpenBracketToken = openBracketToken;
        InterfaceTypeClause = interfaceTypeClause;
        CloseBracketToken = closeBracketToken;
        DotToken = dotToken;
        MethodIdentifier = methodIdentifier;
        MethodTypeArgumentList = methodTypeArgumentList;
        OpenParenthesisToken = openParenthesisToken;
        Arguments = arguments;
        CloseParenthesisToken = closeParenthesisToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.BaseInterfaceCallExpression;

    /// <summary>Gets the contextual <c>base</c> identifier token.</summary>
    public SyntaxToken BaseKeyword { get; }

    /// <summary>Gets the opening <c>[</c> token.</summary>
    public SyntaxToken OpenBracketToken { get; }

    /// <summary>Gets the interface selector type clause appearing inside <c>base[...]</c>.</summary>
    public TypeClauseSyntax InterfaceTypeClause { get; }

    /// <summary>Gets the closing <c>]</c> token.</summary>
    public SyntaxToken CloseBracketToken { get; }

    /// <summary>Gets the <c>.</c> token between the bracketed interface and the method name.</summary>
    public SyntaxToken DotToken { get; }

    /// <summary>Gets the method identifier token (the <c>M</c> in <c>base[IFoo].M(...)</c>).</summary>
    public SyntaxToken MethodIdentifier { get; }

    /// <summary>Gets the optional generic method type arguments list (e.g. <c>[int]</c> in <c>base[IFoo].Map[int](...)</c>). Reserved for a future extension; the binder rejects a non-null list in this PR.</summary>
    public TypeArgumentListSyntax MethodTypeArgumentList { get; }

    /// <summary>Gets the opening <c>(</c> token.</summary>
    public SyntaxToken OpenParenthesisToken { get; }

    /// <summary>Gets the argument list.</summary>
    public SeparatedSyntaxList<ExpressionSyntax> Arguments { get; }

    /// <summary>Gets the closing <c>)</c> token.</summary>
    public SyntaxToken CloseParenthesisToken { get; }
}
