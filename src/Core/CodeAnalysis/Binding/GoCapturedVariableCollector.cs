// <copyright file="GoCapturedVariableCollector.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Computes the capture set of a <c>go</c> statement's (shaped) goroutine
/// expression — the same walk <c>Emit.SlotPlanner.CollectCapturedVariables</c>
/// used at emit time to size the synthesized display class, moved here (and
/// made the single implementation, with <c>SlotPlanner</c> now delegating to
/// it) so it can also run at BIND time.
/// </summary>
/// <remarks>
/// Copilot review of PR #4273 / issue #4271: unlike <see cref="LambdaBinder"/>'s
/// function-literal capture checks, the <c>go</c>-statement closure path never
/// ran any capture-legality validation at all — its capture set was computed
/// for the first time at emit, long after diagnostics are collected, so a
/// captured <c>ref</c>/<c>var ref</c> LOCAL alias (GS9011) or a captured
/// <c>ref</c>/<c>out</c>/<c>in</c> PARAMETER (GS9010) silently fell back to a
/// by-value snapshot instead of being rejected. Sharing this single collector
/// between bind time (<c>StatementBinder.BindGoStatement</c>, which now feeds
/// its result to <see cref="ClosureCaptureLegalityChecker"/>) and emit time
/// guarantees the checked set and the actually-captured set can never drift
/// apart.
/// </remarks>
internal static class GoCapturedVariableCollector
{
    /// <summary>Collects the free (non-locally-declared) variables referenced by <paramref name="expression"/>.</summary>
    /// <param name="expression">The (shaped) goroutine expression, as bound for a <c>go</c> statement.</param>
    /// <returns>The captured-variable set, in first-reference order.</returns>
    public static ImmutableArray<VariableSymbol> CollectCapturedVariables(BoundExpression expression)
    {
        var seen = new HashSet<VariableSymbol>();
        var captured = ImmutableArray.CreateBuilder<VariableSymbol>();
        var declared = new HashSet<VariableSymbol>();
        var collector = new Walker(seen, declared, captured);
        collector.VisitExpression(expression);
        return captured.ToImmutable();
    }

    private sealed class Walker : BoundTreeWalker
    {
        private readonly HashSet<VariableSymbol> seen;
        private readonly HashSet<VariableSymbol> declared;
        private readonly ImmutableArray<VariableSymbol>.Builder captured;

        public Walker(
            HashSet<VariableSymbol> seen,
            HashSet<VariableSymbol> declared,
            ImmutableArray<VariableSymbol>.Builder captured)
        {
            this.seen = seen;
            this.declared = declared;
            this.captured = captured;
        }

        public override void VisitExpression(BoundExpression? node)
        {
            if (node == null)
            {
                return;
            }

            if (node is BoundVariableExpression ve)
            {
                this.CaptureIfFree(ve.Variable);
                return;
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
            if (node is BoundFunctionLiteralExpression literal)
            {
                foreach (var nestedCapture in literal.CapturedVariables)
                {
                    this.CaptureIfFree(nestedCapture);
                }

                return;
            }

            base.VisitExpression(node);
        }

        protected override void VisitAssignmentExpression(BoundAssignmentExpression node)
        {
            this.CaptureIfFree(node.Variable);
            base.VisitAssignmentExpression(node);
        }

        protected override void VisitVariableDeclaration(BoundVariableDeclaration node)
        {
            if (node.Initializer != null)
            {
                this.VisitExpression(node.Initializer);
            }

            this.declared.Add(node.Variable);
        }

        private void CaptureIfFree(VariableSymbol variable)
        {
            if (!this.declared.Contains(variable)
                && this.seen.Add(variable))
            {
                this.captured.Add(variable);
            }
        }
    }
}
