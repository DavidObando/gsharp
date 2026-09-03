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
        if (goDepth == 0 && lockDepth == 0
            && (ChannelRuntimeBinder.IsFacadeCall(node, "Receive")
                || ChannelRuntimeBinder.IsFacadeCall(node, "Receive2")
                || ChannelRuntimeBinder.IsFacadeCall(node, "Send")
                || LockRegions.IsBlockingBridge(node)))
        {
            facts.HasDirectPoint = true;
        }

        base.VisitImportedCallExpression(node);
    }

    /// <inheritdoc/>
    protected override void VisitImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
    {
        if (goDepth == 0 && lockDepth == 0 && ChannelRuntimeBinder.IsScopeExit(node))
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
