// <copyright file="GoCapturedVariableCollector.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic
import System.Collections.Immutable

/// Computes the capture set of a `go` statement's (shaped) goroutine
/// expression — the same walk `Emit.SlotPlanner.CollectCapturedVariables`
/// used at emit time to size the synthesized display class, moved here (and
/// made the single implementation, with `SlotPlanner` now delegating to
/// it) so it can also run at BIND time.
/// @remarks Copilot review of PR #4273 / issue #4271: unlike (cref:LambdaBinder)'s
/// function-literal capture checks, the `go`-statement closure path never
/// ran any capture-legality validation at all — its capture set was computed
/// for the first time at emit, long after diagnostics are collected, so a
/// captured `ref`/`var ref` LOCAL alias (GS9011) or a captured
/// `ref`/`out`/`in` PARAMETER (GS9010) silently fell back to a
/// by-value snapshot instead of being rejected. Sharing this single collector
/// between bind time (`StatementBinder.BindGoStatement`, which now feeds
/// its result to (cref:ClosureCaptureLegalityChecker)) and emit time
/// guarantees the checked set and the actually-captured set can never drift
/// apart.
internal shared class GoCapturedVariableCollector {
    private class Walker : BoundTreeWalker {
        private let seen HashSet[VariableSymbol]
        private let declared HashSet[VariableSymbol]
        private let captured ImmutableArray[VariableSymbol].Builder

        init(
            seen HashSet[VariableSymbol],
            declared HashSet[VariableSymbol],
            captured ImmutableArray[VariableSymbol].Builder
        ) {
            this.seen = seen
            this.declared = declared
            this.captured = captured
        }

        override func VisitExpression(node BoundExpression?) {
            if node == nil {
                return
            }
            if node is BoundVariableExpression ve {
                this.CaptureIfFree(ve.Variable)
                return
            }
            // Issue #3323: BoundTreeWalker (matching BoundTreeRewriter) treats a
            // nested BoundFunctionLiteralExpression as an opaque leaf — its body
            // is a separate lexical scope, so the walk never sees the literal's
            // own captured-variable reads directly. That's correct for the
            // literal's OWN capture analysis (LambdaBinder already resolved
            // those onto node.CapturedVariables when the literal was bound), but
            // this walker computes the *go-wrapper's* capture set, not the
            // literal's. `go func() { c <- 42 }()` binds to an indirect call
            // whose Function is exactly such a literal; without folding the
            // literal's own CapturedVariables in here, the go-wrapper display
            // class gets no field for `c`, and the wrapper's embedded literal-
            // creation code — itself left unrewritten, since CaptureRewriter is
            // equally opaque to nested literals — tries to read `c` straight off
            // the go-wrapper's Invoke method, where it has no local slot,
            // crashing emit with GS9998 ("no local slot"). Mirror
            // LambdaBinder.CapturedVariableCollector.RewriteFunctionLiteralExpression,
            // which solves the identical transitive-capture problem for ordinary
            // (non-go) nested-lambda captures.
            if node is BoundFunctionLiteralExpression literal {
                for nestedCapture in literal.CapturedVariables {
                    this.CaptureIfFree(nestedCapture)
                }
                return
            }
            base.VisitExpression(node)
        }

        protected override func VisitAssignmentExpression(node BoundAssignmentExpression) {
            this.CaptureIfFree(node.Variable)
            base.VisitAssignmentExpression(node)
        }

        protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
            if node.Initializer != nil {
                this.VisitExpression(node.Initializer)
            }
            this.declared.Add(node.Variable)
        }

        private func CaptureIfFree(variable VariableSymbol) {
            if !this.declared.Contains(variable) && this.seen.Add(variable) {
                this.captured.Add(variable)
            }
        }
    }

    /// Collects the free (non-locally-declared) variables referenced by [`expression`](paramref).
    /// @param expression The (shaped) goroutine expression, as bound for a `go` statement.
    /// @returns The captured-variable set, in first-reference order.
    func CollectCapturedVariables(expression BoundExpression) ImmutableArray[VariableSymbol] {
        let seen = HashSet[VariableSymbol]()
        let captured = ImmutableArray.CreateBuilder[VariableSymbol]()
        let declared = HashSet[VariableSymbol]()
        let collector = GoCapturedVariableCollector.Walker(seen, declared, captured)
        collector.VisitExpression(expression)
        return captured.ToImmutable()
    }
}
