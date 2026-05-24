// <copyright file="BoundClrEventSubscriptionExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Stream B′: adds (<c>+=</c>) or removes (<c>-=</c>) a delegate handler from a
/// CLR <see cref="EventInfo"/>. When <see cref="Receiver"/> is <see langword="null"/>,
/// the event is static; otherwise it is dispatched against the receiver value.
/// The expression evaluates to <see cref="TypeSymbol.Void"/>.
/// </summary>
public sealed class BoundClrEventSubscriptionExpression : BoundExpression
{
    public BoundClrEventSubscriptionExpression(BoundExpression receiver, EventInfo eventInfo, BoundExpression handler, bool isAdd)
    {
        Receiver = receiver;
        Event = eventInfo;
        Handler = handler;
        IsAdd = isAdd;
    }

    public BoundExpression Receiver { get; }

    public EventInfo Event { get; }

    public BoundExpression Handler { get; }

    public bool IsAdd { get; }

    public override TypeSymbol Type => TypeSymbol.Void;

    public override BoundNodeKind Kind => BoundNodeKind.ClrEventSubscriptionExpression;
}
