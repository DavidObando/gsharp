// <copyright file="EventSubscriptionSpillTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #4391: a source-event subscription carries the event's type as the
/// declaring construction substitutes it (`EventHandler[string]` for
/// `GB[string].Got`, whose declared type is `EventHandler[T]`).
/// When an awaited receiver or handler makes the async spiller rebuild the
/// node, the rebuilt node must keep that type; the emitter reads it to pick a
/// function-literal handler's delegate constructor.
open class EventSubscriptionSpillTests {
    @Fact
    func InstanceSubscription_WithAwaitedReceiverAndHandler_KeepsEventType() {
        let (ev, substituted) = MakeEvent()
        let subscription = BoundEventSubscriptionExpression(
            nil,
            BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Object),
            TypeSymbol.Object,
            ev,
            BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), substituted),
            isAdd: true,
            substituted
        )
        let rebuilt = SpillAndFind(subscription)
        Assert.NotSame(subscription, rebuilt)
        Assert.Same(substituted, rebuilt.EventType)
    }

    @Fact
    func StaticSubscription_WithAwaitedHandler_KeepsEventType() {
        let (ev, substituted) = MakeEvent()
        let subscription = BoundEventSubscriptionExpression(
            nil,
            receiver: nil,
            TypeSymbol.Object,
            ev,
            BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), substituted),
            isAdd: false,
            substituted
        )
        let rebuilt = SpillAndFind(subscription)
        Assert.NotSame(subscription, rebuilt)
        Assert.Same(substituted, rebuilt.EventType)
    }

    shared {
        /// An event whose declared type (`EventHandler`) differs from the
        /// substituted type the subscription carries (`EventHandler[string]`),
        /// so a rebuilt node that falls back to the declared type is visible.
        private func MakeEvent()(Event EventSymbol, Substituted TypeSymbol) {
            let declared = TypeSymbol.FromClrType(typeof(EventHandler))
            let substituted = TypeSymbol.FromClrType(typeof(EventHandler[string]))
            Assert.NotSame(declared, substituted)
            let ev = EventSymbol(
                "Got",
                declared,
                Accessibility.Public,
                isFieldLike: true,
                isVirtual: false,
                isOverride: false
            )
            return (ev, substituted)
        }

        private func SpillAndFind(subscription BoundEventSubscriptionExpression) BoundEventSubscriptionExpression {
            let body = BoundBlockStatement(
                nil,
                ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, subscription))
            )
            let result = SpillSequenceSpiller.Rewrite(body)
            let statement = Assert.IsType[BoundExpressionStatement](result.Statements.Last())
            return Assert.IsType[BoundEventSubscriptionExpression](statement.Expression)
        }
    }
}
