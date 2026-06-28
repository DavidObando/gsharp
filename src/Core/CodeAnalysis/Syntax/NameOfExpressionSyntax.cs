#nullable disable

// <copyright file="NameOfExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents the built-in <c>nameof(expr)</c> operator (issue #143).
/// <c>nameof</c> is recognized as a contextual identifier when followed by
/// <c>(</c>. The argument must be a name reference (identifier, member access,
/// or generic type instantiation); the binder lowers it to a compile-time
/// string literal of the unqualified short name.
/// </summary>
public sealed class NameOfExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="NameOfExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="nameOfIdentifier">The <c>nameof</c> identifier token.</param>
    /// <param name="openParenthesis">The <c>(</c> token.</param>
    /// <param name="argument">The argument expression — must reduce to a name reference.</param>
    /// <param name="closeParenthesis">The <c>)</c> token.</param>
    public NameOfExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken nameOfIdentifier,
        SyntaxToken openParenthesis,
        ExpressionSyntax argument,
        SyntaxToken closeParenthesis)
        : base(syntaxTree)
    {
        NameOfIdentifier = nameOfIdentifier;
        OpenParenthesis = openParenthesis;
        Argument = argument;
        CloseParenthesis = closeParenthesis;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.NameOfExpression;

    /// <summary>Gets the <c>nameof</c> identifier token.</summary>
    public SyntaxToken NameOfIdentifier { get; }

    /// <summary>Gets the opening <c>(</c> token.</summary>
    public SyntaxToken OpenParenthesis { get; }

    /// <summary>Gets the argument expression.</summary>
    public ExpressionSyntax Argument { get; }

    /// <summary>Gets the closing <c>)</c> token.</summary>
    public SyntaxToken CloseParenthesis { get; }
}
