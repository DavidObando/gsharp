// <copyright file="RefStructAsyncLivenessAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #2350: replaces the coarse, syntax-only rejection of a by-ref-like
/// (<c>ref struct</c>) local declared anywhere in an async function (the
/// original issue #367 rule in <see cref="StatementBinder"/>) with a sound
/// per-local dataflow analysis. A by-ref-like local is legal in an async
/// function as long as it is never <em>live</em> across an <c>await</c>
/// suspension point: <see cref="Lowering.Async.AsyncCaptureWalker"/> never
/// hoists a by-ref-like local into the generated state machine's fields (the
/// CLR forbids a by-ref-like field), so such a local is reset to its CLR
/// default on every fresh <c>MoveNext</c> call. A value that survives a
/// suspension therefore silently loses its contents unless it can never
/// actually be observed live across one — which is exactly what this
/// analyzer proves before allowing the declaration.
/// <para>
/// This is a backward ("may be live") dataflow, dual to the forward "must be
/// assigned" analysis in <see cref="RefKindDefiniteAssignmentAnalyzer"/>,
/// over the same <see cref="ControlFlowGraph"/> infrastructure: loops are
/// fully expanded into real graph edges (so a per-iteration local's liveness
/// is checked correctly across back-edges), while <c>try</c>, <c>select</c>,
/// <c>scope</c>, <c>fixed</c>, and pattern-<c>switch</c> bodies are opaque to
/// the outer graph and are recursively re-analyzed here, mirroring
/// <see cref="RefKindDefiniteAssignmentAnalyzer"/>'s
/// <c>ProcessTryStatement</c>/<c>ProcessSelectStatement</c>/etc. shape.
/// </para>
/// <para>
/// <c>try</c>/<c>finally</c> gets special "ambient live" treatment: an
/// exception can transfer control from <em>any</em> point inside a
/// <c>try</c> body straight to its <c>catch</c> clauses or <c>finally</c>
/// block, so whatever is live entering those handlers is folded into an
/// ambient live set applied to every block of the try body — not just its
/// formal exit — catching the "unsafe finally interaction" case where a
/// local assigned before an <c>await</c> in the <c>try</c> body is later
/// read in <c>finally</c>.
/// </para>
/// Capture (a closure capturing a by-ref-like variable) and general escape
/// (returning/storing a by-ref-like value beyond its safe scope) are already
/// covered by pre-existing, unrelated machinery
/// (<see cref="LambdaBinder"/>'s unconditional by-ref-like capture rejection
/// and <see cref="StatementBinder"/>'s ADR-0058 escape-scope tracking) and
/// are untouched by this analyzer.
/// </summary>
internal static class RefStructAsyncLivenessAnalyzer
{
    /// <summary>
    /// Entry point, intended to be called once per bound-and-lowered function
    /// body (mirroring every call site of
    /// <see cref="RefKindDefiniteAssignmentAnalyzer.Analyze"/>). Runs the
    /// liveness analysis over <paramref name="enclosing"/>'s own body (if it
    /// is async) and, regardless, walks the body looking for nested async
    /// function-literal expressions (lambdas and local functions) so each one
    /// gets its own, independently-scoped liveness analysis rooted at its own
    /// body — a function literal is an opaque leaf to the general bound-tree
    /// walker (it is a separate lexical/hoisting scope), so it must be found
    /// and recursed into manually here.
    /// </summary>
    /// <param name="body">The bound-and-lowered body of <paramref name="enclosing"/>.</param>
    /// <param name="enclosing">The function/method/accessor whose body is being checked.</param>
    /// <param name="diagnostics">The diagnostic bag to report GS0219 violations to.</param>
    public static void Analyze(BoundBlockStatement body, FunctionSymbol enclosing, DiagnosticBag diagnostics)
    {
        if (body == null || enclosing == null || diagnostics == null)
        {
            return;
        }

        if (enclosing.IsAsync)
        {
            AnalyzeScope(body, diagnostics);
        }

        var finder = new AsyncLambdaScopeFinder(diagnostics);
        finder.VisitStatement(body);
    }

