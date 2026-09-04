// <copyright file="ChannelOperationRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// ADR-0174 D4 (Phase 3-1): inside a state-machine body, a channel operation
/// parks the state machine instead of a thread. The binder lowers every
/// <c>&lt;-ch</c>, two-value receive, and <c>ch &lt;- v</c> onto the blocking
/// <c>ChannelOps.Receive / Receive2 / Send</c> facade calls; this rewriter,
/// run before the async pipeline's exception-handler rewrite and spiller,
/// replaces each with an <em>awaited</em> <c>ReceiveValueAsync /
/// ReceiveTupleAsync / SendAsync</c> call of the same type. The spiller then
/// lifts the new awaits to statement level exactly as it does for a
/// user-written <c>await</c>.
/// </summary>
/// <remarks>
/// <para>The one region left on the blocking lowering is a <c>lock</c> body:
/// <c>Monitor</c> is thread-affine, so an await that resumes on another
/// thread would make the lowered <c>Monitor.Exit</c> throw. A channel
/// operation inside a <c>lock</c> keeps blocking here (Phase 3-3 adds the
/// GS0558 warning for it).</para>
/// <para>Discrimination witness (ADR-0154): a mutant that rewrites inside the
/// <c>lock</c> region breaks
/// <c>Adr0174ChannelAwaitInAsyncFuncEmitTests.ReceiveInsideLock_KeepsBlocking</c>
/// (a <c>SynchronizationLockException</c> at <c>Monitor.Exit</c>); a mutant that
/// leaves the blocking facade in place breaks
/// <c>…ParkedReceives_DoNotHoldThreads</c>, which parks more receives than
/// the thread pool has threads.</para>
/// </remarks>
internal sealed class ChannelOperationRewriter : BoundTreeRewriter
{
    private readonly ChannelRuntimeBinder runtime;
    private int lockDepth;

    private ChannelOperationRewriter(ChannelRuntimeBinder runtime)
    {
        this.runtime = runtime;
    }

    /// <summary>Rewrites the blocking channel operations in <paramref name="body"/> into awaited ones.</summary>
    /// <param name="body">A state-machine body.</param>
    /// <param name="references">The compilation's reference resolver; when it does not resolve the runtime the body is returned unchanged.</param>
    /// <returns>The rewritten body, or <paramref name="body"/> when nothing changed.</returns>
    public static BoundBlockStatement Rewrite(BoundBlockStatement body, ReferenceResolver? references)
    {
        if (references == null)
        {
            return body;
        }

        var runtime = new ChannelRuntimeBinder(references);
        if (!runtime.IsAvailable)
        {
            return body;
        }

        var rewriter = new ChannelOperationRewriter(runtime);
        return (BoundBlockStatement)rewriter.RewriteStatement(body);
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteTryStatement(BoundTryStatement node)
    {
        if (!IsLockRegion(node))
        {
            return base.RewriteTryStatement(node);
        }

        lockDepth++;
        try
        {
            return base.RewriteTryStatement(node);
        }
        finally
        {
            lockDepth--;
        }
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteFixedStatement(BoundFixedStatement node)
    {
        // A pinned pointer cannot live across a suspension (ADR-0125 forbids
        // `await` in a fixed body); a channel operation inside one stays blocking.
        lockDepth++;
        try
        {
            return base.RewriteFixedStatement(node);
        }
        finally
        {
            lockDepth--;
        }
    }

    /// <inheritdoc/>
    protected override BoundExpression RewriteImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
    {
        var rewritten = base.RewriteImportedInstanceCallExpression(node);
        if (lockDepth == 0 && rewritten is BoundImportedInstanceCallExpression call)
        {
            if (ChannelRuntimeBinder.IsScopeExit(call))
            {
                // ADR-0174 D6: a scope's join suspends the state machine.
                return runtime.BindScopeExitAwait(call);
            }

            if (ChannelRuntimeBinder.IsSelectWait(call))
            {
                // ADR-0174 D8: a select with no ready arm parks the state
                // machine on every arm at once, rather than a thread.
                return runtime.BindSelectWaitAwait(call);
            }

            if (ChannelRuntimeBinder.IsAsyncLetCancelIfUnread(call))
            {
                // ADR-0174 D15: joining an unread `async let` child suspends
                // the state machine, exactly as the scope's own join does.
                return runtime.BindAsyncLetCancelIfUnreadAwait(call);
            }
        }

        return rewritten;
    }

    /// <inheritdoc/>
    protected override BoundExpression RewriteImportedCallExpression(BoundImportedCallExpression node)
    {
        var rewritten = (BoundImportedCallExpression)base.RewriteImportedCallExpression(node);
        if (lockDepth > 0)
        {
            return rewritten;
        }

        if (ChannelRuntimeBinder.IsFacadeCall(rewritten, "Receive"))
        {
            return runtime.BindReceiveAwait(
                rewritten.Syntax,
                rewritten.Arguments[0],
                ChannelRuntimeBinder.ElementTypeOf(rewritten),
                ChannelRuntimeBinder.DirectionOf(rewritten),
                rewritten.Arguments[1]);
        }

        if (ChannelRuntimeBinder.IsFacadeCall(rewritten, "Receive2"))
        {
            return runtime.BindReceive2Await(
                rewritten.Syntax,
                rewritten.Arguments[0],
                ChannelRuntimeBinder.ElementTypeOf(rewritten),
                ChannelRuntimeBinder.DirectionOf(rewritten),
                rewritten.Arguments[1]);
        }

        if (ChannelRuntimeBinder.IsFacadeCall(rewritten, "Send"))
        {
            return runtime.BindSendAwait(
                rewritten.Syntax,
                rewritten.Arguments[0],
                rewritten.Arguments[1],
                ChannelRuntimeBinder.ElementTypeOf(rewritten),
                ChannelRuntimeBinder.DirectionOf(rewritten),
                rewritten.Arguments[2]);
        }

        return rewritten;
    }

    private static bool IsLockRegion(BoundTryStatement node)
    {
        if (node.FinallyBlock is not BoundBlockStatement finallyBlock)
        {
            return node.FinallyBlock is BoundExpressionStatement single && IsMonitorExit(single.Expression);
        }

        foreach (var statement in finallyBlock.Statements)
        {
            if (statement is BoundExpressionStatement expressionStatement && IsMonitorExit(expressionStatement.Expression))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsMonitorExit(BoundExpression expression)
        => expression is BoundImportedCallExpression { Function: { Name: "Exit" } function }
            && function.ImportedClass.ClassType.FullName == "System.Threading.Monitor";
}
