// <copyright file="SizeOfExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents the built-in <c>sizeof(T)</c> operator (issue #1336).
/// <c>sizeof</c> is recognized as a contextual identifier when followed by
/// <c>(</c> and a type clause. The result is the unmanaged byte size of the
/// referenced type as an <c>int32</c>. The measured type must be an unmanaged
/// type — a blittable primitive, a blittable value struct, a pointer, or a
/// generic type parameter constrained <c>unmanaged</c>. Emits the CIL
/// <c>sizeof &lt;T&gt;</c> opcode (which accepts a generic type token), matching
/// C# <c>sizeof(T)</c> over a <c>where T : unmanaged</c> parameter.
/// </summary>
public sealed class SizeOfExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="SizeOfExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="sizeOfIdentifier">The <c>sizeof</c> identifier token.</param>
    /// <param name="openParenthesis">The <c>(</c> token.</param>
    /// <param name="typeClause">The type-clause argument.</param>
    /// <param name="closeParenthesis">The <c>)</c> token.</param>
    public SizeOfExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken sizeOfIdentifier,
        SyntaxToken openParenthesis,
        TypeClauseSyntax typeClause,
        SyntaxToken closeParenthesis)
        : base(syntaxTree)
    {
        SizeOfIdentifier = sizeOfIdentifier;
        OpenParenthesis = openParenthesis;
        TypeClause = typeClause;
        CloseParenthesis = closeParenthesis;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.SizeOfExpression;

    /// <summary>Gets the <c>sizeof</c> identifier token.</summary>
    public SyntaxToken SizeOfIdentifier { get; }

    /// <summary>Gets the opening <c>(</c> token.</summary>
    public SyntaxToken OpenParenthesis { get; }

    /// <summary>Gets the type-clause argument.</summary>
    public TypeClauseSyntax TypeClause { get; }

    /// <summary>Gets the closing <c>)</c> token.</summary>
    public SyntaxToken CloseParenthesis { get; }
}