    /// <summary>
    /// Runs the full liveness analysis for one async scope (a top-level
    /// function/method/accessor body, or an async lambda/local-function
    /// literal's body). Locals declared by a nested (non-async) lambda are
    /// excluded automatically, since <see cref="ByRefLikeLocalCollector"/>
    /// does not recurse into function-literal bodies.
    /// </summary>
    private static void AnalyzeScope(BoundBlockStatement body, DiagnosticBag diagnostics)
    {
        var collector = new ByRefLikeLocalCollector();
        collector.VisitStatement(body);

        if (collector.Locals.Count == 0)
        {
            // No by-ref-like locals declared directly in this async scope —
            // nothing to check (whether or not it contains nested async
            // lambdas is handled separately by the caller).
            return;
        }

        AnalyzeRegion(body, liveOutOfRegion: new HashSet<VariableSymbol>(), ambientLive: new HashSet<VariableSymbol>(), collector.Locals, diagnostics);
    }

    /// <summary>
    /// Runs the backward "may be live" fixpoint over the CFG of
    /// <paramref name="regionBody"/> (wrapping it in a synthetic block first
    /// if it isn't already one). <paramref name="liveOutOfRegion"/> seeds
    /// what's live immediately after the whole region (from the enclosing
    /// context); <paramref name="ambientLive"/> is unioned into the live-out
    /// of every block in the region (used to model "an exception can jump
    /// straight to a catch/finally from anywhere in this try body").
    /// Returns what's live entering the region (i.e. live-out of its start),
    /// for the caller to keep propagating backward past the compound
    /// statement.
    /// </summary>
    private static HashSet<VariableSymbol> AnalyzeRegion(
        BoundStatement regionBody,
        HashSet<VariableSymbol> liveOutOfRegion,
        HashSet<VariableSymbol> ambientLive,
        HashSet<VariableSymbol> interesting,
        DiagnosticBag diagnostics)
    {
        var graph = ControlFlowGraph.Create(AsBlock(regionBody));

        var liveIn = new Dictionary<ControlFlowGraph.BasicBlock, HashSet<VariableSymbol>>();
        foreach (var b in graph.Blocks)
        {
            liveIn[b] = new HashSet<VariableSymbol>();
        }

        HashSet<VariableSymbol> ComputeLiveOut(ControlFlowGraph.BasicBlock block)
        {
            var result = new HashSet<VariableSymbol>(ambientLive);
            foreach (var branch in block.Outgoing)
            {
                result.UnionWith(branch.To.IsEnd ? liveOutOfRegion : liveIn[branch.To]);
            }

            return result;
        }

        var changed = true;
        var safety = 0;
        while (changed && safety++ < 10000)
        {
            changed = false;

            // Iterate in reverse block-list order: for a backward analysis,
            // later blocks (closer to the region's exit) typically converge
            // first, so visiting them first each pass reaches the fixpoint in
            // fewer iterations. Correctness does not depend on this order.
            for (var i = graph.Blocks.Count - 1; i >= 0; i--)
            {
                var block = graph.Blocks[i];
                if (block.IsStart || block.IsEnd)
                {
                    continue;
                }

                var liveOut = ComputeLiveOut(block);
                var newLiveIn = SimulateBlockBackward(block, liveOut, interesting, diagnostics: null);
                if (!SetsEqual(newLiveIn, liveIn[block]))
                {
                    liveIn[block] = newLiveIn;
                    changed = true;
                }
            }
        }

        // Final reporting pass: sets are now stable, so every violation is
        // detected exactly once, using fully-converged data.
        if (diagnostics != null)
        {
            for (var i = graph.Blocks.Count - 1; i >= 0; i--)
            {
                var block = graph.Blocks[i];
                if (block.IsStart || block.IsEnd)
                {
                    continue;
                }

                var liveOut = ComputeLiveOut(block);
                SimulateBlockBackward(block, liveOut, interesting, diagnostics);
            }
        }

        return ComputeLiveOut(graph.Start);
    }

