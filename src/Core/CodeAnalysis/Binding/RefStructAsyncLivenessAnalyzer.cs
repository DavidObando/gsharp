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
/// assigned" analysis in <see cref="DefiniteAssignmentAnalyzer"/>,
/// over the same <see cref="ControlFlowGraph"/> infrastructure: loops are
/// fully expanded into real graph edges (so a per-iteration local's liveness
/// is checked correctly across back-edges), while <c>try</c>, <c>select</c>,
/// <c>scope</c>, <c>fixed</c>, and pattern-<c>switch</c> bodies are opaque to
/// the outer graph and are recursively re-analyzed here, mirroring
/// <see cref="DefiniteAssignmentAnalyzer"/>'s
/// <c>ProcessTryStatement</c>/<c>ProcessFixedStatement</c>/etc. shape.
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
/// <para>
/// Issue #4222 reuses this same machinery for native <c>let ref</c>/<c>var
/// ref</c> alias locals (<see cref="LocalVariableSymbol.RefKind"/> other than
/// <see cref="RefKind.None"/>, tracked separately from by-ref-like locals
/// since the two have different symbol shapes — see
/// <see cref="IsNativeRefAlias"/>) and extends the suspension concept from
/// "await" to "await or yield", so it now also runs for (non-async) iterator
/// functions. Two differences from the by-ref-like treatment: an alias is
/// "interesting" regardless of function kind (an alias in a plain iterator is
/// in scope for #4222; a by-ref-like local in a plain iterator remains the
/// pre-existing blanket rejection in <see cref="StatementBinder"/>, untouched
/// here — see <see cref="InterestingLocalCollector"/>), and an assignment
/// *through* an alias (<c>alias = 42</c>) is a use of the alias, not a kill
/// of it, unlike overwriting a by-ref-like value local outright.
/// </para>
/// </summary>
internal static class RefStructAsyncLivenessAnalyzer
{
    /// <summary>
    /// Entry point, intended to be called once per bound-and-lowered function
    /// body (mirroring every call site of
    /// <see cref="DefiniteAssignmentAnalyzer.Analyze"/>). Runs the
    /// liveness analysis over <paramref name="enclosing"/>'s own body (if it
    /// is async and/or an iterator) and, regardless, walks the body looking
    /// for nested async/iterator function-literal expressions (lambdas and
    /// local functions) so each one gets its own, independently-scoped
    /// liveness analysis rooted at its own body — a function literal is an
    /// opaque leaf to the general bound-tree walker (it is a separate
    /// lexical/hoisting scope), so it must be found and recursed into
    /// manually here.
    /// </summary>
    /// <param name="body">The bound-and-lowered body of <paramref name="enclosing"/>.</param>
    /// <param name="enclosing">The function/method/accessor whose body is being checked.</param>
    /// <param name="diagnostics">The diagnostic bag to report GS0219/GS0258 violations to.</param>
    public static void Analyze(BoundBlockStatement body, FunctionSymbol enclosing, DiagnosticBag diagnostics)
    {
        if (body == null || enclosing == null || diagnostics == null)
        {
            return;
        }

        if (enclosing.IsAsyncOrSuspending || Binder.IsIteratorReturnType(enclosing.Type))
        {
            // By-ref-like locals stay async-only (issue #2350's own scope; a
            // plain iterator still blanket-rejects them elsewhere) — only
            // native ref-alias locals (#4222) are interesting in an iterator
            // that isn't also async.
            AnalyzeScope(body, diagnostics, collectByRefLikeLocals: enclosing.IsAsyncOrSuspending);
        }

        var finder = new AsyncLambdaScopeFinder(diagnostics);
        finder.VisitStatement(body);
    }

