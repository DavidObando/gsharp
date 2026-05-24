// <copyright file="BoundChannelCloseExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound <c>close(ch)</c> built-in (Phase 5.4 / ADR-0022). Marks the
/// channel writer as complete; subsequent sends throw. Returns void.
/// Modeled as an expression for symmetry with other built-ins
/// (<see cref="BoundLenExpression"/>, etc.) — typically appears in an
/// expression statement.
/// </summary>
public sealed class BoundChannelCloseExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundChannelCloseExpression"/> class.</summary>
    /// <param name="channel">The bound channel expression.</param>
    public BoundChannelCloseExpression(BoundExpression channel)
    {
        Channel = channel;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ChannelCloseExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => TypeSymbol.Void;

    /// <summary>Gets the bound channel expression to close.</summary>
    public BoundExpression Channel { get; }
}
