// <copyright file="MakeChannelExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents the built-in <c>make(chan T)</c> or
/// <c>make(chan T, capacity)</c> expression (Phase 5.4 / ADR-0022).
/// <c>make</c> is recognized as a contextual identifier when followed by
/// <c>(</c> and a type-clause starter such as <c>chan</c>.
/// </summary>
public sealed class MakeChannelExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="MakeChannelExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="makeIdentifier">The <c>make</c> identifier token.</param>
    /// <param name="openParenthesis">The <c>(</c> token.</param>
    /// <param name="channelTypeClause">The <c>chan T</c> type clause argument.</param>
    /// <param name="commaToken">The optional <c>,</c> token before the capacity, or <c>null</c>.</param>
    /// <param name="capacity">The optional capacity expression, or <c>null</c>.</param>
    /// <param name="closeParenthesis">The <c>)</c> token.</param>
    public MakeChannelExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken makeIdentifier,
        SyntaxToken openParenthesis,
        TypeClauseSyntax channelTypeClause,
        SyntaxToken commaToken,
        ExpressionSyntax capacity,
        SyntaxToken closeParenthesis)
        : base(syntaxTree)
    {
        MakeIdentifier = makeIdentifier;
        OpenParenthesis = openParenthesis;
        ChannelTypeClause = channelTypeClause;
        CommaToken = commaToken;
        Capacity = capacity;
        CloseParenthesis = closeParenthesis;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.MakeChannelExpression;

    /// <summary>Gets the <c>make</c> identifier token.</summary>
    public SyntaxToken MakeIdentifier { get; }

    /// <summary>Gets the opening <c>(</c> token.</summary>
    public SyntaxToken OpenParenthesis { get; }

    /// <summary>Gets the <c>chan T</c> type-clause argument.</summary>
    public TypeClauseSyntax ChannelTypeClause { get; }

    /// <summary>Gets the optional <c>,</c> separator before the capacity, or <c>null</c>.</summary>
    public SyntaxToken CommaToken { get; }

    /// <summary>Gets the optional capacity expression, or <c>null</c> for an unbounded channel.</summary>
    public ExpressionSyntax Capacity { get; }

    /// <summary>Gets the closing <c>)</c> token.</summary>
    public SyntaxToken CloseParenthesis { get; }
}
