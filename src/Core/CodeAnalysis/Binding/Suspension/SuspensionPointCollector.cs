// <copyright file="SuspensionPointCollector.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding.Suspension;

/// <summary>
/// Collects one body's suspension facts for <see cref="SuspensionInference"/>:
/// whether it performs a suspension point directly — a channel operation
/// bound onto the blocking facade, or a blocking bridge to a suspending
/// callee — and which same-compilation functions it calls. A <c>go</c>
/// operand is skipped (the goroutine, not the caller, suspends), a
/// <c>lock</c> body is skipped (its operations stay blocking), and a
/// function literal is a leaf (it is its own function).
/// </summary>
internal sealed class SuspensionPointCollector : BoundTreeWalker
{
    private readonly Facts facts = new();
    private int goDepth;
    private int lockDepth;

    private SuspensionPointCollector()
    {
    }

    /// <summary>Collects the facts for <paramref name="body"/>.</summary>
    /// <param name="body">A bound function body.</param>
    /// <returns>The facts.</returns>
    public static Facts Collect(BoundBlockStatement body)
    {
        var collector = new SuspensionPointCollector();
        collector.Visit(body);
        return collector.facts;
    }

    /// <inheritdoc/>
    protected override void VisitGoStatement(BoundGoStatement node)
    {
        goDepth++;
        try
        {
            base.VisitGoStatement(node);
        }
        finally
        {
            goDepth--;
        }
    }

    /// <inheritdoc/>
    protected override void VisitTryStatement(BoundTryStatement node)
    {
        if (!LockRegions.IsLockRegion(node))
        {
            base.VisitTryStatement(node);
            return;
        }

        lockDepth++;
        try
        {
            base.VisitTryStatement(node);
        }
        finally
        {
            lockDepth--;
        }
    }

    /// <inheritdoc/>
    protected override void VisitFixedStatement(BoundFixedStatement node)
    {
        lockDepth++;
        try
        {
            base.VisitFixedStatement(node);
        }
        finally
        {
            lockDepth--;
        }
    }

    /// <inheritdoc/>
    protected override void VisitImportedCallExpression(BoundImportedCallExpression node)
    {
        var isFacadeOperation =
            (ChannelRuntimeBinder.IsFacadeCall(node, "Receive")
                || ChannelRuntimeBinder.IsFacadeCall(node, "Receive2")
                || ChannelRuntimeBinder.IsFacadeCall(node, "Send"))

            // A facade call the AUTHOR wrote with its own token is an ordinary
            // blocking library call, not a lowered channel operator: the
            // suspension pass has nothing to retarget on it, so coloring the
            // caller would change its ABI for no gain (ADR-0174 D4/D7).
            && !ChannelRuntimeBinder.HasAuthorWrittenCancellation(node);

        if (goDepth == 0 && lockDepth == 0 && (isFacadeOperation || LockRegions.IsBlockingBridge(node)))
        {
            facts.HasDirectPoint = true;
        }

        base.VisitImportedCallExpression(node);
    }

    /// <inheritdoc/>
    protected override void VisitAwaitExpression(BoundAwaitExpression node)
    {
        // ADR-0174 D4, the `await g()` row: an await in a plain `func` is a
        // suspension point, and colours this function exactly as a channel
        // operation would. Reaching here at all means the body is not yet
        // `async` or suspending — inference skips those — so every await the
        // walk finds is one the binder left for it.
        //
        // A `go` operand and a `lock` body are both skipped, and in both cases
        // because `SuspendingCallRewriter` rejects the await outright rather
        // than letting it suspend here: a monitor is thread-affine (errata 10,
        // the reason a channel operation in a `lock` compiles to the blocking
        // form), and an await NESTED in a go operand —
        // `go consume(await fetch())`, the operand's own await having been
        // stripped by `BindGoStatement` — is a shape the emitter cannot lower
        // in any function kind. Colouring this function on an await that is
        // about to be rejected would be a signature change bought for nothing.
        if (goDepth == 0 && lockDepth == 0)
        {
            facts.HasDirectPoint = true;
        }

        base.VisitAwaitExpression(node);
    }

    /// <inheritdoc/>
    protected override void VisitImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
    {
        if (goDepth == 0 && lockDepth == 0 && (ChannelRuntimeBinder.IsScopeExit(node) || ChannelRuntimeBinder.IsSelectWait(node) || ChannelRuntimeBinder.IsAsyncLetCancelIfUnread(node)))
        {
            facts.HasDirectPoint = true;
        }

        base.VisitImportedInstanceCallExpression(node);
    }

    /// <inheritdoc/>
    protected override void VisitCallExpression(BoundCallExpression node)
    {
        if (goDepth == 0)
        {
            facts.Callees.Add(node.Function);
        }

        base.VisitCallExpression(node);
    }

    /// <inheritdoc/>
    protected override void VisitUserInstanceCallExpression(BoundUserInstanceCallExpression node)
    {
        if (goDepth == 0)
        {
            facts.Callees.Add(node.Method);
        }

        base.VisitUserInstanceCallExpression(node);
    }

    /// <summary>One body's suspension facts.</summary>
    internal sealed class Facts
    {
        /// <summary>Gets or sets a value indicating whether the body performs a suspension point itself.</summary>
        public bool HasDirectPoint { get; set; }

        /// <summary>Gets the same-compilation functions the body calls outside <c>go</c> operands.</summary>
        public HashSet<FunctionSymbol> Callees { get; } = new();
    }
}
