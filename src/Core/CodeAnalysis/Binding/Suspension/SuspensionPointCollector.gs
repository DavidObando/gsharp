// <copyright file="SuspensionPointCollector.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding.Suspension

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic

/// Collects one body's suspension facts for (cref:SuspensionInference):
/// whether it performs a suspension point directly — a channel operation
/// bound onto the blocking facade, or a blocking bridge to a suspending
/// callee — and which same-compilation functions it calls. A `go`
/// operand is skipped (the goroutine, not the caller, suspends), a
/// `lock` body is skipped (its operations stay blocking), and a
/// function literal is a leaf (it is its own function).
internal class SuspensionPointCollector : BoundTreeWalker {
    private let facts Facts = Facts()
    private var goDepth int32
    private var lockDepth int32

    private init() { }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func VisitGoStatement(node BoundGoStatement) {
        goDepth++
        try {
            base.VisitGoStatement(node)
        } finally {
            goDepth--
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func VisitTryStatement(node BoundTryStatement) {
        if !LockRegions.IsLockRegion(node) {
            base.VisitTryStatement(node)
            return
        }
        lockDepth++
        try {
            base.VisitTryStatement(node)
        } finally {
            lockDepth--
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func VisitFixedStatement(node BoundFixedStatement) {
        lockDepth++
        try {
            base.VisitFixedStatement(node)
        } finally {
            lockDepth--
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func VisitImportedCallExpression(node BoundImportedCallExpression) {
        let isFacadeOperation = (
            ChannelRuntimeBinder.IsFacadeCall(node, "Receive") || ChannelRuntimeBinder.IsFacadeCall(node, "Receive2") ||
                ChannelRuntimeBinder.IsFacadeCall(node, "Send")
        ) &&
            !ChannelRuntimeBinder.HasAuthorWrittenCancellation(node)
        if goDepth == 0 && lockDepth == 0 && (isFacadeOperation || LockRegions.IsBlockingBridge(node)) {
            this.facts.HasDirectPoint = true
        }
        base.VisitImportedCallExpression(node)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func VisitAwaitExpression(node BoundAwaitExpression) {
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
        if goDepth == 0 && lockDepth == 0 {
            this.facts.HasDirectPoint = true
        }
        base.VisitAwaitExpression(node)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func VisitImportedInstanceCallExpression(node BoundImportedInstanceCallExpression) {
        if goDepth == 0 &&
            lockDepth == 0 &&
            (
            ChannelRuntimeBinder.IsScopeExit(node) || ChannelRuntimeBinder.IsSelectWait(node) ||
                ChannelRuntimeBinder.IsAsyncLetCancelIfUnread(node)
        ) {
            this.facts.HasDirectPoint = true
        }
        base.VisitImportedInstanceCallExpression(node)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func VisitCallExpression(node BoundCallExpression) {
        if goDepth == 0 {
            facts.Callees.Add(node.Function)
        }
        base.VisitCallExpression(node)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func VisitUserInstanceCallExpression(node BoundUserInstanceCallExpression) {
        if goDepth == 0 {
            facts.Callees.Add(node.Method)
        }
        base.VisitUserInstanceCallExpression(node)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func VisitBaseClassCallExpression(node BoundBaseClassCallExpression) {
        // Issue #4392: `base.M()` calls the base method as surely as an
        // ordinary instance call does, so a base method inference marks
        // suspending colours its caller too.
        if goDepth == 0 && node.Method is {} method {
            facts.Callees.Add(method)
        }
        base.VisitBaseClassCallExpression(node)
    }

    /// One body's suspension facts.
    internal class Facts {
        init() {
            Callees = HashSet[FunctionSymbol]()
        }

        /// Gets or sets a value indicating whether the body performs a suspension point itself.
        prop HasDirectPoint bool

        /// Gets the same-compilation functions the body calls outside `go` operands.
        prop Callees HashSet[FunctionSymbol] {
            get;
        }
    }

    shared {
        /// Collects the facts for [`body`](paramref).
        /// @param body A bound function body.
        /// @returns The facts.
        func Collect(body BoundBlockStatement) Facts {
            let collector = SuspensionPointCollector()
            collector.Visit(body)
            return collector.facts
        }
    }
}
