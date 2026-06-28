#nullable disable

// <copyright file="BoundMakeChannelExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound <c>make(chan T)</c> or <c>make(chan T, capacity)</c> expression
/// (Phase 5.4 / ADR-0022). Constructs a <see cref="System.Threading.Channels.Channel{T}"/>:
/// the unbounded form when <see cref="Capacity"/> is <c>null</c>; otherwise
/// the bounded form using the given capacity.
/// </summary>
public sealed class BoundMakeChannelExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundMakeChannelExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="channelType">The constructed channel type.</param>
    /// <param name="capacity">The optional bounded-channel capacity expression.</param>
    public BoundMakeChannelExpression(SyntaxNode syntax, ChannelTypeSymbol channelType, BoundExpression capacity)
        : base(syntax)
    {
        ChannelType = channelType;
        Capacity = capacity;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.MakeChannelExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => ChannelType;

    /// <summary>Gets the constructed channel type.</summary>
    public ChannelTypeSymbol ChannelType { get; }

    /// <summary>Gets the optional capacity expression (bounded channel) or <c>null</c> (unbounded).</summary>
    public BoundExpression Capacity { get; }
}
