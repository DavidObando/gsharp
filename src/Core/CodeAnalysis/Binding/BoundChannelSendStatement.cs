// <copyright file="BoundChannelSendStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound channel-send statement <c>ch &lt;- v</c> (Phase 5.5 / ADR-0022).
/// Synchronously blocks until the channel accepts the value.
/// </summary>
public sealed class BoundChannelSendStatement : BoundStatement
{
    /// <summary>Initializes a new instance of the <see cref="BoundChannelSendStatement"/> class.</summary>
    /// <param name="channel">The bound channel expression.</param>
    /// <param name="value">The bound value expression (converted to the channel's element type).</param>
    public BoundChannelSendStatement(BoundExpression channel, BoundExpression value)
    {
        Channel = channel;
        Value = value;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ChannelSendStatement;

    /// <summary>Gets the bound channel expression to send into.</summary>
    public BoundExpression Channel { get; }

    /// <summary>Gets the bound value expression.</summary>
    public BoundExpression Value { get; }
}
