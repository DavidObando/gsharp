// <copyright file="BoundClrEventSubscriptionExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Reflection;

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
    public BoundClrEventSubscriptionExpression(
        SyntaxNode syntax,
        BoundExpression receiver,
        EventInfo eventInfo,
        BoundExpression handler,
        bool isAdd,
        TypeParameterSymbol constrainedReceiverTypeParameter = null,
        TypeSymbol constrainedInterfaceType = null)
        : base(syntax)
    {
        Receiver = receiver;
        Event = eventInfo;
        Handler = handler;
        IsAdd = isAdd;
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter;
        ConstrainedInterfaceType = constrainedInterfaceType;
    }

    public BoundExpression Receiver { get; }

    public EventInfo Event { get; }

    public BoundExpression Handler { get; }

    public bool IsAdd { get; }

    public TypeParameterSymbol ConstrainedReceiverTypeParameter { get; }

    public TypeSymbol ConstrainedInterfaceType { get; }

    public bool IsConstrainedTypeParameterAccess => ConstrainedReceiverTypeParameter != null;

    public override TypeSymbol Type => TypeSymbol.Void;

    public override BoundNodeKind Kind => BoundNodeKind.ClrEventSubscriptionExpression;
}
