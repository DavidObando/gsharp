// <copyright file="ChannelCreationExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents channel construction (ADR-0174 D12): the channel type clause
/// applied to arguments — <c>chan[T]()</c> for a rendezvous channel and
/// <c>chan[T](n)</c> for a buffered one — the exact parallel of
/// <c>map[K,V]{…}</c> constructing a dictionary and of <c>List[int32]()</c>.
/// </summary>
public sealed class ChannelCreationExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="ChannelCreationExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="typeClause">The <c>chan[T]</c> type clause.</param>
    /// <param name="openParenthesis">The <c>(</c> token.</param>
    /// <param name="arguments">The capacity argument list (empty or one expression).</param>
    /// <param name="closeParenthesis">The <c>)</c> token.</param>
    public ChannelCreationExpressionSyntax(
        SyntaxTree syntaxTree,
        TypeClauseSyntax typeClause,
        SyntaxToken openParenthesis,
        SeparatedSyntaxList<ExpressionSyntax> arguments,
        SyntaxToken closeParenthesis)
        : base(syntaxTree)
    {
        TypeClause = typeClause;
        OpenParenthesis = openParenthesis;
        Arguments = arguments;
        CloseParenthesis = closeParenthesis;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ChannelCreationExpression;

    /// <summary>Gets the <c>chan[T]</c> type clause being constructed.</summary>
    public TypeClauseSyntax TypeClause { get; }

    /// <summary>Gets the opening <c>(</c> token.</summary>
    public SyntaxToken OpenParenthesis { get; }

    /// <summary>Gets the argument list: empty for a rendezvous channel, one capacity expression for a buffered one.</summary>
    public SeparatedSyntaxList<ExpressionSyntax> Arguments { get; }

    /// <summary>Gets the closing <c>)</c> token.</summary>
    public SyntaxToken CloseParenthesis { get; }
}