    private static BoundBlockStatement AsBlock(BoundStatement statement)
    {
        if (statement is BoundBlockStatement block)
        {
            return block;
        }

        var statements = statement == null
            ? ImmutableArray<BoundStatement>.Empty
            : ImmutableArray.Create(statement);
        return new BoundBlockStatement(statement?.Syntax, statements);
    }

    private static bool SetsEqual(HashSet<VariableSymbol> a, HashSet<VariableSymbol> b)
    {
        if (a.Count != b.Count)
        {
            return false;
        }

        foreach (var v in a)
        {
            if (!b.Contains(v))
            {
                return false;
            }
        }

        return true;
    }

    private static HashSet<VariableSymbol> SimulateBlockBackward(
        ControlFlowGraph.BasicBlock block,
        HashSet<VariableSymbol> liveOut,
        HashSet<VariableSymbol> interesting,
        DiagnosticBag diagnostics)
    {
        var live = new HashSet<VariableSymbol>(liveOut);
        for (var i = block.Statements.Count - 1; i >= 0; i--)
        {
            ProcessStatementBackward(block.Statements[i], live, interesting, diagnostics);
        }

        return live;
    }

    private static void ProcessStatementBackward(
        BoundStatement statement,
        HashSet<VariableSymbol> live,
        HashSet<VariableSymbol> interesting,
        DiagnosticBag diagnostics)
    {
        switch (statement)
        {
            case BoundExpressionStatement es:
                ApplyExpression(es.Expression, live, interesting, diagnostics, statement);
                break;
            case BoundVariableDeclaration vd:
            {
                var collector = new ReadAndAwaitCollector(interesting);
                collector.VisitExpression(vd.Initializer);

                var isInteresting = vd.Variable is LocalVariableSymbol && interesting.Contains(vd.Variable);
                var selfRead = isInteresting && collector.Reads.Contains(vd.Variable);
                var killTarget = isInteresting && !selfRead ? vd.Variable : null;

                if (collector.ContainsAwait)
                {
                    ReportIfUnsafe(live, killTarget, diagnostics, statement);
                }

                if (killTarget != null)
                {
                    live.Remove(killTarget);
                }

                live.UnionWith(collector.Reads);
                break;
            }

            case BoundReturnStatement rs:
                if (rs.Expression != null)
                {
                    ApplyExpression(rs.Expression, live, interesting, diagnostics, statement);
                }

                break;
            case BoundThrowStatement th:
                ApplyExpression(th.Expression, live, interesting, diagnostics, statement);
                break;
            case BoundConditionalGotoStatement cgs:
                ApplyExpression(cgs.Condition, live, interesting, diagnostics, statement);
                break;
            case BoundLabelStatement:
            case BoundGotoStatement:
                break;

            // Issue #1642 (also relied upon by RefKindDefiniteAssignmentAnalyzer):
            // these compound statements are opaque to the outer ControlFlowGraph
            // (a single fall-through statement — see
            // ControlFlowGraph.BasicBlockBuilder), so their nested bodies must be
            // recursively analyzed here.
            case BoundTryStatement tryStmt:
                ProcessTryBackward(tryStmt, live, interesting, diagnostics);
                break;
            case BoundSelectStatement selectStmt:
                ProcessSelectBackward(selectStmt, live, interesting, diagnostics);
                break;
            case BoundScopeStatement scopeStmt:
            {
                var entry = AnalyzeRegion(scopeStmt.Body, live, new HashSet<VariableSymbol>(), interesting, diagnostics);
                live.Clear();
                live.UnionWith(entry);
                break;
            }

            case BoundFixedStatement fixedStmt:
                ProcessFixedBackward(fixedStmt, live, interesting, diagnostics);
                break;
            case BoundPatternSwitchStatement switchStmt:
                ProcessSwitchBackward(switchStmt, live, interesting, diagnostics);
                break;
            default:
                // Other opaque statement kinds (go/channel-send/await-for-range/
                // yield) either don't run unconditionally (a loop body may run
                // zero times, handled at the CFG level for real loops) or are
                // not reachable here post-lowering (await-for-range is lowered
                // away before this analysis runs) — no-op is correct/safe: it
                // never removes a variable from `live`, so it can only ever be
                // conservative, never unsound.
                break;
        }
    }

