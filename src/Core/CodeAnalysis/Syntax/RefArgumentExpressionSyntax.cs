// <copyright file="RefArgumentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0060: an argument-position expression wrapped with a <c>ref</c>, <c>out</c>, or <c>in</c>
/// contextual modifier. For <c>ref</c>/<c>in</c> the inner <see cref="Expression"/> is the
/// lvalue being passed by reference. For <c>out</c>, the node optionally carries an
/// inline-declaration payload (<c>out var name [T]</c>, <c>out let name [T]</c>, or <c>out _</c>)
/// recognised via <see cref="DeclarationKeyword"/> / <see cref="DiscardToken"/>; in those forms
/// <see cref="Expression"/> is <see langword="null"/>.
/// </summary>
public sealed class RefArgumentExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="RefArgumentExpressionSyntax"/> class for the lvalue
    /// form (<c>ref expr</c>, <c>in expr</c>, <c>out expr</c>).
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="refKindModifier">The literal <c>ref</c>/<c>out</c>/<c>in</c> token.</param>
    /// <param name="expression">The lvalue expression being passed by reference.</param>
    public RefArgumentExpressionSyntax(SyntaxTree syntaxTree, SyntaxToken refKindModifier, ExpressionSyntax expression)
        : base(syntaxTree)
    {
        RefKindModifier = refKindModifier;
        Expression = expression;
        DeclarationKeyword = null;
        DeclarationIdentifier = null;
        DiscardToken = null;
        DeclaredType = null;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="RefArgumentExpressionSyntax"/> class for the inline-
    /// declaration form (<c>out var name [T]</c>, <c>out let name [T]</c>) or the discard form (<c>out _</c>).
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="refKindModifier">The <c>out</c> token.</param>
    /// <param name="declarationKeyword">The <c>var</c> or <c>let</c> token (null for <c>out _</c>).</param>
    /// <param name="declarationIdentifier">The new local's identifier (null for <c>out _</c>).</param>
    /// <param name="discardToken">The <c>_</c> token for <c>out _</c>; null otherwise.</param>
    /// <param name="declaredType">Optional type clause for the new local (null when omitted).</param>
    public RefArgumentExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken refKindModifier,
        SyntaxToken declarationKeyword,
        SyntaxToken declarationIdentifier,
        SyntaxToken discardToken,
        TypeClauseSyntax declaredType)
        : base(syntaxTree)
    {
        RefKindModifier = refKindModifier;
        DeclarationKeyword = declarationKeyword;
        DeclarationIdentifier = declarationIdentifier;
        DiscardToken = discardToken;
        DeclaredType = declaredType;
        Expression = null;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.RefArgumentExpression;

    /// <summary>Gets the literal <c>ref</c>, <c>out</c>, or <c>in</c> contextual-modifier token.</summary>
    public SyntaxToken RefKindModifier { get; }

    /// <summary>Gets the lvalue expression for the plain form, or <see langword="null"/> for the declaration/discard forms.</summary>
    public ExpressionSyntax Expression { get; }

    /// <summary>Gets the <c>var</c> or <c>let</c> declaration keyword for <c>out var/let name</c>; <see langword="null"/> otherwise.</summary>
    public SyntaxToken DeclarationKeyword { get; }

    /// <summary>Gets the new local's identifier for <c>out var/let name</c>; <see langword="null"/> otherwise.</summary>
    public SyntaxToken DeclarationIdentifier { get; }

    /// <summary>Gets the underscore token for <c>out _</c>; <see langword="null"/> otherwise.</summary>
    public SyntaxToken DiscardToken { get; }

    /// <summary>Gets the optional type clause for the inline-declared local (<c>out var name T</c>).</summary>
    public TypeClauseSyntax DeclaredType { get; }

    /// <summary>Gets a value indicating whether this argument is an inline-declaration form (<c>out var/let name</c> or <c>out _</c>).</summary>
    public bool IsInlineDeclaration => DeclarationKeyword != null || DiscardToken != null;

    /// <summary>Gets a value indicating whether this argument is the discard form (<c>out _</c>).</summary>
    public bool IsDiscard => DiscardToken != null;
}
