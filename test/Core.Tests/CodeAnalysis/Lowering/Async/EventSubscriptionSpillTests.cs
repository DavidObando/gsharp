// <copyright file="EventSubscriptionSpillTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

/// <summary>
/// Issue #4391: a source-event subscription carries the event's type as the
/// declaring construction substitutes it (<c>EventHandler[string]</c> for
/// <c>GB[string].Got</c>, whose declared type is <c>EventHandler[T]</c>).
/// When an awaited receiver or handler makes the async spiller rebuild the
/// node, the rebuilt node must keep that type; the emitter reads it to pick a
/// function-literal handler's delegate constructor.
/// </summary>
public class EventSubscriptionSpillTests
{
    [Fact]
    public void InstanceSubscription_WithAwaitedReceiverAndHandler_KeepsEventType()
    {
        var (ev, substituted) = MakeEvent();
        var subscription = new BoundEventSubscriptionExpression(
            null,
            new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Object),
            TypeSymbol.Object,
            ev,
            new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), substituted),
            isAdd: true,
            substituted);

        var rebuilt = SpillAndFind(subscription);

        Assert.NotSame(subscription, rebuilt);
        Assert.Same(substituted, rebuilt.EventType);
    }

    [Fact]
    public void StaticSubscription_WithAwaitedHandler_KeepsEventType()
    {
        var (ev, substituted) = MakeEvent();
        var subscription = new BoundEventSubscriptionExpression(
            null,
            receiver: null,
            TypeSymbol.Object,
            ev,
            new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), substituted),
            isAdd: false,
            substituted);

        var rebuilt = SpillAndFind(subscription);

        Assert.NotSame(subscription, rebuilt);
        Assert.Same(substituted, rebuilt.EventType);
    }

    /// <summary>
    /// An event whose declared type (<c>EventHandler</c>) differs from the
    /// substituted type the subscription carries (<c>EventHandler[string]</c>),
    /// so a rebuilt node that falls back to the declared type is visible.
    /// </summary>
    private static (EventSymbol Event, TypeSymbol Substituted) MakeEvent()
    {
        var declared = TypeSymbol.FromClrType(typeof(EventHandler));
        var substituted = TypeSymbol.FromClrType(typeof(EventHandler<string>));
        Assert.NotSame(declared, substituted);
        var ev = new EventSymbol("Got", declared, Accessibility.Public, isFieldLike: true, isVirtual: false, isOverride: false);
        return (ev, substituted);
    }

    private static BoundEventSubscriptionExpression SpillAndFind(BoundEventSubscriptionExpression subscription)
    {
        var body = new BoundBlockStatement(
            null,
            ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, subscription)));

        var result = SpillSequenceSpiller.Rewrite(body);

        var statement = Assert.IsType<BoundExpressionStatement>(result.Statements.Last());
        return Assert.IsType<BoundEventSubscriptionExpression>(statement.Expression);
    }
}
