// <copyright file="BoundEventSubscriptionExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Represents a += / -= subscription to a user-defined event (ADR-0052).
class BoundEventSubscriptionExpression : BoundExpression {
    init(
        syntax SyntaxNode?,
        receiver BoundExpression?,
        structType TypeSymbol,
        eventSymbol EventSymbol,
        handler BoundExpression,
        isAdd bool,
        eventType TypeSymbol? = nil
    ) : base(syntax) {
        Receiver = receiver
        StructType = structType
        Event = eventSymbol
        Handler = handler
        IsAdd = isAdd
        EventType = eventType ?? eventSymbol.Type
    }

    prop Receiver BoundExpression? {
        get;
    }

    /// Gets the event's static owner type: a (cref:StructSymbol) for
    /// the ordinary struct/class case, or an (cref:InterfaceSymbol)
    /// (ADR-0149 follow-up, issue #2370) when the subscription is reached
    /// through an interface-typed receiver (`b: IFoo; b.Changed += h`),
    /// dispatching via the interface's own add/remove slot.
    prop StructType TypeSymbol {
        get;
    }

    prop Event EventSymbol {
        get;
    }

    prop Handler BoundExpression {
        get;
    }

    prop IsAdd bool {
        get;
    }

    prop EventType TypeSymbol {
        get;
    }

    internal prop IsNonVirtualBaseCall bool {
        get;
        init;
    }

    override prop Type TypeSymbol -> TypeSymbol.Void
    override prop Kind BoundNodeKind -> BoundNodeKind.EventSubscriptionExpression
}