    /// <summary>
    /// Runs the full liveness analysis for one async/iterator scope (a
    /// top-level function/method/accessor body, or an async/iterator
    /// lambda/local-function literal's body). Locals declared by a nested
    /// (non-async, non-iterator) lambda are excluded automatically, since
    /// <see cref="InterestingLocalCollector"/> does not recurse into
    /// function-literal bodies.
    /// </summary>
    private static void AnalyzeScope(BoundBlockStatement body, DiagnosticBag diagnostics, bool collectByRefLikeLocals)
    {
        var collector = new InterestingLocalCollector(collectByRefLikeLocals);
        collector.VisitStatement(body);

        if (collector.Locals.Count == 0)
        {
            // Nothing interesting declared directly in this scope — nothing
            // to check (whether or not it contains nested async/iterator
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
        DiagnosticBag? diagnostics)
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
        DiagnosticBag? diagnostics)
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
        DiagnosticBag? diagnostics)
    {
        switch (statement)
        {
            case BoundExpressionStatement es:
                ApplyExpression(es.Expression, live, interesting, diagnostics, statement);
                break;
            case BoundVariableDeclaration vd:
            {
                var collector = new ReadAndAwaitCollector(interesting);
                if (vd.Initializer is { } initializer)
                {
                    collector.VisitExpression(initializer);
                }

                var isInteresting = vd.Variable is LocalVariableSymbol && interesting.Contains(vd.Variable);
                var selfRead = isInteresting && collector.Reads.Contains(vd.Variable);
                var killTarget = isInteresting && !selfRead ? vd.Variable : null;

                if (collector.ContainsAwait)
                {
                    ReportIfUnsafe(live, killTarget, diagnostics, statement, "await");
                }

                if (killTarget != null)
                {
                    live.Remove(killTarget);
                }

                live.UnionWith(collector.Reads);
                break;
            }

            // Issue #4222: `yield` is itself an unconditional suspension
            // point, distinct from any `await` that might occur while
            // evaluating the yielded expression (an async iterator's `yield
            // return await X()` suspends twice, sequentially: the await
            // first, then the yield). Report using the live-out set — what
            // must survive the yield to be used afterward — before folding
            // in this statement's own reads, mirroring ApplyExpression's
            // ordering for `await`; then process the yielded expression
            // itself (which still needs its own await check, handled by
            // ApplyExpression, if it contains one).
            case BoundYieldStatement ys:
                ReportIfUnsafe(live, excludedSelfKill: null, diagnostics, statement, "yield");
                ApplyExpression(ys.Expression, live, interesting, diagnostics, statement);
                break;

            case BoundReturnStatement rs:
                if (rs.Expression != null)
                {
                    ApplyExpression(rs.Expression, live, interesting, diagnostics, statement);
                }

                break;
            case BoundThrowStatement th:
                ApplyExpression(th.Expression, live, interesting, diagnostics, statement);
                break;
            case BoundRethrowStatement:
                // ADR-0176: no operand, so no ref-struct value is read.
                break;
            case BoundConditionalGotoStatement cgs:
                ApplyExpression(cgs.Condition, live, interesting, diagnostics, statement);
                break;
            case BoundLabelStatement:
            case BoundGotoStatement:
                break;

            // Issue #1642 (also relied upon by DefiniteAssignmentAnalyzer):
            // these compound statements are opaque to the outer ControlFlowGraph
            // (a single fall-through statement — see
            // ControlFlowGraph.BasicBlockBuilder), so their nested bodies must be
            // recursively analyzed here.
            case BoundTryStatement tryStmt:
                ProcessTryBackward(tryStmt, live, interesting, diagnostics);
                break;
            case BoundFixedStatement fixedStmt:
                ProcessFixedBackward(fixedStmt, live, interesting, diagnostics);
                break;
            case BoundPatternSwitchStatement switchStmt:
                ProcessSwitchBackward(switchStmt, live, interesting, diagnostics);
                break;
            default:
                // Other opaque statement kinds (go/channel-send/await-for-range)
                // either don't run unconditionally (a loop body may run
                // zero times, handled at the CFG level for real loops) or are
                // not reachable here post-lowering (await-for-range is lowered
                // away before this analysis runs) — no-op is correct/safe: it
                // never removes a variable from `live`, so it can only ever be
                // conservative, never unsound. `yield` has its own case above.
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
        DiagnosticBag? diagnostics)
    {
        var afterTry = new HashSet<VariableSymbol>(live);

        var exceptionalEscapeLive = new HashSet<VariableSymbol>();

        HashSet<VariableSymbol>? finallyLiveIn = null;
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

    /// <summary>The <c>fixed</c> body always runs unconditionally (no
    /// branching), and its synthetic pinned/pointer/source locals do not
    /// exist before it, so they're excluded from what flows backward past
    /// the statement.</summary>
    private static void ProcessFixedBackward(
        BoundFixedStatement fixedStmt,
        HashSet<VariableSymbol> live,
        HashSet<VariableSymbol> interesting,
        DiagnosticBag? diagnostics)
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
        DiagnosticBag? diagnostics)
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
    /// if the expression is a top-level assignment to an interesting
    /// by-ref-like local that is not also read within its own right-hand
    /// side (see the self-referential-redefinition note below), that local
    /// is a "kill" — its pre-statement liveness does not depend on what's
    /// live after. An assignment *through* a native ref-alias local
    /// (<c>alias = 42</c>) is never a kill — issue #4222: it writes to the
    /// pointee via the alias's stored address, which requires the alias
    /// itself to be live at that point (there is no syntax to re-seat an
    /// alias to a new address, so every assignment is a use). Otherwise
    /// every interesting local read anywhere in the expression is added to
    /// `live`. If the expression contains an `await`, any currently-live
    /// interesting local (other than a pure kill target of this same
    /// expression) is reported as unsafe.
    /// </summary>
    private static void ApplyExpression(
        BoundExpression? expression,
        HashSet<VariableSymbol> live,
        HashSet<VariableSymbol> interesting,
        DiagnosticBag? diagnostics,
        BoundStatement? owningStatement)
    {
        if (expression == null)
        {
            return;
        }

        var collector = new ReadAndAwaitCollector(interesting);
        collector.VisitExpression(expression);

        VariableSymbol? killTarget = null;
        if (expression is BoundAssignmentExpression assign && interesting.Contains(assign.Variable))
        {
            if (IsNativeRefAlias(assign.Variable))
            {
                live.Add(assign.Variable);
            }
            else if (!collector.Reads.Contains(assign.Variable))
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
        }

        if (collector.ContainsAwait)
        {
            ReportIfUnsafe(live, killTarget, diagnostics, owningStatement, "await");
        }

        if (killTarget != null)
        {
            live.Remove(killTarget);
        }

        live.UnionWith(collector.Reads);
    }

    /// <summary>Issue #4222: true for a native <c>let ref</c>/<c>var ref</c> alias local
    /// (tracked via <see cref="LocalVariableSymbol.RefKind"/>, since its <c>Type</c> stays
    /// the pointee type — see <see cref="StatementBinder.BindRefAliasLocalDeclaration"/>),
    /// as opposed to a by-ref-like (<c>ref struct</c>) value local.</summary>
    private static bool IsNativeRefAlias(VariableSymbol variable) =>
        variable is LocalVariableSymbol local && local.RefKind != RefKind.None;

    private static void ReportIfUnsafe(
        HashSet<VariableSymbol> live,
        VariableSymbol? excludedSelfKill,
        DiagnosticBag? diagnostics,
        BoundStatement? owningStatement,
        string suspensionKeyword)
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
            var suspensionContext = suspensionKeyword == "yield" ? "an iterator" : "an async function";
            var article = suspensionKeyword == "yield" ? "a" : "an";
            if (IsNativeRefAlias(v))
            {
                // Issue #4222: GS0258 (not GS0219 — this is an alias local,
                // not a by-ref-like value), precisely for the one case the
                // old blanket declaration-site rejection used to cover
                // wholesale: an alias proven to need its address across a
                // suspension the CLR cannot represent as a state-machine field.
                diagnostics.ReportRefLocalCannotBeDeclaredHere(
                    location,
                    v.Name,
                    $"a local live across {article} '{suspensionKeyword}' suspension point in {suspensionContext} (it would require hoisting a managed pointer into the state machine)");
            }
            else
            {
                diagnostics.ReportByRefLikeEscape(
                    location,
                    v.Type,
                    $"be declared as a local in {suspensionContext} and remain live across {article} '{suspensionKeyword}' suspension point (variable '{v.Name}'); restructure the code so its value is no longer needed after the '{suspensionKeyword}'");
            }
        }
    }

    /// <summary>
    /// Collects every local declared directly within a scope that this
    /// analyzer must track: always a native ref-alias local (issue #4222),
    /// and — only when <see cref="collectByRefLikeLocals"/> says the
    /// enclosing scope is async — a by-ref-like (<c>ref struct</c>) local
    /// too (issue #2350; a by-ref-like local in a plain, non-async iterator
    /// stays out of this analyzer's scope, since it remains the pre-existing
    /// blanket rejection in <see cref="StatementBinder"/>). Does not recurse
    /// into nested function-literal bodies, since those are a separate
    /// lexical/hoisting scope with their own, independently analyzed
    /// liveness — see <see cref="AsyncLambdaScopeFinder"/>.
    /// </summary>
    private sealed class InterestingLocalCollector : BoundTreeWalker
    {
        private readonly bool collectByRefLikeLocals;

        public InterestingLocalCollector(bool collectByRefLikeLocals)
        {
            this.collectByRefLikeLocals = collectByRefLikeLocals;
        }

        public HashSet<VariableSymbol> Locals { get; } = new HashSet<VariableSymbol>();

        protected override void VisitVariableDeclaration(BoundVariableDeclaration node)
        {
            if (node.Variable is LocalVariableSymbol local
                && (IsNativeRefAlias(local) || (collectByRefLikeLocals && TypeSymbol.IsByRefLike(local.Type))))
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

        public override void VisitExpression(BoundExpression? node)
        {
            if (node == null)
            {
                return;
            }

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
    /// Finds every async or iterator function-literal expression (lambda or
    /// local function) nested anywhere in a bound tree — regardless of
    /// whether the enclosing scope itself is async/iterator — and runs an
    /// independent <see cref="AnalyzeScope"/> for each one's own body. A
    /// function literal is an opaque leaf to the base
    /// <see cref="BoundTreeWalker"/> (its body is a separate lexical scope),
    /// so this walker must manually continue into
    /// <see cref="BoundFunctionLiteralExpression.Body"/> to discover
    /// further-nested async/iterator lambdas/local functions.
    /// </summary>
    private sealed class AsyncLambdaScopeFinder : BoundTreeWalker
    {
        private readonly DiagnosticBag diagnostics;

        public AsyncLambdaScopeFinder(DiagnosticBag diagnostics)
        {
            this.diagnostics = diagnostics;
        }

        public override void VisitExpression(BoundExpression? node)
        {
            if (node == null)
            {
                return;
            }

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

                // Issue #4222: also recurse into an iterator-returning
                // function literal, not just an async one, so a nested
                // iterator local function/lambda gets its own native
                // ref-alias liveness check.
                if (literal.Function != null
                    && (literal.Function.IsAsyncOrSuspending || Binder.IsIteratorReturnType(literal.Function.Type)))
                {
                    AnalyzeScope(loweredLambdaBody, diagnostics, collectByRefLikeLocals: literal.Function.IsAsyncOrSuspending);
                }

                VisitStatement(loweredLambdaBody);
                return;
            }

            base.VisitExpression(node);
        }
    }
}