    /// <summary>
    /// try/catch/finally: an exception can transfer control from any point in
    /// the try body straight into a catch clause or (if uncaught, or on
    /// normal/exceptional catch completion) into finally. Modeled as an
    /// "ambient live" set — the union of what's live entering every catch
    /// clause and the finally block — that is folded into the live-out of
    /// every block inside the try body (not just its formal exit), so a
    /// local that's read in `finally` (or a catch) shows up as live at an
    /// earlier `await` inside `try`, even though normal control flow alone
    /// would never reach that read from there.
    /// </summary>
    private static void ProcessTryBackward(
        BoundTryStatement tryStmt,
        HashSet<VariableSymbol> live,
        HashSet<VariableSymbol> interesting,
        DiagnosticBag diagnostics)
    {
        var afterTry = new HashSet<VariableSymbol>(live);

        var exceptionalEscapeLive = new HashSet<VariableSymbol>();

        HashSet<VariableSymbol> finallyLiveIn = null;
        if (tryStmt.FinallyBlock != null)
        {
            finallyLiveIn = AnalyzeRegion(tryStmt.FinallyBlock, afterTry, new HashSet<VariableSymbol>(), interesting, diagnostics);
            exceptionalEscapeLive.UnionWith(finallyLiveIn);
        }

        // Normal completion of the try body (or a catch clause) falls into
        // finally (if any); otherwise it falls to whatever's after the whole
        // try statement.
        var normalFallthrough = finallyLiveIn ?? afterTry;

        foreach (var clause in tryStmt.CatchClauses)
        {
            var catchLiveIn = AnalyzeRegion(clause.Body, normalFallthrough, new HashSet<VariableSymbol>(), interesting, diagnostics);
            if (clause.Variable != null)
            {
                catchLiveIn.Remove(clause.Variable);
            }

            exceptionalEscapeLive.UnionWith(catchLiveIn);
        }

        // The try body's own normal exit also falls into finally (or after
        // the statement); the ambient set additionally lets an exception
        // reach a catch/finally from any interior point.
        var tryLiveIn = AnalyzeRegion(tryStmt.TryBlock, normalFallthrough, exceptionalEscapeLive, interesting, diagnostics);

        live.Clear();
        live.UnionWith(tryLiveIn);
    }

    /// <summary>
    /// <c>select</c> always blocks until exactly one arm's body runs; each
    /// arm's channel/value expression is evaluated to decide readiness, so a
    /// variable read there is live immediately before the whole statement.
    /// </summary>
    private static void ProcessSelectBackward(
        BoundSelectStatement selectStmt,
        HashSet<VariableSymbol> live,
        HashSet<VariableSymbol> interesting,
        DiagnosticBag diagnostics)
    {
        var afterSelect = new HashSet<VariableSymbol>(live);
        var union = new HashSet<VariableSymbol>();

        foreach (var c in selectStmt.Cases)
        {
            var caseLiveIn = AnalyzeRegion(c.Body, afterSelect, new HashSet<VariableSymbol>(), interesting, diagnostics);
            if (c.Variable != null)
            {
                caseLiveIn.Remove(c.Variable);
            }

            union.UnionWith(caseLiveIn);

            if (c.Channel != null)
            {
                ApplyExpression(c.Channel, union, interesting, diagnostics, null);
            }

            if (c.Value != null)
            {
                ApplyExpression(c.Value, union, interesting, diagnostics, null);
            }
        }

        live.Clear();
        live.UnionWith(union);
    }

