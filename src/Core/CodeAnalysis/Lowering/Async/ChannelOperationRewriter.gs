// <copyright file="ChannelOperationRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols

/// ADR-0174 D4 (Phase 3-1): inside a state-machine body, a channel operation
/// parks the state machine instead of a thread. The binder lowers every
/// `<-ch`, two-value receive, and `ch <- v` onto the blocking
/// `ChannelOps.Receive / Receive2 / Send` facade calls; this rewriter,
/// run before the async pipeline's exception-handler rewrite and spiller,
/// replaces each with an <em>awaited</em> `ReceiveValueAsync /
/// ReceiveTupleAsync / SendAsync` call of the same type. The spiller then
/// lifts the new awaits to statement level exactly as it does for a
/// user-written `await`.
/// @remarks The one region left on the blocking lowering is a `lock` body:
/// `Monitor` is thread-affine, so an await that resumes on another
/// thread would make the lowered `Monitor.Exit` throw. A channel
/// operation inside a `lock` keeps blocking here (Phase 3-3 adds the
/// GS0558 warning for it).
///
/// Discrimination witness (ADR-0154): a mutant that rewrites inside the
/// `lock` region breaks
/// `Adr0174ChannelAwaitInAsyncFuncEmitTests.ReceiveInsideLock_KeepsBlocking`
/// (a `SynchronizationLockException` at `Monitor.Exit`); a mutant that
/// leaves the blocking facade in place breaks
/// `…ParkedReceives_DoNotHoldThreads`, which parks more receives than
/// the thread pool has threads.
internal class ChannelOperationRewriter : BoundTreeRewriter {
    private let runtime ChannelRuntimeBinder
    private var lockDepth int32

    private init(runtime ChannelRuntimeBinder) {
        this.runtime = runtime
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteTryStatement(node BoundTryStatement) BoundStatement {
        if !IsLockRegion(node) {
            return base.RewriteTryStatement(node)
        }
        lockDepth++
        try {
            return base.RewriteTryStatement(node)
        } finally {
            lockDepth--
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteFixedStatement(node BoundFixedStatement) BoundStatement {
        // A pinned pointer cannot live across a suspension (ADR-0125 forbids
        // `await` in a fixed body); a channel operation inside one stays blocking.
        lockDepth++
        try {
            return base.RewriteFixedStatement(node)
        } finally {
            lockDepth--
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteImportedInstanceCallExpression(
        node BoundImportedInstanceCallExpression
    ) BoundExpression {
        let rewritten = base.RewriteImportedInstanceCallExpression(node)
        if lockDepth == 0 && rewritten is BoundImportedInstanceCallExpression call {
            if ChannelRuntimeBinder.IsScopeExit(call) {
                // ADR-0174 D6: a scope's join suspends the state machine.
                return runtime.BindScopeExitAwait(call)
            }
            if ChannelRuntimeBinder.IsSelectWait(call) {
                // ADR-0174 D8: a select with no ready arm parks the state
                // machine on every arm at once, rather than a thread.
                return runtime.BindSelectWaitAwait(call)
            }
            if ChannelRuntimeBinder.IsAsyncLetCancelIfUnread(call) {
                // ADR-0174 D15: joining an unread `async let` child suspends
                // the state machine, exactly as the scope's own join does.
                return runtime.BindAsyncLetCancelIfUnreadAwait(call)
            }
        }
        return rewritten
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteImportedCallExpression(node BoundImportedCallExpression) BoundExpression {
        let rewritten = cast[BoundImportedCallExpression](base.RewriteImportedCallExpression(node))
        if lockDepth > 0 {
            return rewritten
        }
        if ChannelRuntimeBinder.IsFacadeCall(rewritten, "Receive") {
            return runtime.BindReceiveAwait(
                rewritten.Syntax,
                rewritten.Arguments[0],
                ChannelRuntimeBinder.ElementTypeOf(rewritten),
                ChannelRuntimeBinder.DirectionOf(rewritten),
                rewritten.Arguments[1]
            )
        }
        if ChannelRuntimeBinder.IsFacadeCall(rewritten, "Receive2") {
            return runtime.BindReceive2Await(
                rewritten.Syntax,
                rewritten.Arguments[0],
                ChannelRuntimeBinder.ElementTypeOf(rewritten),
                ChannelRuntimeBinder.DirectionOf(rewritten),
                rewritten.Arguments[1]
            )
        }
        if ChannelRuntimeBinder.IsFacadeCall(rewritten, "Send") {
            return runtime.BindSendAwait(
                rewritten.Syntax,
                rewritten.Arguments[0],
                rewritten.Arguments[1],
                ChannelRuntimeBinder.ElementTypeOf(rewritten),
                ChannelRuntimeBinder.DirectionOf(rewritten),
                rewritten.Arguments[2]
            )
        }
        return rewritten
    }

    shared {
        /// Rewrites the blocking channel operations in [`body`](paramref) into awaited ones.
        /// @param body A state-machine body.
        /// @param references The compilation's reference resolver; when it does not resolve the runtime the
        /// body is returned unchanged.
        /// @returns The rewritten body, or [`body`](paramref) when nothing changed.
        func Rewrite(body BoundBlockStatement, references ReferenceResolver?) BoundBlockStatement {
            if references == nil {
                return body
            }
            let runtime = ChannelRuntimeBinder(references)
            if !runtime.IsAvailable {
                return body
            }
            let rewriter = ChannelOperationRewriter(runtime)
            return cast[BoundBlockStatement](rewriter.RewriteStatement(body))
        }

        private func IsLockRegion(node BoundTryStatement) bool {
            if node.FinallyBlock is not BoundBlockStatement finallyBlock {
                return node.FinallyBlock is BoundExpressionStatement single && IsMonitorExit(single.Expression)
            }
            for statement in finallyBlock.Statements {
                if statement is BoundExpressionStatement expressionStatement &&
                    IsMonitorExit(expressionStatement.Expression) {
                    return true
                }
            }
            return false
        }

        private func IsMonitorExit(expression BoundExpression) bool -> expression is BoundImportedCallExpression{
            Function: {Name: "Exit"} function
        } &&
            function
            .ImportedClass
            .ClassType
            .FullName == "System.Threading.Monitor"
    }
}
