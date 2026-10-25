// <copyright file="RefStructAsyncLivenessAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable

/// Issue #2350: replaces the coarse, syntax-only rejection of a by-ref-like
/// (`ref struct`) local declared anywhere in an async function (the
/// original issue #367 rule in (cref:StatementBinder)) with a sound
/// per-local dataflow analysis. A by-ref-like local is legal in an async
/// function as long as it is never <em>live</em> across an `await`
/// suspension point: (cref:Lowering.Async.AsyncCaptureWalker) never
/// hoists a by-ref-like local into the generated state machine's fields (the
/// CLR forbids a by-ref-like field), so such a local is reset to its CLR
/// default on every fresh `MoveNext` call. A value that survives a
/// suspension therefore silently loses its contents unless it can never
/// actually be observed live across one — which is exactly what this
/// analyzer proves before allowing the declaration.
///
/// This is a backward ("may be live") dataflow, dual to the forward "must be
/// assigned" analysis in (cref:DefiniteAssignmentAnalyzer),
/// over the same (cref:ControlFlowGraph) infrastructure: loops are
/// fully expanded into real graph edges (so a per-iteration local's liveness
/// is checked correctly across back-edges), while `try`, `select`,
/// `scope`, `fixed`, and pattern-`switch` bodies are opaque to
/// the outer graph and are recursively re-analyzed here, mirroring
/// (cref:DefiniteAssignmentAnalyzer)'s
/// `ProcessTryStatement`/`ProcessFixedStatement`/etc. shape.
///
/// `try`/`finally` gets special "ambient live" treatment: an
/// exception can transfer control from <em>any</em> point inside a
/// `try` body straight to its `catch` clauses or `finally`
/// block, so whatever is live entering those handlers is folded into an
/// ambient live set applied to every block of the try body — not just its
/// formal exit — catching the "unsafe finally interaction" case where a
/// local assigned before an `await` in the `try` body is later
/// read in `finally`.
///
/// Capture (a closure capturing a by-ref-like variable) and general escape
/// (returning/storing a by-ref-like value beyond its safe scope) are already
/// covered by pre-existing, unrelated machinery
/// ((cref:LambdaBinder)'s unconditional by-ref-like capture rejection
/// and (cref:StatementBinder)'s ADR-0058 escape-scope tracking) and
/// are untouched by this analyzer.
///
/// Issue #4222 reuses this same machinery for native `let ref`/`var
/// ref` alias locals ((cref:LocalVariableSymbol.RefKind) other than
/// (cref:RefKind.None), tracked separately from by-ref-like locals
/// since the two have different symbol shapes — see
/// (cref:IsNativeRefAlias)) and extends the suspension concept from
/// "await" to "await or yield", so it now also runs for (non-async) iterator
/// functions. Two differences from the by-ref-like treatment: an alias is
/// "interesting" regardless of function kind (an alias in a plain iterator is
/// in scope for #4222; a by-ref-like local in a plain iterator remains the
/// pre-existing blanket rejection in (cref:StatementBinder), untouched
/// here — see (cref:InterestingLocalCollector)), and an assignment
/// *through* an alias (`alias = 42`) is a use of the alias, not a kill
/// of it, unlike overwriting a by-ref-like value local outright.
internal shared class RefStructAsyncLivenessAnalyzer {
    private class ReportingContext {
        init(diagnostics DiagnosticBag?) {
            Diagnostics = diagnostics
            Crossing = HashSet[VariableSymbol]()
        }

        prop Diagnostics DiagnosticBag? {
            get;
        }
        prop Crossing HashSet[VariableSymbol] {
            get;
        }
    }

    /// Collects every local declared directly within a scope that this
    /// analyzer must track: always a native ref-alias local (issue #4222),
    /// and — only when (cref:collectByRefLikeLocals) says the
    /// enclosing scope is async — a by-ref-like (`ref struct`) local
    /// too (issue #2350; a by-ref-like local in a plain, non-async iterator
    /// stays out of this analyzer's scope, since it remains the pre-existing
    /// blanket rejection in (cref:StatementBinder)). Does not recurse
    /// into nested function-literal bodies, since those are a separate
    /// lexical/hoisting scope with their own, independently analyzed
    /// liveness — see (cref:AsyncLambdaScopeFinder).
    private class InterestingLocalCollector : BoundTreeWalker {
        private let collectByRefLikeLocals bool

        init(collectByRefLikeLocals bool) {
            Locals = HashSet[VariableSymbol]()
            this.collectByRefLikeLocals = collectByRefLikeLocals
        }

        prop Locals HashSet[VariableSymbol] {
            get;
        }

        protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
            if node.Variable is LocalVariableSymbol local &&
                (
                RefStructAsyncLivenessAnalyzer.IsNativeRefAlias(local) ||
                    (collectByRefLikeLocals && TypeSymbol.IsByRefLike(local.Type))
            ) {
                Locals.Add(local)
            }
            base.VisitVariableDeclaration(node)
        }
    }

    /// Collects reads (restricted to a fixed "interesting" set of variables)
    /// and whether an `await` occurs anywhere within one expression subtree.
    /// Relies on (cref:BoundTreeWalker)'s default recursion for
    /// everything except assignment targets (correctly not a read) and
    /// function-literal bodies (a separate scope, opaque by design).
    private class ReadAndAwaitCollector : BoundTreeWalker {
        private let interesting HashSet[VariableSymbol]

        init(interesting HashSet[VariableSymbol]) {
            Reads = HashSet[VariableSymbol]()
            this.interesting = interesting
        }

        prop Reads HashSet[VariableSymbol] {
            get;
        }

        prop ContainsAwait bool {
            get;
            private set;
        }

        override func VisitExpression(node BoundExpression?) {
            if node == nil {
                return
            }
            if node is BoundVariableExpression variableExpression && interesting.Contains(variableExpression.Variable) {
                Reads.Add(variableExpression.Variable)
            }
            base.VisitExpression(node)
        }

        protected override func VisitAwaitExpression(node BoundAwaitExpression) {
            ContainsAwait = true
            base.VisitAwaitExpression(node)
        }
    }

    /// Finds every async or iterator function-literal expression (lambda or
    /// local function) nested anywhere in a bound tree — regardless of
    /// whether the enclosing scope itself is async/iterator — and runs an
    /// independent (cref:AnalyzeScope) for each one's own body. A
    /// function literal is an opaque leaf to the base
    /// (cref:BoundTreeWalker) (its body is a separate lexical scope),
    /// so this walker must manually continue into
    /// (cref:BoundFunctionLiteralExpression.Body) to discover
    /// further-nested async/iterator lambdas/local functions.
    private class AsyncLambdaScopeFinder : BoundTreeWalker {
        private let diagnostics DiagnosticBag
        private let references ReferenceResolver?

        init(diagnostics DiagnosticBag, references ReferenceResolver?) {
            this.diagnostics = diagnostics
            this.references = references
        }

        override func VisitExpression(node BoundExpression?) {
            if node == nil {
                return
            }
            if node is BoundFunctionLiteralExpression literal {
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
                let loweredLambdaBody = BodyFacts.LowerLambdaBody(literal.Body)
                // Issue #4222: also recurse into an iterator-returning
                // function literal, not just an async one, so a nested
                // iterator local function/lambda gets its own native
                // ref-alias liveness check.
                if literal.Function != nil &&
                    (literal.Function.IsAsyncOrSuspending || Binder.IsIteratorReturnType(literal.Function.Type)) {
                    RefStructAsyncLivenessAnalyzer.AnalyzeScope(
                        loweredLambdaBody,
                        diagnostics,
                        collectByRefLikeLocals: literal.Function.IsAsyncOrSuspending,
                        references
                    )
                }
                VisitStatement(loweredLambdaBody)
                return
            }
            base.VisitExpression(node)
        }
    }

    /// Entry point, intended to be called once per bound-and-lowered function
    /// body (mirroring every call site of
    /// (cref:DefiniteAssignmentAnalyzer.Analyze)). Runs the
    /// liveness analysis over [`enclosing`](paramref)'s own body (if it
    /// is async and/or an iterator) and, regardless, walks the body looking
    /// for nested async/iterator function-literal expressions (lambdas and
    /// local functions) so each one gets its own, independently-scoped
    /// liveness analysis rooted at its own body — a function literal is an
    /// opaque leaf to the general bound-tree walker (it is a separate
    /// lexical/hoisting scope), so it must be found and recursed into
    /// manually here.
    /// @param body The bound-and-lowered body of [`enclosing`](paramref).
    /// @param enclosing The function/method/accessor whose body is being checked.
    /// @param diagnostics The diagnostic bag to report GS0219/GS0258 violations to.
    /// @param references The compilation references used by the actual async preparation.
    func Analyze(
        body BoundBlockStatement?,
        enclosing FunctionSymbol?,
        diagnostics DiagnosticBag?,
        references ReferenceResolver?
    ) {
        if body == nil || enclosing == nil || diagnostics == nil {
            return
        }
        if enclosing.IsAsyncOrSuspending || Binder.IsIteratorReturnType(enclosing.Type) {
            // By-ref-like locals stay async-only (issue #2350's own scope; a
            // plain iterator still blanket-rejects them elsewhere) — only
            // native ref-alias locals (#4222) are interesting in an iterator
            // that isn't also async.
            AnalyzeScope(body, diagnostics, collectByRefLikeLocals: enclosing.IsAsyncOrSuspending, references)
        }
        let finder = AsyncLambdaScopeFinder(diagnostics, references)
        finder.VisitStatement(body)
    }

    /// Runs the full liveness analysis for one async/iterator scope (a
    /// top-level function/method/accessor body, or an async/iterator
    /// lambda/local-function literal's body). Locals declared by a nested
    /// (non-async, non-iterator) lambda are excluded automatically, since
    /// (cref:InterestingLocalCollector) does not recurse into
    /// function-literal bodies.
    private func AnalyzeScope(
        body BoundBlockStatement,
        diagnostics DiagnosticBag,
        collectByRefLikeLocals bool,
        references ReferenceResolver?
    ) {
        let collector = InterestingLocalCollector(collectByRefLikeLocals)
        collector.VisitStatement(body)
        let reporting = ReportingContext(diagnostics)
        if collector.Locals.Count != 0 {
            AnalyzeRegion(
                body,
                liveOutOfRegion: HashSet[VariableSymbol](),
                ambientLive: HashSet[VariableSymbol](),
                collector.Locals,
                reporting
            )
        }
        if !collectByRefLikeLocals {
            return
        }
        // Preserve source-local rules and prove the actual explicit and implicit suspension representation.
        let spilledBody = AsyncStateMachineRewriter.PrepareBody(body, references)
        let spilledCollector = InterestingLocalCollector(collectByRefLikeLocals: true)
        spilledCollector.VisitStatement(spilledBody)
        spilledCollector.Locals.ExceptWith(reporting.Crossing)
        if spilledCollector.Locals.Count == 0 {
            return
        }
        AnalyzeRegion(
            spilledBody,
            liveOutOfRegion: HashSet[VariableSymbol](),
            ambientLive: HashSet[VariableSymbol](),
            spilledCollector.Locals,
            ReportingContext(diagnostics)
        )
    }

    internal func FindLocalsLiveAcrossSuspension(body BoundBlockStatement, locals IEnumerable[VariableSymbol]) HashSet[
        VariableSymbol
    ] {
        let reporting = ReportingContext(nil)
        AnalyzeRegion(
            body,
            HashSet[VariableSymbol](),
            HashSet[VariableSymbol](),
            HashSet[VariableSymbol](locals),
            reporting
        )
        return reporting.Crossing
    }

    /// Runs the backward "may be live" fixpoint over the CFG of
    /// [`regionBody`](paramref) (wrapping it in a synthetic block first
    /// if it isn't already one). [`liveOutOfRegion`](paramref) seeds
    /// what's live immediately after the whole region (from the enclosing
    /// context); [`ambientLive`](paramref) is unioned into the live-out
    /// of every block in the region (used to model "an exception can jump
    /// straight to a catch/finally from anywhere in this try body").
    /// Returns what's live entering the region (i.e. live-out of its start),
    /// for the caller to keep propagating backward past the compound
    /// statement.
    private func AnalyzeRegion(
        regionBody BoundStatement,
        liveOutOfRegion HashSet[VariableSymbol],
        ambientLive HashSet[VariableSymbol],
        interesting HashSet[VariableSymbol],
        diagnostics ReportingContext?
    ) HashSet[VariableSymbol] {
        let graph = ControlFlowGraph.Create(Lowerer.Flatten(regionBody))
        let liveIn = Dictionary[ControlFlowGraph.BasicBlock, HashSet[VariableSymbol]]()
        for b in graph.Blocks {
            liveIn[b] = HashSet[VariableSymbol]()
        }
        let ComputeLiveOut = func (block ControlFlowGraph.BasicBlock) HashSet[VariableSymbol] {
            let result = HashSet[VariableSymbol](ambientLive)
            for branch in block.Outgoing {
                result.UnionWith(
                    if branch.To.IsEnd {
                        liveOutOfRegion
                    } else {
                        liveIn[branch.To]
                    }
                )
            }
            return result
        }
        var changed = true
        var safety = 0
        while changed && safety++ < 10000 {
            changed = false
            // Iterate in reverse block-list order: for a backward analysis,
            // later blocks (closer to the region's exit) typically converge
            // first, so visiting them first each pass reaches the fixpoint in
            // fewer iterations. Correctness does not depend on this order.
            for var i = graph.Blocks.Count - 1; i >= 0; i-- {
                let block = graph.Blocks[i]
                if block.IsStart || block.IsEnd {
                    continue
                }
                let liveOut = ComputeLiveOut(block)
                let newLiveIn = SimulateBlockBackward(block, liveOut, interesting, diagnostics: nil)
                if !SetsEqual(newLiveIn, liveIn[block]) {
                    liveIn[block] = newLiveIn
                    changed = true
                }
            }
        }
        if changed && diagnostics != nil {
            diagnostics.Crossing.UnionWith(interesting)
        }
        // Final reporting pass: sets are now stable, so every violation is
        // detected exactly once, using fully-converged data.
        if diagnostics != nil {
            for var i = graph.Blocks.Count - 1; i >= 0; i-- {
                let block = graph.Blocks[i]
                if block.IsStart || block.IsEnd {
                    continue
                }
                let liveOut = ComputeLiveOut(block)
                SimulateBlockBackward(block, liveOut, interesting, diagnostics)
            }
        }
        return ComputeLiveOut(graph.Start)
    }

    private func SetsEqual(a HashSet[VariableSymbol], b HashSet[VariableSymbol]) bool {
        if a.Count != b.Count {
            return false
        }
        for v in a {
            if !b.Contains(v) {
                return false
            }
        }
        return true
    }

    private func SimulateBlockBackward(
        block ControlFlowGraph.BasicBlock,
        liveOut HashSet[VariableSymbol],
        interesting HashSet[VariableSymbol],
        diagnostics ReportingContext?
    ) HashSet[VariableSymbol] {
        let live = HashSet[VariableSymbol](liveOut)
        for var i = block.Statements.Count - 1; i >= 0; i-- {
            ProcessStatementBackward(block.Statements[i], live, interesting, diagnostics)
        }
        return live
    }

    private func ProcessStatementBackward(
        statement BoundStatement,
        live HashSet[VariableSymbol],
        interesting HashSet[VariableSymbol],
        diagnostics ReportingContext?
    ) {
        switch statement {
            case es is BoundExpressionStatement {
                ApplyExpression(es.Expression, live, interesting, diagnostics, statement)
            }
            case vd is BoundVariableDeclaration {
                {
                    let collector = ReadAndAwaitCollector(interesting)
                    if vd.Initializer is {} initializer {
                        collector.VisitExpression(initializer)
                    }
                    let isInteresting = vd.Variable is LocalVariableSymbol && interesting.Contains(vd.Variable)
                    let selfRead = isInteresting && collector.Reads.Contains(vd.Variable)
                    let killTarget VariableSymbol? = if isInteresting && !selfRead {
                        vd.Variable
                    } else {
                        default(VariableSymbol?)
                    }
                    // Issue #4222: same fold-before-check ordering as ApplyExpression
                    // (see its comment) — an initializer combining an interesting
                    // read with an `await` (e.g. `var total = await X() + alias`)
                    // must not silently miss a read positioned after the suspension.
                    live.UnionWith(collector.Reads)
                    if collector.ContainsAwait {
                        ReportIfUnsafe(live, killTarget, diagnostics, statement, "await")
                    }
                    if killTarget != nil {
                        live.Remove(killTarget)
                    }
                }
            }
            case ys is BoundYieldStatement {
                ReportIfUnsafe(live, excludedSelfKill: nil, diagnostics, statement, "yield")
                ApplyExpression(ys.Expression, live, interesting, diagnostics, statement)
            }
            case rs is BoundReturnStatement {
                if rs.Expression != nil {
                    ApplyExpression(rs.Expression, live, interesting, diagnostics, statement)
                }
            }
            case th is BoundThrowStatement {
                ApplyExpression(th.Expression, live, interesting, diagnostics, statement)
            }
            case BoundRethrowStatement { }
            case cgs is BoundConditionalGotoStatement {
                ApplyExpression(cgs.Condition, live, interesting, diagnostics, statement)
            }
            case BoundLabelStatement, BoundGotoStatement { }
            case tryStmt is BoundTryStatement {
                ProcessTryBackward(tryStmt, live, interesting, diagnostics)
            }
            case fixedStmt is BoundFixedStatement {
                ProcessFixedBackward(fixedStmt, live, interesting, diagnostics)
            }
            case switchStmt is BoundPatternSwitchStatement {
                ProcessSwitchBackward(switchStmt, live, interesting, diagnostics)
            }
            default { }
        }
    }

    /// try/catch/finally: an exception can transfer control from any point in
    /// the try body straight into a catch clause or (if uncaught, or on
    /// normal/exceptional catch completion) into finally. Modeled as an
    /// "ambient live" set — the union of what's live entering every catch
    /// clause and the finally block — that is folded into the live-out of
    /// every block inside the try body (not just its formal exit), so a
    /// local that's read in `finally` (or a catch) shows up as live at an
    /// earlier `await` inside `try`, even though normal control flow alone
    /// would never reach that read from there.
    private func ProcessTryBackward(
        tryStmt BoundTryStatement,
        live HashSet[VariableSymbol],
        interesting HashSet[VariableSymbol],
        diagnostics ReportingContext?
    ) {
        let afterTry = HashSet[VariableSymbol](live)
        let exceptionalEscapeLive = HashSet[VariableSymbol]()
        var finallyLiveIn HashSet[VariableSymbol]? = nil
        if tryStmt.FinallyBlock != nil {
            finallyLiveIn = AnalyzeRegion(
                tryStmt.FinallyBlock,
                afterTry,
                HashSet[VariableSymbol](),
                interesting,
                diagnostics
            )
            exceptionalEscapeLive.UnionWith(finallyLiveIn)
        }
        // Normal completion of the try body (or a catch clause) falls into
        // finally (if any); otherwise it falls to whatever's after the whole
        // try statement.
        let normalFallthrough = finallyLiveIn ?? afterTry
        for clause in tryStmt.CatchClauses {
            let catchLiveIn = AnalyzeRegion(
                clause.Body,
                normalFallthrough,
                HashSet[VariableSymbol](),
                interesting,
                diagnostics
            )
            if clause.Variable != nil {
                catchLiveIn.Remove(clause.Variable)
            }
            exceptionalEscapeLive.UnionWith(catchLiveIn)
        }
        // The try body's own normal exit also falls into finally (or after
        // the statement); the ambient set additionally lets an exception
        // reach a catch/finally from any interior point.
        let tryLiveIn = AnalyzeRegion(
            tryStmt.TryBlock,
            normalFallthrough,
            exceptionalEscapeLive,
            interesting,
            diagnostics
        )
        live.Clear()
        live.UnionWith(tryLiveIn)
    }

    /// The `fixed` body always runs unconditionally (no
    /// branching), and its synthetic pinned/pointer/source locals do not
    /// exist before it, so they're excluded from what flows backward past
    /// the statement.
    private func ProcessFixedBackward(
        fixedStmt BoundFixedStatement,
        live HashSet[VariableSymbol],
        interesting HashSet[VariableSymbol],
        diagnostics ReportingContext?
    ) {
        let bodyLiveIn = AnalyzeRegion(fixedStmt.Body, live, HashSet[VariableSymbol](), interesting, diagnostics)
        bodyLiveIn.Remove(fixedStmt.PinnedVariable)
        bodyLiveIn.Remove(fixedStmt.PointerVariable)
        if fixedStmt.SourceVariable != nil {
            bodyLiveIn.Remove(fixedStmt.SourceVariable)
        }
        live.Clear()
        live.UnionWith(bodyLiveIn)
        ApplyExpression(fixedStmt.PinnedSource, live, interesting, diagnostics, nil)
    }

    /// A pattern switch, unlike `select`, can complete having matched no
    /// arm when there's no exhaustive `default` — that "nothing matched"
    /// path must also contribute to what's live before the statement (it
    /// falls straight through to whatever's live after it).
    private func ProcessSwitchBackward(
        switchStmt BoundPatternSwitchStatement,
        live HashSet[VariableSymbol],
        interesting HashSet[VariableSymbol],
        diagnostics ReportingContext?
    ) {
        let afterSwitch = HashSet[VariableSymbol](live)
        let union = HashSet[VariableSymbol]()
        var hasDefault = false
        for arm in switchStmt.Arms {
            if arm.IsDefault {
                hasDefault = true
            }
            let armLiveIn = AnalyzeRegion(arm.Body, afterSwitch, HashSet[VariableSymbol](), interesting, diagnostics)
            if arm.Guard != nil {
                ApplyExpression(arm.Guard, armLiveIn, interesting, diagnostics, nil)
            }
            union.UnionWith(armLiveIn)
        }
        if !hasDefault {
            union.UnionWith(afterSwitch)
        }
        live.Clear()
        live.UnionWith(union)
        ApplyExpression(switchStmt.Discriminant, live, interesting, diagnostics, nil)
    }

    /// Applies one expression's backward transfer to [`live`](paramref):
    /// if the expression is a top-level assignment to an interesting
    /// by-ref-like local that is not also read within its own right-hand
    /// side (see the self-referential-redefinition note below), that local
    /// is a "kill" — its pre-statement liveness does not depend on what's
    /// live after. An assignment *through* a native ref-alias local
    /// (`alias = 42`) is never a kill — issue #4222: it writes to the
    /// pointee via the alias's stored address, which requires the alias
    /// itself to be live at that point (there is no syntax to re-seat an
    /// alias to a new address, so every assignment is a use). Otherwise
    /// every interesting local read anywhere in the expression is added to
    /// `live`. If the expression contains an `await`, any currently-live
    /// interesting local (other than a pure kill target of this same
    /// expression) is reported as unsafe.
    private func ApplyExpression(
        expression BoundExpression?,
        live HashSet[VariableSymbol],
        interesting HashSet[VariableSymbol],
        diagnostics ReportingContext?,
        owningStatement BoundStatement?
    ) {
        if expression == nil {
            return
        }
        let collector = ReadAndAwaitCollector(interesting)
        collector.VisitExpression(expression)
        var killTarget VariableSymbol? = nil
        if expression is BoundAssignmentExpression assign && interesting.Contains(assign.Variable) {
            if IsNativeRefAlias(assign.Variable) {
                live.Add(assign.Variable)
            } else if !collector.Reads.Contains(assign.Variable) {
                // Self-referential redefinition (e.g. `span = span.Slice(await
                // X())`) must NOT be treated as a kill: the pre-statement value
                // of `span` is read by the statement's own right-hand side, so it
                // must survive any `await` nested in that same right-hand side
                // regardless of the read's apparent position relative to the
                // `await` — evaluation order does not change which value is
                // live entering the statement.
                killTarget = assign.Variable
            }
        }
        // Issue #4222: fold this expression's own reads into `live` BEFORE
        // checking for an unsafe crossing, not after. This analysis is
        // statement/expression-granular — it has no notion of a read's
        // position relative to a nested `await` within the SAME expression
        // (e.g. `total = await X() + alias` reads `alias` in evaluation
        // order strictly *after* the suspension resumes, needing the alias
        // itself, not just its pointee value, to survive the `await`; the
        // bound tree alone doesn't let this analyzer cheaply tell that apart
        // from `total = alias + await X()`, which never needs the alias to
        // survive). Checking against the union (rather than only what later
        // code already needs) is the same conservative call already made for
        // self-referential redefinition above — sound (a same-expression read
        // that always precedes the `await` is occasionally over-rejected),
        // never silently wrong, matching this analyzer's "conservative, never
        // unsound" rule used everywhere else in this file. `killTarget` is
        // never itself in `collector.Reads` (see above), so unioning first
        // does not defeat its exclusion below.
        live.UnionWith(collector.Reads)
        if collector.ContainsAwait {
            ReportIfUnsafe(live, killTarget, diagnostics, owningStatement, "await")
        }
        if killTarget != nil {
            live.Remove(killTarget)
        }
    }

    /// Issue #4222: true for a native `let ref`/`var ref` alias local
    /// (tracked via (cref:LocalVariableSymbol.RefKind), since its `Type` stays
    /// the pointee type — see (cref:StatementBinder.BindRefAliasLocalDeclaration)),
    /// as opposed to a by-ref-like (`ref struct`) value local.
    private func IsNativeRefAlias(variable VariableSymbol) bool -> variable is LocalVariableSymbol local &&
        local.RefKind != RefKind.None

    private func ReportIfUnsafe(
        live HashSet[VariableSymbol],
        excludedSelfKill VariableSymbol?,
        diagnostics ReportingContext?,
        owningStatement BoundStatement?,
        suspensionKeyword string
    ) {
        if diagnostics == nil {
            return
        }
        for v in live {
            if object.ReferenceEquals(v, excludedSelfKill) {
                continue
            }
            diagnostics.Crossing.Add(v)
            let bag = diagnostics.Diagnostics
            if bag == nil {
                continue
            }
            let location = v.DeclaringSyntax?.Location ?? owningStatement?.Syntax?.Location ?? default(TextLocation)
            let suspensionContext = if suspensionKeyword == "yield" {
                "an iterator"
            } else {
                "an async function"
            }
            let article = if suspensionKeyword == "yield" {
                "a"
            } else {
                "an"
            }
            if IsNativeRefAlias(v) {
                // Issue #4222: GS0258 (not GS0219 — this is an alias local,
                // not a by-ref-like value), precisely for the one case the
                // old blanket declaration-site rejection used to cover
                // wholesale: an alias proven to need its address across a
                // suspension the CLR cannot represent as a state-machine field.
                bag.ReportRefLocalCannotBeDeclaredHere(
                    location,
                    v.Name,
                    "a local live across $article '$suspensionKeyword' suspension point in $suspensionContext (it would require hoisting a managed pointer into the state machine)"
                )
            } else {
                bag.ReportByRefLikeEscape(
                    location,
                    v.Type,
                    "be declared as a local in $suspensionContext and remain live across $article '$suspensionKeyword' suspension point (variable '${v.Name}'); restructure the code so its value is no longer needed after the '$suspensionKeyword'"
                )
            }
        }
    }
}
