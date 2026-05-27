// <copyright file="BoundChannelReceiveExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound channel-receive expression <c>&lt;-ch</c> (Phase 5.5 / ADR-0022).
/// Yields the channel's element type. Synchronously blocks until a value
/// is available; if the channel is closed and drained, returns the
/// element type's default value.
/// </summary>
public sealed class BoundChannelReceiveExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundChannelReceiveExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="channel">The bound channel expression.</param>
    /// <param name="elementType">The channel's element type (the type yielded by the receive).</param>
    public BoundChannelReceiveExpression(SyntaxNode syntax, BoundExpression channel, TypeSymbol elementType)
        : base(syntax)
    {
        Channel = channel;
        Type = elementType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ChannelReceiveExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>Gets the bound channel expression to receive from.</summary>
    public BoundExpression Channel { get; }
}