    /// <summary>The <c>fixed</c> body always runs unconditionally (no
    /// branching), and its synthetic pinned/pointer/source locals do not
    /// exist before it, so they're excluded from what flows backward past
    /// the statement.</summary>
    private static void ProcessFixedBackward(
        BoundFixedStatement fixedStmt,
        HashSet<VariableSymbol> live,
        HashSet<VariableSymbol> interesting,
        DiagnosticBag diagnostics)
    {
        var bodyLiveIn = AnalyzeRegion(fixedStmt.Body, live, new HashSet<VariableSymbol>(), interesting, diagnostics);
        bodyLiveIn.Remove(fixedStmt.PinnedVariable);
        bodyLiveIn.Remove(fixedStmt.PointerVariable);
        if (fixedStmt.SourceVariable != null)
        {
            bodyLiveIn.Remove(fixedStmt.SourceVariable);
        }

        live.Clear();
        live.UnionWith(bodyLiveIn);
        ApplyExpression(fixedStmt.PinnedSource, live, interesting, diagnostics, null);
    }

    /// <summary>
    /// A pattern switch, unlike <c>select</c>, can complete having matched no
    /// arm when there's no exhaustive <c>default</c> — that "nothing matched"
    /// path must also contribute to what's live before the statement (it
    /// falls straight through to whatever's live after it).
    /// </summary>
    private static void ProcessSwitchBackward(
        BoundPatternSwitchStatement switchStmt,
        HashSet<VariableSymbol> live,
        HashSet<VariableSymbol> interesting,
        DiagnosticBag diagnostics)
    {
        var afterSwitch = new HashSet<VariableSymbol>(live);
        var union = new HashSet<VariableSymbol>();
        var hasDefault = false;

        foreach (var arm in switchStmt.Arms)
        {
            if (arm.IsDefault)
            {
                hasDefault = true;
            }

            var armLiveIn = AnalyzeRegion(arm.Body, afterSwitch, new HashSet<VariableSymbol>(), interesting, diagnostics);
            if (arm.Guard != null)
            {
                ApplyExpression(arm.Guard, armLiveIn, interesting, diagnostics, null);
            }

            union.UnionWith(armLiveIn);
        }

        if (!hasDefault)
        {
            union.UnionWith(afterSwitch);
        }

        live.Clear();
        live.UnionWith(union);
        ApplyExpression(switchStmt.Discriminant, live, interesting, diagnostics, null);
    }

    /// <summary>
    /// Applies one expression's backward transfer to <paramref name="live"/>:
    /// if the expression is a top-level assignment to an interesting local
    /// that is not also read within its own right-hand side (see the
    /// self-referential-redefinition note below), that local is a "kill" —
    /// its pre-statement liveness does not depend on what's live after.
    /// Otherwise every interesting local read anywhere in the expression is
    /// added to `live`. If the expression contains an `await`, any
    /// currently-live interesting local (other than a pure kill target of
    /// this same expression) is reported as unsafe.
    /// </summary>
    private static void ApplyExpression(
        BoundExpression expression,
        HashSet<VariableSymbol> live,
        HashSet<VariableSymbol> interesting,
        DiagnosticBag diagnostics,
        BoundStatement owningStatement)
    {
        if (expression == null)
        {
            return;
        }

        var collector = new ReadAndAwaitCollector(interesting);
        collector.VisitExpression(expression);

        VariableSymbol killTarget = null;
        if (expression is BoundAssignmentExpression assign
            && interesting.Contains(assign.Variable)
            && !collector.Reads.Contains(assign.Variable))
        {
            // Self-referential redefinition (e.g. `span = span.Slice(await
            // X())`) must NOT be treated as a kill: the pre-statement value
            // of `span` is read by the statement's own right-hand side, so it
            // must survive any `await` nested in that same right-hand side
            // regardless of the read's apparent position relative to the
            // `await` — evaluation order does not change which value is
            // live entering the statement.
            killTarget = assign.Variable;
        }

        if (collector.ContainsAwait)
        {
            ReportIfUnsafe(live, killTarget, diagnostics, owningStatement);
        }

        if (killTarget != null)
        {
            live.Remove(killTarget);
        }

        live.UnionWith(collector.Reads);
    }

    private static void ReportIfUnsafe(
        HashSet<VariableSymbol> live,
        VariableSymbol excludedSelfKill,
        DiagnosticBag diagnostics,
        BoundStatement owningStatement)
    {
        if (diagnostics == null)
        {
            return;
        }

        foreach (var v in live)
        {
            if (ReferenceEquals(v, excludedSelfKill))
            {
                continue;
            }

            var location = v.DeclaringSyntax?.Location ?? owningStatement?.Syntax?.Location ?? default(TextLocation);
            diagnostics.ReportByRefLikeEscape(
                location,
                v.Type,
                $"be declared as a local in an async function and remain live across an 'await' suspension point (variable '{v.Name}'); restructure the code so its value is no longer needed after the 'await'");
        }
    }

