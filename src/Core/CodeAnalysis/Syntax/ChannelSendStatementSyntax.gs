// <copyright file="ChannelSendStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a channel-send statement `ch <- v`
/// (Phase 5.5 / ADR-0022). The send arrow appears at statement
/// position after a channel-typed expression.
class ChannelSendStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:ChannelSendStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param channel The channel expression on the left of the arrow.
    /// @param leftArrowToken The `<-` arrow token.
    /// @param value The value expression on the right of the arrow.
    init(syntaxTree SyntaxTree, channel ExpressionSyntax, leftArrowToken SyntaxToken, value ExpressionSyntax) : base(
        syntaxTree
    ) {
        Channel = channel
        LeftArrowToken = leftArrowToken
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ChannelSendStatement

    /// Gets the channel expression (left-hand side of `<-`).
    prop Channel ExpressionSyntax {
        get;
    }

    /// Gets the `<-` arrow token.
    prop LeftArrowToken SyntaxToken {
        get;
    }

    /// Gets the value expression (right-hand side of `<-`).
    prop Value ExpressionSyntax {
        get;
    }
}
