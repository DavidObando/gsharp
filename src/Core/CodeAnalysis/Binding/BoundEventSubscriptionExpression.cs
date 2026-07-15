// <copyright file="BoundEventSubscriptionExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Represents a += / -= subscription to a user-defined event (ADR-0052).
/// </summary>
public sealed class BoundEventSubscriptionExpression : BoundExpression
{
    public BoundEventSubscriptionExpression(
        SyntaxNode syntax,
        BoundExpression receiver,
        TypeSymbol structType,
        EventSymbol eventSymbol,
        BoundExpression handler,
        bool isAdd)
        : base(syntax)
    {
        Receiver = receiver;
        StructType = structType;
        Event = eventSymbol;
        Handler = handler;
        IsAdd = isAdd;
    }

    public BoundExpression Receiver { get; }

    /// <summary>
    /// Gets the event's static owner type: a <see cref="StructSymbol"/> for
    /// the ordinary struct/class case, or an <see cref="InterfaceSymbol"/>
    /// (ADR-0149 follow-up, issue #2370) when the subscription is reached
    /// through an interface-typed receiver (<c>b: IFoo; b.Changed += h</c>),
    /// dispatching via the interface's own add/remove slot.
    /// </summary>
    public TypeSymbol StructType { get; }

    public EventSymbol Event { get; }

    public BoundExpression Handler { get; }

    public bool IsAdd { get; }

    public override TypeSymbol Type => TypeSymbol.Void;

    public override BoundNodeKind Kind => BoundNodeKind.EventSubscriptionExpression;
}
