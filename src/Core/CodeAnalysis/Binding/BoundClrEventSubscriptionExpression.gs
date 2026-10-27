// <copyright file="BoundClrEventSubscriptionExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Diagnostics.CodeAnalysis
import System.Reflection

/// Stream B′: adds (`+=`) or removes (`-=`) a delegate handler from a
/// CLR (cref:EventInfo). When (cref:Receiver) is `null`,
/// the event is static; otherwise it is dispatched against the receiver value.
/// The expression evaluates to (cref:TypeSymbol.Void).
class BoundClrEventSubscriptionExpression : BoundExpression {
    init(
        syntax SyntaxNode?,
        receiver BoundExpression?,
        eventInfo EventInfo,
        handler BoundExpression,
        isAdd bool,
        constrainedReceiverTypeParameter TypeParameterSymbol? = nil,
        constrainedInterfaceType TypeSymbol? = nil,
        eventContainingType TypeSymbol? = nil
    ) : base(syntax) {
        Receiver = receiver
        Event = eventInfo
        Handler = handler
        IsAdd = isAdd
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter
        ConstrainedInterfaceType = constrainedInterfaceType
        EventContainingType = eventContainingType
    }

    prop Receiver BoundExpression? {
        get;
    }

    prop Event EventInfo {
        get;
    }

    prop Handler BoundExpression {
        get;
    }

    prop IsAdd bool {
        get;
    }

    prop ConstrainedReceiverTypeParameter TypeParameterSymbol? {
        get;
    }

    prop ConstrainedInterfaceType TypeSymbol? {
        get;
    }

    prop EventContainingType TypeSymbol? {
        get;
    }

    internal prop IsNonVirtualBaseCall bool {
        get;
        init;
    }

    @MemberNotNullWhen(true, "ConstrainedReceiverTypeParameter")
    prop IsConstrainedTypeParameterAccess bool -> ConstrainedReceiverTypeParameter != nil

    override prop Type TypeSymbol -> TypeSymbol.Void
    override prop Kind BoundNodeKind -> BoundNodeKind.ClrEventSubscriptionExpression
}