    /// <summary>
    /// Collects every by-ref-like local declared directly within a scope
    /// (does not recurse into nested function-literal bodies, since those are
    /// a separate lexical/hoisting scope with their own, independently
    /// analyzed liveness — see <see cref="AsyncLambdaScopeFinder"/>).
    /// </summary>
    private sealed class ByRefLikeLocalCollector : BoundTreeWalker
    {
        public HashSet<VariableSymbol> Locals { get; } = new HashSet<VariableSymbol>();

        protected override void VisitVariableDeclaration(BoundVariableDeclaration node)
        {
            if (node.Variable is LocalVariableSymbol local && TypeSymbol.IsByRefLike(local.Type))
            {
                Locals.Add(local);
            }

            base.VisitVariableDeclaration(node);
        }
    }

    /// <summary>
    /// Collects reads (restricted to a fixed "interesting" set of variables)
    /// and whether an `await` occurs anywhere within one expression subtree.
    /// Relies on <see cref="BoundTreeWalker"/>'s default recursion for
    /// everything except assignment targets (correctly not a read) and
    /// function-literal bodies (a separate scope, opaque by design).
    /// </summary>
    private sealed class ReadAndAwaitCollector : BoundTreeWalker
    {
        private readonly HashSet<VariableSymbol> interesting;

        public ReadAndAwaitCollector(HashSet<VariableSymbol> interesting)
        {
            this.interesting = interesting;
        }

        public HashSet<VariableSymbol> Reads { get; } = new HashSet<VariableSymbol>();

        public bool ContainsAwait { get; private set; }

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundVariableExpression variableExpression && interesting.Contains(variableExpression.Variable))
            {
                Reads.Add(variableExpression.Variable);
            }

            base.VisitExpression(node);
        }

        protected override void VisitAwaitExpression(BoundAwaitExpression node)
        {
            ContainsAwait = true;
            base.VisitAwaitExpression(node);
        }
    }

    /// <summary>
    /// Finds every async function-literal expression (lambda or local
    /// function) nested anywhere in a bound tree — regardless of whether the
    /// enclosing scope itself is async — and runs an independent
    /// <see cref="AnalyzeScope"/> for each one's own body. A function literal
    /// is an opaque leaf to the base <see cref="BoundTreeWalker"/> (its body
    /// is a separate lexical scope), so this walker must manually continue
    /// into <see cref="BoundFunctionLiteralExpression.Body"/> to discover
    /// further-nested async lambdas/local functions.
    /// </summary>
    private sealed class AsyncLambdaScopeFinder : BoundTreeWalker
    {
        private readonly DiagnosticBag diagnostics;

        public AsyncLambdaScopeFinder(DiagnosticBag diagnostics)
        {
            this.diagnostics = diagnostics;
        }

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundFunctionLiteralExpression literal)
            {
                // Issue #2350: a function-literal body is bound but not
                // lowered until emit time (see
                // ReflectionMetadataEmitter/ClosureEmitter, which each call
                // Lowerer.Lower(literal.Body) independently right before
                // emitting it) — general control-flow sugar (if/while/`await
                // for`, etc.) is still in its raw, un-lowered shape here.
                // Mirror that emit-time pass with a local, throwaway lowering
                // so ControlFlowGraph sees the same goto/label shape the
                // emitter eventually will; this does not replace the node's
                // real Body anywhere.
                var loweredLambdaBody = (BoundBlockStatement)Lowerer.Lower(literal.Body);

                if (literal.Function != null && literal.Function.IsAsync)
                {
                    AnalyzeScope(loweredLambdaBody, diagnostics);
                }

                VisitStatement(loweredLambdaBody);
                return;
            }

            base.VisitExpression(node);
        }
    }
}
