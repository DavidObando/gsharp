// <copyright file="ChannelSendStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a channel-send statement <c>ch &lt;- v</c>
/// (Phase 5.5 / ADR-0022). The send arrow appears at statement
/// position after a channel-typed expression.
/// </summary>
public sealed class ChannelSendStatementSyntax : StatementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="ChannelSendStatementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="channel">The channel expression on the left of the arrow.</param>
    /// <param name="leftArrowToken">The <c>&lt;-</c> arrow token.</param>
    /// <param name="value">The value expression on the right of the arrow.</param>
    public ChannelSendStatementSyntax(SyntaxTree syntaxTree, ExpressionSyntax channel, SyntaxToken leftArrowToken, ExpressionSyntax value)
        : base(syntaxTree)
    {
        Channel = channel;
        LeftArrowToken = leftArrowToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ChannelSendStatement;

    /// <summary>Gets the channel expression (left-hand side of <c>&lt;-</c>).</summary>
    public ExpressionSyntax Channel { get; }

    /// <summary>Gets the <c>&lt;-</c> arrow token.</summary>
    public SyntaxToken LeftArrowToken { get; }

    /// <summary>Gets the value expression (right-hand side of <c>&lt;-</c>).</summary>
    public ExpressionSyntax Value { get; }
}
