// <copyright file="StackAllocExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0124 / issue #1024: a stack-allocation expression
/// <c>stackalloc T[n]</c>. It stack-allocates a contiguous buffer of
/// <c>n</c> elements of the blittable element type <c>T</c>, emitted as the
/// CIL <c>localloc</c> instruction. By default it yields a
/// <c>System.Span&lt;T&gt;</c> over the allocated memory (the safe form, no
/// <c>unsafe</c> context required); when the declaration target is an
/// unmanaged pointer <c>*T</c> (only spellable inside an <c>unsafe</c>
/// context, ADR-0122) it yields the raw <c>T*</c> pointer instead.
/// </summary>
public sealed class StackAllocExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="StackAllocExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="stackAllocKeyword">The contextual <c>stackalloc</c> keyword token.</param>
    /// <param name="elementTypeIdentifier">The element type identifier.</param>
    /// <param name="openBracketToken">The opening bracket token.</param>
    /// <param name="countExpression">The element-count expression.</param>
    /// <param name="closeBracketToken">The closing bracket token.</param>
    public StackAllocExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken stackAllocKeyword,
        SyntaxToken elementTypeIdentifier,
        SyntaxToken openBracketToken,
        ExpressionSyntax countExpression,
        SyntaxToken closeBracketToken)
        : base(syntaxTree)
    {
        StackAllocKeyword = stackAllocKeyword;
        ElementTypeIdentifier = elementTypeIdentifier;
        OpenBracketToken = openBracketToken;
        CountExpression = countExpression;
        CloseBracketToken = closeBracketToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.StackAllocExpression;

    /// <summary>Gets the contextual <c>stackalloc</c> keyword token.</summary>
    public SyntaxToken StackAllocKeyword { get; }

    /// <summary>Gets the element type identifier.</summary>
    public SyntaxToken ElementTypeIdentifier { get; }

    /// <summary>Gets the opening bracket token.</summary>
    public SyntaxToken OpenBracketToken { get; }

    /// <summary>Gets the element-count expression.</summary>
    public ExpressionSyntax CountExpression { get; }

    /// <summary>Gets the closing bracket token.</summary>
    public SyntaxToken CloseBracketToken { get; }
}
