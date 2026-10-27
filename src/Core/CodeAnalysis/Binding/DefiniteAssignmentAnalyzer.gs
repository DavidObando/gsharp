// <copyright file="DefiniteAssignmentAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import System
import System.Threading

/// Definite-assignment analysis. Two consumers share the same forward
/// "must be assigned" data-flow:
/// - ADR-0060 items #4 and #5 (ref-kind parameters; formerly the `RefKindDefiniteAssignmentAnalyzer`):
/// GS0238 — every `out` parameter must be definitely assigned on every path that reaches a `return` (or
/// falls off the function end for `void` bodies); GS0239 — a variable passed via `ref` (NOT `out`) at a
/// call site must be definitely assigned at that point.
/// - ADR-0159 / issue #3316 (no-zero-value locals): GS0522 — a local whose type has no usable zero
/// value (today: a bare `chan T` slot, see (cref:MagicCollectionZeroValue.RequiresExplicitInitializer))
/// may be declared without an initializer, but every USE reachable by a path without a preceding
/// assignment is an error — C#'s CS0165 model. Locals whose types have sound zero values (ints, maps
/// and the other magic collections post-ADR-0159, structs, …) keep their documented zero-value
/// initialization and are deliberately NOT flow-checked.
/// The analyzer builds a (cref:ControlFlowGraph) for the function body
/// (and, recursively, for the body of every try/catch/finally, `select`
/// case, `scope`, `fixed`, and await-for-range block it contains —
/// issue #1642: the outer CFG treats those as single opaque statements, see
/// (cref:ControlFlowGraph)'s `BasicBlockBuilder`) and runs a
/// forward "must be assigned" data-flow with intersect-meet over
/// predecessors. Reads are checked before writes apply within a basic block,
/// so a single statement that both writes and reads the same variable is
/// classified using the set at the start of that statement.
internal shared class DefiniteAssignmentAnalyzer {
    /// (cref:NestedRegionCacheMode) value: probes are never cached.
    internal let NestedRegionCacheOff int32 = 0
    /// (cref:NestedRegionCacheMode) value: probes are cached (the default).
    internal let NestedRegionCacheOn int32 = 1
    /// (cref:NestedRegionCacheMode) value: probes are cached and every hit is re-analyzed and compared; a
    /// difference is counted in (cref:NestedRegionCacheMismatches). Used by tests.
    internal let NestedRegionCacheVerify int32 = 2
    /// A cache key for a region that is built fresh on every call, so no later call could hit it.
    private let NotCacheable object = Object()
    private var nestedRegionCacheMode int32 = 1
    private var nestedRegionCacheHits int64
    private var nestedRegionCacheBypasses int64
    private var nestedRegionCacheMismatches int64

    /// Test seam for issue #5284: how nested-region probes are cached. Tests set it for one compilation and
    /// restore (cref:NestedRegionCacheOn) afterwards; compilation results do not depend on it.
    internal prop NestedRegionCacheMode int32 {
        get -> nestedRegionCacheMode
        set {
            nestedRegionCacheMode = value
        }
    }
    /// Probes answered from the cache since process start.
    internal prop NestedRegionCacheHits int64 -> Interlocked.Read(&nestedRegionCacheHits)
    /// Probes that skipped the cache because a pointer alias was live.
    internal prop NestedRegionCacheBypasses int64 -> Interlocked.Read(&nestedRegionCacheBypasses)
    /// Verified hits whose cached result differed from a fresh analysis.
    internal prop NestedRegionCacheMismatches int64 -> Interlocked.Read(&nestedRegionCacheMismatches)

    /// Fallback walker for expression/statement kinds the linear simulation
    /// has no explicit case for (channel receive/send/close, index and member
    /// access, interpolated strings, …). It routes nested flow-sensitive block
    /// and branch expressions back through (cref:ProcessExpression) and:
    /// - recursively analyzes nested function literals against the assignment state at their capture point
    /// (the C# model: a use of a captured local inside the literal is an error unless the local was
    /// definitely assigned before the literal, or is assigned inside it);
    /// - reports GS0522 for value reads of tracked no-zero-value locals (issue #3316);
    /// - skips `&v` subtrees: an address-of operand is a ref/out argument position, not a value read —
    /// unassigned ref-reads are GS0239/GS9003 territory, and reporting them here would double-report
    /// against the ref-kind checks.
    private data struct ExpressionFlowContext(
        OutParams ImmutableArray[ParameterSymbol],
        Function FunctionSymbol,
        MethodExitLabel BoundLabel?
    ) : IEquatable[ExpressionFlowContext] { }

    /// One entry of (cref:NestedRegionCache): the result of probing one region from one input state.
    private class NestedRegionResult {
        internal init(input HashSet[VariableSymbol], trackedCount int32, exit HashSet[VariableSymbol]?) {
            Input = input
            TrackedCount = trackedCount
            Exit = exit
        }

        prop Input HashSet[VariableSymbol] {
            get;
        }
        prop TrackedCount int32 {
            get;
        }
        prop Exit HashSet[VariableSymbol]? {
            get;
        }
    }

    /// The no-zero-value locals of one function analysis, which also owns that analysis's cache of
    /// nested-region probes (issue #5284). A probe is a diagnostics-free re-analysis of a try, catch,
    /// finally, switch-arm, fixed or await-for body; an enclosing region's fixed point repeats the probe
    /// with an unchanged input state on later iterations. One instance serves one (cref:AnalyzeWithCaptured)
    /// call on one thread, so nothing here is shared between threads.
    internal class TrackedLocals : HashSet[VariableSymbol] {
        private let probes Dictionary[object, List[NestedRegionResult]] = Dictionary[object, List[NestedRegionResult]](
            ReferenceEqualityComparer.Instance
        )

        /// Replays the earlier probe of [`region`](paramref) that started from exactly [`input`](paramref) with the
        /// same tracked locals. [`exit`](paramref) is a copy the caller may change, or null when the region never
        /// completes normally.
        internal func TryReplay(region object, input HashSet[VariableSymbol], out exit HashSet[VariableSymbol]?) bool {
            if probes.TryGetValue(region, out var candidates) {
                for var i = 0; i < candidates.Count; i++ {
                    let candidate = candidates[i]
                    if candidate.TrackedCount == Count &&
                        candidate
                        .Input
                        .Count == input.Count &&
                        candidate
                        .Input
                        .SetEquals(input) {
                        exit = if candidate.Exit == nil {
                            default(HashSet[VariableSymbol]?)
                        } else {
                            HashSet[VariableSymbol](candidate.Exit)
                        }
                        return true
                    }
                }
            }
            exit = nil
            return false
        }

        /// Remembers a probe made while the tracked set held [`trackedBefore`](paramref) locals. A probe that
        /// added a tracked local is not remembered: a replay would skip that side effect.
        internal func Record(
            region object,
            input HashSet[VariableSymbol],
            exit HashSet[VariableSymbol]?,
            trackedBefore int32
        ) {
            if Count != trackedBefore {
                return
            }
            if !probes.TryGetValue(region, out var candidates) {
                candidates = List[NestedRegionResult]()
                probes[region] = candidates
            }
            candidates.Add(
                NestedRegionResult(
                    HashSet[VariableSymbol](input),
                    trackedBefore,
                    if exit == nil {
                        default(HashSet[VariableSymbol]?)
                    } else {
                        HashSet[VariableSymbol](exit)
                    }
                )
            )
        }
    }

    private class FunctionLiteralAndUseWalker : BoundTreeWalker {
        private let assigned HashSet[VariableSymbol]
        private let tracked HashSet[VariableSymbol]
        private let diagnostics DiagnosticBag?
        private let pointerAliases Dictionary[VariableSymbol, VariableSymbol]
        private let flowContext ExpressionFlowContext?

        init(
            assigned HashSet[VariableSymbol],
            tracked HashSet[VariableSymbol],
            diagnostics DiagnosticBag?,
            pointerAliases Dictionary[VariableSymbol, VariableSymbol],
            flowContext ExpressionFlowContext?
        ) {
            this.assigned = assigned
            this.tracked = tracked
            this.diagnostics = diagnostics
            this.pointerAliases = pointerAliases
            this.flowContext = flowContext
        }

        override func VisitExpression(node BoundExpression?) {
            if node == nil {
                return
            }
            switch node {
                case literal is BoundFunctionLiteralExpression {
                    {
                        if diagnostics == nil {
                            return
                        }
                        let diagnostics = diagnostics!!
                        let lowered = BodyFacts.LowerLambdaBody(literal.Body)
                        DefiniteAssignmentAnalyzer.AnalyzeWithCaptured(
                            lowered.PreEmitAnalysisBody ?? lowered,
                            literal.Function,
                            diagnostics,
                            literal.CapturedVariables.Where((variable VariableSymbol) -> assigned.Contains(variable)),
                            literal.CapturedVariables.Where((variable VariableSymbol) -> tracked.Contains(variable))
                        )
                        return
                    }
                }
                case read is BoundVariableExpression {
                    DefiniteAssignmentAnalyzer.CheckTrackedUse(read, assigned, tracked, diagnostics)
                    return
                }
                case BoundAddressOfExpression {
                    return
                }
                case BoundBlockExpression,
                BoundBinaryExpression,
                BoundConditionalExpression,
                BoundConditionalAddressExpression,
                BoundSwitchExpression,
                BoundNullConditionalAccessExpression {
                    DefiniteAssignmentAnalyzer.ProcessExpression(
                        node,
                        assigned,
                        diagnostics,
                        pointerAliases,
                        tracked,
                        flowContext
                    )
                    return
                }
                default {
                    base.VisitExpression(node)
                    return
                }
            }
        }
    }

    func Analyze(body BoundBlockStatement, function FunctionSymbol, diagnostics DiagnosticBag) -> AnalyzeWithCaptured(
        body,
        function,
        diagnostics,
        capturedAssigned: nil,
        capturedTracked: nil
    )

    private func AnalyzeWithCaptured(
        body BoundBlockStatement?,
        function FunctionSymbol?,
        diagnostics DiagnosticBag?,
        capturedAssigned IEnumerable[VariableSymbol]?,
        capturedTracked IEnumerable[VariableSymbol]?
    ) {
        if body == nil || function == nil {
            return
        }
        // Seed: every non-out parameter (including ref/in) is assigned on entry.
        let initialAssigned = HashSet[VariableSymbol]()
        for p in function.Parameters {
            if p.RefKind != RefKind.Out {
                initialAssigned.Add(p)
            }
        }
        if capturedAssigned != nil {
            initialAssigned.UnionWith(capturedAssigned)
        }
        let outParams = function.Parameters.Where((p ParameterSymbol) -> p.RefKind == RefKind.Out).ToImmutableArray()
        // Best-effort `p = &v` / `var p = &v` alias tracking so `*p = expr`
        // (BoundIndirectAssignmentExpression) can count as an assignment to
        // `v`. Function-scoped and not part of the dataflow lattice — see
        // TrackPointerAlias/TryResolvePointerTarget for the (deliberately
        // narrow) semantics.
        let pointerAliases = Dictionary[VariableSymbol, VariableSymbol]()
        // Issue #3316: the no-zero-value locals subject to the GS0522
        // use-site check. Populated when a declared-without-initializer
        // channel local's BoundVariableDeclaration is simulated.
        // Function-scoped, like pointerAliases: the set only ever grows, and
        // reporting happens in the final diagnostics pass once every
        // declaration has been seen. A function literal's analysis is seeded
        // with the tracked locals it captures so a capture-before-assignment
        // use inside the literal reports against the state at the capture
        // point (the C# model).
        let tracked = TrackedLocals()
        if capturedTracked != nil {
            tracked.UnionWith(capturedTracked)
        }
        // ponytail: fail-safe, not fail-open (issue #1642 secondary defect).
        // ControlFlowGraph.Create is already called unguarded against this
        // same lowered body a few lines above in Binder.cs
        // (ControlFlowGraph.AllPathsReturn) for every non-void function, so
        // this path is realistically only reachable for void functions or
        // a genuine bug in this analyzer's own recursion. Either way,
        // silently returning (the previous behavior) would let a possibly-
        // unassigned `out` parameter compile with no diagnostic at all.
        // Report it instead of swallowing the failure; GS0239 (ref-read)
        // and GS0522 (no-zero-value local use) checks are best-effort and
        // are simply skipped on this rare path.
        let reportUnanalyzable = func () {
            for op in outParams {
                diagnostics?.ReportOutParameterNotAssigned(
                    function.Declaration?.Location ?? default(TextLocation),
                    op.Name
                )
            }
        }
        // A body the control flow graph cannot model (a nested block that was not
        // flattened, as in a function literal's pre-emit body) takes the fail-safe path
        // without paying for the throw that would report it. The catch stays as the last
        // resort for nested regions.
        if !ControlFlowGraph.CanCreate(body) {
            reportUnanalyzable()
            return
        }
        try {
            AnalyzeRegion(
                body,
                initialAssigned,
                outParams,
                function,
                diagnostics,
                pointerAliases,
                tracked,
                FindMethodExitLabel(body),
                isFunctionBody: true
            )
        } catch {
            reportUnanalyzable()
        }
    }

    /// Runs the forward "must be assigned" fixpoint over the CFG of
    /// [`regionBody`](paramref) (wrapping it in a synthetic block first
    /// if it isn't already one), seeded with [`initialAssigned`](paramref).
    /// When [`isFunctionBody`](paramref) is true, every path reaching the
    /// region's end is an actual function exit and is checked against
    /// [`outParams`](paramref) (mirrors the original top-level check).
    /// Otherwise, internal returns are checked here because they leave the
    /// function from a point the outer CFG never sees (issue #1642), throw
    /// paths terminate without requiring assignment, and normal fall-through
    /// paths are merged and returned. Returns null when the region never
    /// completes normally. The region only reads its initial assignment set.
    private func AnalyzeRegion(
        regionBody BoundStatement,
        initialAssigned HashSet[VariableSymbol],
        outParams ImmutableArray[ParameterSymbol],
        function FunctionSymbol,
        diagnostics DiagnosticBag?,
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        tracked HashSet[VariableSymbol],
        methodExitLabel BoundLabel?,
        isFunctionBody bool = false,
        cacheKey object? = nil
    ) HashSet[VariableSymbol]? {
        // Issue #5284: only a diagnostics-free probe of a nested region is cached. Its result is a pure
        // function of the region, the input set, and the tracked-local set: the outer parameters are fixed
        // for one analysis, the probe reports nothing, and an empty alias map is neither read nor changed
        // (any alias in play bypasses the cache). A probe that adds a tracked local has a side effect a
        // replay would skip, so it is not stored.
        let cache = tracked as TrackedLocals
        let key object = cacheKey ?? regionBody
        let mode = nestedRegionCacheMode
        if isFunctionBody ||
            diagnostics != nil ||
            cache == nil ||
            mode == NestedRegionCacheOff ||
            object
            .ReferenceEquals(key, NotCacheable) {
            return AnalyzeRegionUncached(
                regionBody,
                initialAssigned,
                outParams,
                function,
                diagnostics,
                pointerAliases,
                tracked,
                methodExitLabel,
                isFunctionBody
            )
        }
        if pointerAliases.Count != 0 {
            Interlocked.Increment(&nestedRegionCacheBypasses)
            return AnalyzeRegionUncached(
                regionBody,
                initialAssigned,
                outParams,
                function,
                diagnostics,
                pointerAliases,
                tracked,
                methodExitLabel,
                isFunctionBody
            )
        }
        if cache.TryReplay(key, initialAssigned, out var cachedExit) {
            CompilationMeasurements.Count("definite-assignment.region-replays")
            Interlocked.Increment(&nestedRegionCacheHits)
            if mode == NestedRegionCacheVerify {
                let fresh = AnalyzeRegionUncached(
                    regionBody,
                    initialAssigned,
                    outParams,
                    function,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    methodExitLabel,
                    isFunctionBody
                )
                let same = if cachedExit == nil || fresh == nil {
                    cachedExit == nil && fresh == nil
                } else {
                    SetsEqual(cachedExit, fresh)
                }
                if !same {
                    Interlocked.Increment(&nestedRegionCacheMismatches)
                }
            }
            return cachedExit
        }
        let trackedBefore = cache.Count
        let exit = AnalyzeRegionUncached(
            regionBody,
            initialAssigned,
            outParams,
            function,
            diagnostics,
            pointerAliases,
            tracked,
            methodExitLabel,
            isFunctionBody
        )
        if pointerAliases.Count == 0 {
            cache.Record(key, initialAssigned, exit, trackedBefore)
        }
        return exit
    }

    private func AnalyzeRegionUncached(
        regionBody BoundStatement,
        initialAssigned HashSet[VariableSymbol],
        outParams ImmutableArray[ParameterSymbol],
        function FunctionSymbol,
        diagnostics DiagnosticBag?,
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        tracked HashSet[VariableSymbol],
        methodExitLabel BoundLabel?,
        isFunctionBody bool = false
    ) HashSet[VariableSymbol]? {
        CompilationMeasurements.Count("definite-assignment.region-analyses")
        let graph = ControlFlowGraph.Create(AsBlock(regionBody))
        let entryAssigned = Dictionary[ControlFlowGraph.BasicBlock, HashSet[VariableSymbol]?]()
        let exitAssigned = Dictionary[ControlFlowGraph.BasicBlock, HashSet[VariableSymbol]?]()
        // ADR-0166 follow-on: a block that ends in a conditional goto has two
        // exits whose "definitely assigned" sets differ — `a && M(out x)`
        // assigns `x` on the true edge only (C# definite assignment "when
        // true" / "when false"). Recorded per block; EdgeExit selects the set
        // matching the branch's polarity.
        let conditionalExits = Dictionary[
            ControlFlowGraph.BasicBlock,
            (WhenTrue HashSet[VariableSymbol], WhenFalse HashSet[VariableSymbol])
        ]()
        for b in graph.Blocks {
            entryAssigned[b] = nil
            exitAssigned[b] = nil
        }
        // Published entry, exit and conditional states remain unchanged.
        // Reuse only the scratch set or a state removed from its dictionary.
        var scratch = HashSet[VariableSymbol]()
        var changed = true
        var safety = 0
        while changed && safety++ < 10000 {
            changed = false
            for block in graph.Blocks {
                if block.IsEnd {
                    continue
                }
                scratch.Clear()
                if block.IsStart {
                    scratch.UnionWith(initialAssigned)
                } else {
                    var hasEntry = false
                    for incoming in block.Incoming {
                        let predExit HashSet[VariableSymbol]? = EdgeExit(incoming, exitAssigned, conditionalExits)
                        if predExit == nil {
                            continue
                        }
                        if !hasEntry {
                            scratch.UnionWith(predExit)
                            hasEntry = true
                        } else {
                            scratch.IntersectWith(predExit)
                        }
                    }
                    // Wait until at least one reachable predecessor has been
                    // simulated. Seeding an unvisited loop cycle with the
                    // function-entry state can permanently intersect away
                    // assignments made before the loop.
                    if !hasEntry {
                        continue
                    }
                }
                let prevEntry HashSet[VariableSymbol]? = entryAssigned[block]
                if prevEntry == nil || !SetsEqual(prevEntry, scratch) {
                    entryAssigned[block] = scratch
                    scratch = prevEntry ?? HashSet[VariableSymbol]()
                    changed = true
                }
                let currentEntry HashSet[VariableSymbol]? = entryAssigned[block]
                if currentEntry == nil {
                    continue
                }
                scratch.Clear()
                scratch.UnionWith(currentEntry)
                let exit = SimulateBlock(
                    block,
                    scratch,
                    outParams,
                    function,
                    nil,
                    pointerAliases,
                    tracked,
                    methodExitLabel
                )
                let prevExit HashSet[VariableSymbol]? = exitAssigned[block]
                if prevExit == nil || !SetsEqual(prevExit, exit) {
                    exitAssigned[block] = exit
                    scratch = prevExit ?? HashSet[VariableSymbol]()
                    changed = true
                }
                if block.Statements.LastOrDefault() is BoundConditionalGotoStatement conditionalGoto {
                    scratch.Clear()
                    scratch.UnionWith(currentEntry)
                    let beforeCondition = scratch
                    for var i = 0; i < block.Statements.Count - 1; i++ {
                        ProcessStatement(
                            block.Statements[i],
                            beforeCondition,
                            outParams,
                            function,
                            nil,
                            pointerAliases,
                            tracked,
                            methodExitLabel
                        )
                    }
                    let (whenTrue, whenFalse) = ClassifyConditionAssignments(
                        conditionalGoto.Condition,
                        beforeCondition,
                        pointerAliases,
                        tracked,
                        ExpressionFlowContext(outParams, function, methodExitLabel)
                    )
                    if !conditionalExits.TryGetValue(block, out var previous) ||
                        !SetsEqual(previous.WhenTrue, whenTrue) ||
                        !SetsEqual(previous.WhenFalse, whenFalse) {
                        conditionalExits[block] = (whenTrue, whenFalse)
                        changed = true
                    }
                }
            }
        }
        // Final reporting pass — only performed once the caller actually wants
        // diagnostics (nested regions get re-analyzed without diagnostics
        // while probing a parent's dataflow; see e.g. ProcessTryStatement).
        if diagnostics != nil {
            for block in graph.Blocks {
                if block.IsStart || block.IsEnd {
                    continue
                }
                let entry = entryAssigned[block] ?? initialAssigned
                scratch.Clear()
                scratch.UnionWith(entry)
                SimulateBlock(
                    block,
                    scratch,
                    outParams,
                    function,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    methodExitLabel
                )
            }
        }
        if isFunctionBody {
            if diagnostics != nil && !outParams.IsDefaultOrEmpty {
                for endBranch in graph.End.Incoming {
                    if endBranch.From.Statements.LastOrDefault()?.Kind == BoundNodeKind.ThrowStatement {
                        continue
                    }
                    let exit = EdgeExit(endBranch, exitAssigned, conditionalExits) ?? initialAssigned
                    for op in outParams {
                        if !exit.Contains(op) {
                            diagnostics.ReportOutParameterNotAssigned(
                                GetReportLocation(endBranch.From, function),
                                op.Name
                            )
                        }
                    }
                }
            }
            return nil
        }
        // Not the function body: discard throw paths, check function-return
        // paths, and merge normal fall-through paths.
        var normalExit HashSet[VariableSymbol]? = nil
        var anyNormal = false
        for endBranch in graph.End.Incoming {
            let fromBlock = endBranch.From
            let exit = EdgeExit(endBranch, exitAssigned, conditionalExits) ?? initialAssigned
            let lastStatement = fromBlock.Statements.LastOrDefault()
            if lastStatement?.Kind == BoundNodeKind.ThrowStatement {
                continue
            }
            let exitsFunction = lastStatement?.Kind == BoundNodeKind.ReturnStatement ||
                (
                lastStatement is BoundGotoStatement gotoStatement && object.ReferenceEquals(
                    gotoStatement.Label,
                    methodExitLabel
                )
            )
            if exitsFunction {
                if diagnostics != nil && !outParams.IsDefaultOrEmpty {
                    for op in outParams {
                        if !exit.Contains(op) {
                            diagnostics.ReportOutParameterNotAssigned(GetReportLocation(fromBlock, function), op.Name)
                        }
                    }
                }
                continue
            }
            anyNormal = true
            normalExit = if normalExit == nil {
                HashSet[VariableSymbol](exit)
            } else {
                Intersect(normalExit, exit)
            }
        }
        return if anyNormal {
            normalExit
        } else {
            default(HashSet[VariableSymbol]?)
        }
    }

    /// The predecessor's exit state along [`branch`](paramref): the
    /// polarity-specific set when the predecessor ends in a conditional goto
    /// (the CFG builder attaches the goto's own condition object to the true
    /// edge and a negation of it to the false edge), the plain exit otherwise.
    private func EdgeExit(
        branch ControlFlowGraph.BasicBlockBranch,
        exitAssigned Dictionary[ControlFlowGraph.BasicBlock, HashSet[VariableSymbol]?],
        conditionalExits Dictionary[
            ControlFlowGraph.BasicBlock,
            (WhenTrue HashSet[VariableSymbol], WhenFalse HashSet[VariableSymbol])
        ]
    ) HashSet[VariableSymbol]? {
        if branch.Condition != nil &&
            branch
            .From
            .Statements
            .LastOrDefault() is BoundConditionalGotoStatement conditionalGoto &&
            conditionalExits
            .TryGetValue(branch.From, out var exits) {
            return if object.ReferenceEquals(branch.Condition, conditionalGoto.Condition) {
                exits.WhenTrue
            } else {
                exits.WhenFalse
            }
        }
        return exitAssigned[branch.From]
    }

    /// The definitely-assigned sets after [`condition`](paramref) evaluates
    /// to true and to false, starting from [`assigned`](paramref). Mirrors
    /// C# §9.4.4: for `A && B` the right operand runs in the
    /// when-true state of the left, and the whole is false when either was
    /// (intersection); dually for `||`; `!` swaps.
    private func ClassifyConditionAssignments(
        condition BoundExpression,
        assigned HashSet[VariableSymbol],
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        tracked HashSet[VariableSymbol],
        flowContext ExpressionFlowContext
    )(WhenTrue HashSet[VariableSymbol], WhenFalse HashSet[VariableSymbol]) {
        switch condition {
            case unary is BoundUnaryExpression when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation {
                {
                    let (whenTrue, whenFalse) = ClassifyConditionAssignments(
                        unary.Operand,
                        assigned,
                        pointerAliases,
                        tracked,
                        flowContext
                    )
                    return (whenFalse, whenTrue)
                }
            }
            case binary is BoundBinaryExpression when binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd {
                {
                    let (leftTrue, leftFalse) = ClassifyConditionAssignments(
                        binary.Left,
                        assigned,
                        pointerAliases,
                        tracked,
                        flowContext
                    )
                    let (rightTrue, rightFalse) = ClassifyConditionAssignments(
                        binary.Right,
                        leftTrue,
                        pointerAliases,
                        tracked,
                        flowContext
                    )
                    return (rightTrue, Intersect(leftFalse, rightFalse))
                }
            }
            case binary is BoundBinaryExpression when binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr {
                {
                    let (leftTrue, leftFalse) = ClassifyConditionAssignments(
                        binary.Left,
                        assigned,
                        pointerAliases,
                        tracked,
                        flowContext
                    )
                    let (rightTrue, rightFalse) = ClassifyConditionAssignments(
                        binary.Right,
                        leftFalse,
                        pointerAliases,
                        tracked,
                        flowContext
                    )
                    return (Intersect(leftTrue, rightTrue), rightFalse)
                }
            }
            default {
                {
                    let after = HashSet[VariableSymbol](assigned)
                    ProcessExpression(
                        condition,
                        after,
                        nil,
                        Dictionary[VariableSymbol, VariableSymbol](pointerAliases),
                        tracked,
                        flowContext
                    )
                    return (after, after)
                }
            }
        }
    }

    private func FindMethodExitLabel(body BoundBlockStatement) BoundLabel? {
        if body
            .Statements
            .Length >= 2 &&
            body.Statements[^2] is BoundLabelStatement{Syntax: nil} label &&
            (body.Statements[^1] is BoundReturnStatement and {Syntax: nil}) {
            return label.Label
        }
        return nil
    }

    private func AsBlock(statement BoundStatement?) BoundBlockStatement {
        if statement is BoundBlockStatement block {
            return block
        }
        let statements = if statement == nil {
            ImmutableArray[BoundStatement].Empty
        } else {
            ImmutableArray.Create(statement)
        }
        return BoundBlockStatement(statement?.Syntax, statements)
    }

    private func GetReportLocation(block ControlFlowGraph.BasicBlock, function FunctionSymbol) TextLocation {
        for var i = block.Statements.Count - 1; i >= 0; i-- {
            let stmt = block.Statements[i]
            if stmt?.Syntax is {} syn {
                return syn.Location
            }
        }
        return function.Declaration?.Location ?? default(TextLocation)
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

    private func Intersect(a HashSet[VariableSymbol], b HashSet[VariableSymbol]) HashSet[VariableSymbol] {
        let result = HashSet[VariableSymbol](a)
        result.IntersectWith(b)
        return result
    }

    /// Walks a basic block linearly, updating [`assigned`](paramref)
    /// in place. When [`diagnostics`](paramref) is non-null, reports
    /// GS0239/GS0238/GS0522 at every detected violation (including ones
    /// nested inside try/select/scope/fixed bodies). Returns the exit set.
    private func SimulateBlock(
        block ControlFlowGraph.BasicBlock,
        assigned HashSet[VariableSymbol],
        outParams ImmutableArray[ParameterSymbol],
        function FunctionSymbol,
        diagnostics DiagnosticBag?,
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        tracked HashSet[VariableSymbol],
        methodExitLabel BoundLabel?
    ) HashSet[VariableSymbol] {
        for statement in block.Statements {
            ProcessStatement(
                statement,
                assigned,
                outParams,
                function,
                diagnostics,
                pointerAliases,
                tracked,
                methodExitLabel
            )
        }
        return assigned
    }

    private func ProcessStatement(
        statement BoundStatement,
        assigned HashSet[VariableSymbol],
        outParams ImmutableArray[ParameterSymbol],
        function FunctionSymbol,
        diagnostics DiagnosticBag?,
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        tracked HashSet[VariableSymbol],
        methodExitLabel BoundLabel?
    ) {
        let flowContext = ExpressionFlowContext(outParams, function, methodExitLabel)
        switch statement {
            case es is BoundExpressionStatement {
                ProcessExpression(es.Expression, assigned, diagnostics, pointerAliases, tracked, flowContext)
            }
            case vd is BoundVariableDeclaration {
                {
                    var definitelyAssigned = false
                    if vd.Initializer != nil {
                        ProcessExpression(vd.Initializer, assigned, diagnostics, pointerAliases, tracked, flowContext)
                        // Synthesised default expressions (BoundDefaultExpression)
                        // emitted for `var x T` without an explicit initializer
                        // should NOT count as definite assignment — Roslyn DA
                        // treats `int x;` as unassigned for the same reason. An
                        // EXPLICIT `= default` initializer DOES count: the user
                        // opted into the CLR default (ADR-0159's honesty clause
                        // keeps `default`'s CLR meaning).
                        if !(vd.Initializer is BoundDefaultExpression) ||
                            (vd.Syntax is VariableDeclarationSyntax and {Initializer: not nil}) {
                            assigned.Add(vd.Variable)
                            definitelyAssigned = true
                        }
                        TrackPointerAlias(vd.Variable, vd.Initializer!!, pointerAliases)
                    }
                    // Issue #3316: a declared-without-initializer local whose type
                    // has no usable zero value joins the GS0522 use-site check.
                    // Only user-declared locals qualify — parameters are assigned
                    // on entry, globals are static fields readable from any
                    // function or REPL cell (they keep the GS0520 declaration-site
                    // rule), and synthesized temps are the lowerer's business.
                    if !definitelyAssigned &&
                        vd.Variable is LocalVariableSymbol &&
                        MagicCollectionZeroValue.RequiresExplicitInitializer(vd.Variable.Type) {
                        tracked.Add(vd.Variable)
                    }
                }
            }
            case rs is BoundReturnStatement {
                if rs.Expression != nil {
                    ProcessExpression(rs.Expression, assigned, diagnostics, pointerAliases, tracked, flowContext)
                }
            }
            case th is BoundThrowStatement {
                ProcessExpression(th.Expression, assigned, diagnostics, pointerAliases, tracked, flowContext)
            }
            case BoundRethrowStatement { }
            case cgs is BoundConditionalGotoStatement {
                ProcessExpression(cgs.Condition, assigned, diagnostics, pointerAliases, tracked, flowContext)
            }
            case BoundLabelStatement, BoundGotoStatement { }
            case tryStmt is BoundTryStatement {
                ProcessTryStatement(
                    tryStmt,
                    assigned,
                    outParams,
                    function,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    methodExitLabel
                )
            }
            case fixedStmt is BoundFixedStatement {
                ProcessFixedStatement(
                    fixedStmt,
                    assigned,
                    outParams,
                    function,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    methodExitLabel
                )
            }
            case switchStmt is BoundPatternSwitchStatement {
                ProcessPatternSwitchStatement(
                    switchStmt,
                    assigned,
                    outParams,
                    function,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    methodExitLabel
                )
            }
            case awaitForRange is BoundAwaitForRangeStatement {
                // Issue #3316: the stream expression always evaluates; the
                // body runs zero or more times. Analyze the body as a nested
                // region (so an assign-then-use INSIDE the body resolves
                // precisely, and internal returns are checked against out
                // params like every other opaque region) but DISCARD its
                // exit set: the zero-iteration path contributes the untouched
                // incoming state, and since assignments are never killed the
                // loop back edge cannot shrink the body's entry set below the
                // pre-loop state — ignoring it is exact, not just
                // conservative.
                ProcessExpression(awaitForRange.Stream, assigned, diagnostics, pointerAliases, tracked, flowContext)
                AnalyzeRegion(
                    awaitForRange.Body,
                    assigned,
                    outParams,
                    function,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    methodExitLabel
                )
            }
            default {
                // Other opaque statement kinds (go/channel-send/yield) fall
                // through to the next statement at the CFG level too, and
                // carry expressions but no conditionally-executed bodies. The
                // report-only walker visits their expression operands — value
                // reads of tracked no-zero-value locals (GS0522) — and any
                // nested function literals, which require their own analysis.
                FunctionLiteralAndUseWalker(assigned, tracked, diagnostics, pointerAliases, flowContext).VisitStatement(
                    statement
                )
            }
        }
    }

    /// try/catch/finally semantics (mirrors C# definite assignment):
    /// - Each `catch` clause is analyzed as if entered at the very top of the try statement — an exception
    /// can occur before any try-body statement runs — so catch bodies never see try-body assignments.
    /// - An assignment made only in the try body (with no matching unconditional assignment in every catch)
    /// is NOT guaranteed after the statement, because an exception could have skipped it.
    /// - An assignment in `finally` IS guaranteed, because `finally` always runs before control can
    /// continue past the try statement.
    private func ProcessTryStatement(
        tryStmt BoundTryStatement,
        assigned HashSet[VariableSymbol],
        outParams ImmutableArray[ParameterSymbol],
        function FunctionSymbol,
        diagnostics DiagnosticBag?,
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        tracked HashSet[VariableSymbol],
        methodExitLabel BoundLabel?
    ) {
        let preTry = assigned
        let tryExit HashSet[VariableSymbol]? = AnalyzeRegion(
            tryStmt.TryBlock,
            preTry,
            outParams,
            function,
            diagnostics,
            pointerAliases,
            tracked,
            methodExitLabel
        )
        var meet HashSet[VariableSymbol]? = tryExit
        var anyReachable = tryExit != nil
        for clause in tryStmt.CatchClauses {
            let catchEntry = HashSet[VariableSymbol](preTry)
            if clause.Variable != nil {
                catchEntry.Add(clause.Variable)
            }
            let catchExit HashSet[VariableSymbol]? = AnalyzeRegion(
                clause.Body,
                catchEntry,
                outParams,
                function,
                diagnostics,
                pointerAliases,
                tracked,
                methodExitLabel
            )
            // ADR-0174 D6: a scope's synthesized handler only records the body
            // exception for a finally that always rethrows it, so it never
            // completes normally and contributes no fall-through state.
            if catchExit == nil || clause.ExitsThroughFinally {
                continue
            }
            anyReachable = true
            meet = if meet == nil {
                catchExit
            } else {
                Intersect(meet, catchExit)
            }
        }
        // If neither the try body nor any catch can complete normally, the
        // outer CFG's synthetic fall-through is unreachable. Unreachable is
        // the top state for a must analysis, so it cannot create a second,
        // false GS0238 at the function's synthetic final return.
        if anyReachable && meet != nil {
            assigned.Clear()
            assigned.UnionWith(meet)
        } else {
            assigned.UnionWith(outParams)
        }
        if tryStmt.FinallyBlock != nil {
            let finallyExit HashSet[VariableSymbol]? = AnalyzeRegion(
                tryStmt.FinallyBlock,
                assigned,
                outParams,
                function,
                diagnostics,
                pointerAliases,
                tracked,
                methodExitLabel
            )
            if finallyExit != nil {
                assigned.Clear()
                assigned.UnionWith(finallyExit)
            }
        }
    }

    /// The `fixed` body always runs (no branching), so its
    /// assignments flow through unconditionally once its synthetic pinned
    /// and pointer locals are seeded as assigned.
    private func ProcessFixedStatement(
        fixedStmt BoundFixedStatement,
        assigned HashSet[VariableSymbol],
        outParams ImmutableArray[ParameterSymbol],
        function FunctionSymbol,
        diagnostics DiagnosticBag?,
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        tracked HashSet[VariableSymbol],
        methodExitLabel BoundLabel?
    ) {
        let flowContext = ExpressionFlowContext(outParams, function, methodExitLabel)
        ProcessExpression(fixedStmt.PinnedSource, assigned, diagnostics, pointerAliases, tracked, flowContext)
        let entry = HashSet[VariableSymbol](assigned){fixedStmt.PinnedVariable, fixedStmt.PointerVariable}
        if fixedStmt.SourceVariable != nil {
            entry.Add(fixedStmt.SourceVariable)
        }
        let exit HashSet[VariableSymbol]? = AnalyzeRegion(
            fixedStmt.Body,
            entry,
            outParams,
            function,
            diagnostics,
            pointerAliases,
            tracked,
            methodExitLabel
        )
        if exit != nil {
            assigned.Clear()
            assigned.UnionWith(exit)
        }
    }

    /// A pattern switch, unlike `select`, can complete having matched no
    /// arm at all when there's no exhaustive `default` — that "nothing
    /// matched" path must also be in the meet (it contributes the untouched
    /// incoming [`assigned`](paramref) set).
    private func ProcessPatternSwitchStatement(
        switchStmt BoundPatternSwitchStatement,
        assigned HashSet[VariableSymbol],
        outParams ImmutableArray[ParameterSymbol],
        function FunctionSymbol,
        diagnostics DiagnosticBag?,
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        tracked HashSet[VariableSymbol],
        methodExitLabel BoundLabel?
    ) {
        let flowContext = ExpressionFlowContext(outParams, function, methodExitLabel)
        ProcessExpression(switchStmt.Discriminant, assigned, diagnostics, pointerAliases, tracked, flowContext)
        var meet HashSet[VariableSymbol]? = nil
        var any = false
        var hasDefault = false
        for arm in switchStmt.Arms {
            if arm.IsDefault {
                hasDefault = true
            }
            if arm.Guard != nil {
                ProcessExpression(arm.Guard, assigned, diagnostics, pointerAliases, tracked, flowContext)
            }
            let armExit HashSet[VariableSymbol]? = AnalyzeRegion(
                arm.Body,
                assigned,
                outParams,
                function,
                diagnostics,
                pointerAliases,
                tracked,
                methodExitLabel
            )
            if armExit == nil {
                continue
            }
            any = true
            meet = if meet == nil {
                armExit
            } else {
                Intersect(meet, armExit)
            }
        }
        if !hasDefault {
            meet = if meet == nil {
                HashSet[VariableSymbol](assigned)
            } else {
                Intersect(meet, assigned)
            }
            any = true
        }
        if hasDefault && !any {
            // Every exhaustive arm terminates inside its recursively analyzed
            // region. The outer CFG models pattern switches as opaque and still
            // carries a synthetic fall-through edge, so mark out parameters as
            // assigned on that unreachable continuation. Any real return missing
            // an assignment was already reported while analyzing its arm.
            assigned.UnionWith(outParams)
            return
        }
        if any && meet != nil {
            assigned.Clear()
            assigned.UnionWith(meet)
        }
    }

    /// Best-effort `pointerVar = &localVar` alias tracking for
    /// (cref:BoundIndirectAssignmentExpression) (issue #1642): records
    /// (or drops, on reassignment to something else) which local variable a
    /// pointer variable's address-of assignment targets. Intentionally
    /// narrow — no aliasing through arithmetic, field access, or indirection
    /// chains — and not merged across CFG joins (best-effort, shared per
    /// function rather than tracked per-path); this only needs to catch the
    /// common straight-line `var p = &v; *p = expr` pattern.
    private func TrackPointerAlias(
        pointerVar VariableSymbol?,
        rhs BoundExpression,
        pointerAliases Dictionary[VariableSymbol, VariableSymbol]
    ) {
        if pointerVar == nil {
            return
        }
        let address = rhs as BoundAddressOfExpression
        let variable BoundVariableExpression? = address?.Operand as BoundVariableExpression
        if variable != nil {
            pointerAliases[pointerVar] = variable.Variable
        } else {
            pointerAliases.Remove(pointerVar)
        }
    }

    private func TryResolvePointerTarget(
        pointerExpr BoundExpression,
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        out target VariableSymbol?
    ) bool {
        let address = pointerExpr as BoundAddressOfExpression
        let variable BoundVariableExpression? = address?.Operand as BoundVariableExpression
        if variable != nil {
            target = variable.Variable
            return true
        }
        let pointerVariable BoundVariableExpression? = pointerExpr as BoundVariableExpression
        if pointerVariable != nil && pointerAliases.TryGetValue(pointerVariable.Variable, out var aliasedTarget) {
            target = aliasedTarget
            return true
        }
        target = nil
        return false
    }

    /// Issue #3316: reports GS0522 when a value read of a tracked
    /// no-zero-value local (a bare `chan T` local declared without an
    /// initializer) is reachable while the local may still be unassigned.
    /// Reporting happens only in the final diagnostics pass, once every
    /// declaration in the function has populated the tracked set.
    private func CheckTrackedUse(
        read BoundVariableExpression,
        assigned HashSet[VariableSymbol],
        tracked HashSet[VariableSymbol],
        diagnostics DiagnosticBag?
    ) {
        if diagnostics == nil || read.Variable == nil || !tracked.Contains(read.Variable) || assigned.Contains(
            read.Variable
        ) {
            return
        }
        if NativeProtocolMetadata.IsProtocol(read.Variable.Type) {
            diagnostics.ReportNativeProtocol(
                read.Syntax?.Location ?? default(TextLocation),
                "'${read.Variable.Name}' must contain a present protocol value on every path before use"
            )
        } else if ManagedReferenceTypes.TryGetElement(read.Variable.Type, out _, out _) {
            diagnostics.ReportManagedReference(
                read.Syntax?.Location ?? default(TextLocation),
                "'${read.Variable.Name}' must be assigned on every path before use"
            )
        } else {
            diagnostics.ReportChannelLocalUsedBeforeAssignment(
                read.Syntax?.Location ?? default(TextLocation),
                read.Variable.Name,
                read.Variable.Type.Name
            )
        }
    }

    private func ProcessExpression(
        expression BoundExpression?,
        assigned HashSet[VariableSymbol],
        diagnostics DiagnosticBag?,
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        tracked HashSet[VariableSymbol],
        flowContext ExpressionFlowContext? = nil
    ) {
        if expression == nil {
            return
        }
        switch expression {
            case block is BoundBlockExpression when flowContext is {} context {
                {
                    let statements = block.Statements.Add(
                        BoundExpressionStatement(block.Expression.Syntax, block.Expression)
                    )
                    let exit HashSet[VariableSymbol]? = AnalyzeRegion(
                        BoundBlockStatement(block.Syntax, statements),
                        assigned,
                        context.OutParams,
                        context.Function,
                        diagnostics,
                        pointerAliases,
                        tracked,
                        context.MethodExitLabel,
                        cacheKey: block
                    )
                    assigned.Clear()
                    if exit != nil {
                        assigned.UnionWith(exit)
                    } else {
                        // No normal completion: unreachable is top for this
                        // forward must analysis.
                        assigned.UnionWith(context.OutParams)
                        assigned.UnionWith(tracked)
                    }
                }
            }
            case read is BoundVariableExpression {
                // Issue #3316: a direct value read of a tracked no-zero-value
                // local. (Reads nested inside expression kinds without an
                // explicit case here are found by FunctionLiteralAndUseWalker
                // via the default arm.)
                CheckTrackedUse(read, assigned, tracked, diagnostics)
            }
            case call is BoundCallExpression {
                ProcessCallArguments(
                    call.Arguments,
                    call.Function.Parameters,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    call.Syntax,
                    flowContext
                )
            }
            case call is BoundImportedCallExpression {
                ProcessCallArguments(
                    call.Arguments,
                    call.ArgumentRefKinds,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    call.Syntax,
                    flowContext
                )
            }
            case call is BoundImportedInstanceCallExpression {
                ProcessExpression(call.Receiver, assigned, diagnostics, pointerAliases, tracked, flowContext)
                ProcessCallArguments(
                    call.Arguments,
                    call.ArgumentRefKinds,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    call.Syntax,
                    flowContext
                )
            }
            case call is BoundConstrainedStaticCallExpression {
                if call.InterfaceMethod != nil {
                    ProcessCallArguments(
                        call.Arguments,
                        call.InterfaceMethod.Parameters,
                        assigned,
                        diagnostics,
                        pointerAliases,
                        tracked,
                        call.Syntax,
                        flowContext
                    )
                } else {
                    // Issue #3525: the imported-CLR-interface shape has no
                    // ParameterSymbol list, only reflection ArgumentRefKinds.
                    ProcessCallArguments(
                        call.Arguments,
                        call.ArgumentRefKinds,
                        assigned,
                        diagnostics,
                        pointerAliases,
                        tracked,
                        call.Syntax,
                        flowContext
                    )
                }
            }
            case call is BoundConstructorCallExpression {
                let constructorParameters = if call.SelectedConstructor != nil {
                    call.SelectedConstructor.Parameters
                } else {
                    call.StructType.PrimaryConstructorParameters
                }
                ProcessCallArguments(
                    call.Arguments,
                    constructorParameters,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    call.Syntax,
                    flowContext
                )
            }
            case call is BoundConstructorChainingExpression {
                ProcessCallArguments(
                    call.Arguments,
                    call.SelectedConstructor.Parameters,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    call.Syntax,
                    flowContext
                )
            }
            case call is BoundUserInstanceCallExpression {
                ProcessExpression(call.Receiver, assigned, diagnostics, pointerAliases, tracked, flowContext)
                ProcessCallArguments(
                    call.Arguments,
                    call.Method.Parameters,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    call.Syntax,
                    flowContext
                )
            }
            case call is BoundBaseInterfaceCallExpression {
                ProcessExpression(call.Receiver, assigned, diagnostics, pointerAliases, tracked, flowContext)
                ProcessCallArguments(
                    call.Arguments,
                    call.Method.Parameters,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    call.Syntax,
                    flowContext
                )
            }
            case call is BoundBaseClassCallExpression {
                ProcessExpression(call.Receiver, assigned, diagnostics, pointerAliases, tracked, flowContext)
                ProcessCallArguments(
                    call.Arguments,
                    call.Method?.Parameters ?? ImmutableArray[ParameterSymbol].Empty,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    call.Syntax,
                    flowContext
                )
            }
            case call is BoundIndirectCallExpression {
                ProcessExpression(call.Target, assigned, diagnostics, pointerAliases, tracked, flowContext)
                ProcessCallArguments(
                    call.Arguments,
                    call.ArgumentRefKinds,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    call.Syntax,
                    flowContext
                )
            }
            case call is BoundClrConstructorCallExpression {
                ProcessCallArguments(
                    call.Arguments,
                    call.ArgumentRefKinds,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    call.Syntax,
                    flowContext
                )
            }
            case call is BoundClrConversionCallExpression {
                ProcessExpression(call.Source, assigned, diagnostics, pointerAliases, tracked, flowContext)
            }
            case assign is BoundAssignmentExpression {
                ProcessExpression(assign.Expression, assigned, diagnostics, pointerAliases, tracked, flowContext)
                assigned.Add(assign.Variable)
                TrackPointerAlias(assign.Variable, assign.Expression, pointerAliases)
            }
            case indirect is BoundIndirectAssignmentExpression {
                ProcessExpression(indirect.Value, assigned, diagnostics, pointerAliases, tracked, flowContext)
                ProcessExpression(indirect.Pointer, assigned, diagnostics, pointerAliases, tracked, flowContext)
                if TryResolvePointerTarget(indirect.Pointer, pointerAliases, out var indirectTarget) {
                    if indirectTarget != nil {
                        assigned.Add(indirectTarget)
                    }
                }
            }
            case bin is BoundBinaryExpression when(
                bin
                    .Op
                    .Kind is BoundBinaryOperatorKind.LogicalAnd or
                    BoundBinaryOperatorKind.LogicalOr or
                    BoundBinaryOperatorKind.NullCoalesce
            ) {
                {
                    ProcessExpression(bin.Left, assigned, diagnostics, pointerAliases, tracked, flowContext)
                    let rightAssigned = HashSet[VariableSymbol](assigned)
                    let rightAliases = Dictionary[VariableSymbol, VariableSymbol](pointerAliases)
                    ProcessExpression(bin.Right, rightAssigned, diagnostics, rightAliases, tracked, flowContext)
                }
            }
            case bin is BoundBinaryExpression {
                ProcessExpression(bin.Left, assigned, diagnostics, pointerAliases, tracked, flowContext)
                ProcessExpression(bin.Right, assigned, diagnostics, pointerAliases, tracked, flowContext)
            }
            case conditional is BoundConditionalExpression {
                {
                    ProcessExpression(
                        conditional.Condition,
                        assigned,
                        diagnostics,
                        pointerAliases,
                        tracked,
                        flowContext
                    )
                    let whenTrueAssigned = HashSet[VariableSymbol](assigned)
                    let whenTrueAliases = Dictionary[VariableSymbol, VariableSymbol](pointerAliases)
                    ProcessExpression(
                        conditional.WhenTrue,
                        whenTrueAssigned,
                        diagnostics,
                        whenTrueAliases,
                        tracked,
                        flowContext
                    )
                    let whenFalseAssigned = HashSet[VariableSymbol](assigned)
                    let whenFalseAliases = Dictionary[VariableSymbol, VariableSymbol](pointerAliases)
                    ProcessExpression(
                        conditional.WhenFalse,
                        whenFalseAssigned,
                        diagnostics,
                        whenFalseAliases,
                        tracked,
                        flowContext
                    )
                    MergeConditionalFlow(
                        assigned,
                        pointerAliases,
                        []HashSet[VariableSymbol]{whenTrueAssigned, whenFalseAssigned},
                        []Dictionary[VariableSymbol, VariableSymbol]{whenTrueAliases, whenFalseAliases}
                    )
                }
            }
            case conditionalAddress is BoundConditionalAddressExpression {
                {
                    ProcessExpression(
                        conditionalAddress.Condition,
                        assigned,
                        diagnostics,
                        pointerAliases,
                        tracked,
                        flowContext
                    )
                    let whenTrueAssigned = HashSet[VariableSymbol](assigned)
                    let whenTrueAliases = Dictionary[VariableSymbol, VariableSymbol](pointerAliases)
                    ProcessExpression(
                        conditionalAddress.WhenTrueOperand,
                        whenTrueAssigned,
                        diagnostics,
                        whenTrueAliases,
                        tracked,
                        flowContext
                    )
                    let whenFalseAssigned = HashSet[VariableSymbol](assigned)
                    let whenFalseAliases = Dictionary[VariableSymbol, VariableSymbol](pointerAliases)
                    ProcessExpression(
                        conditionalAddress.WhenFalseOperand,
                        whenFalseAssigned,
                        diagnostics,
                        whenFalseAliases,
                        tracked,
                        flowContext
                    )
                    MergeConditionalFlow(
                        assigned,
                        pointerAliases,
                        []HashSet[VariableSymbol]{whenTrueAssigned, whenFalseAssigned},
                        []Dictionary[VariableSymbol, VariableSymbol]{whenTrueAliases, whenFalseAliases}
                    )
                }
            }
            case switchExpression is BoundSwitchExpression {
                {
                    ProcessExpression(
                        switchExpression.Discriminant,
                        assigned,
                        diagnostics,
                        pointerAliases,
                        tracked,
                        flowContext
                    )
                    let armAssigned = List[HashSet[VariableSymbol]](switchExpression.Arms.Length)
                    let armAliases = List[Dictionary[VariableSymbol, VariableSymbol]](switchExpression.Arms.Length)
                    var dispatchAssigned = HashSet[VariableSymbol](assigned)
                    var dispatchAliases = Dictionary[VariableSymbol, VariableSymbol](pointerAliases)
                    var canMiss = true
                    for arm in switchExpression.GetDispatchArms() {
                        let guardAssigned = HashSet[VariableSymbol](dispatchAssigned)
                        let guardAliases = Dictionary[VariableSymbol, VariableSymbol](dispatchAliases)
                        ProcessExpression(arm.Guard, guardAssigned, diagnostics, guardAliases, tracked, flowContext)
                        let currentAssigned = HashSet[VariableSymbol](guardAssigned)
                        let currentAliases = Dictionary[VariableSymbol, VariableSymbol](guardAliases)
                        ProcessExpression(
                            arm.Result,
                            currentAssigned,
                            diagnostics,
                            currentAliases,
                            tracked,
                            flowContext
                        )
                        armAssigned.Add(currentAssigned)
                        armAliases.Add(currentAliases)
                        if arm.IsCatchAll {
                            canMiss = false
                            break
                        }
                        if arm.Guard != nil {
                            if arm.PatternMatchesAllInputs {
                                dispatchAssigned = guardAssigned
                                dispatchAliases = guardAliases
                            } else {
                                MergeConditionalFlow(
                                    dispatchAssigned,
                                    dispatchAliases,
                                    []HashSet[VariableSymbol]{HashSet[VariableSymbol](dispatchAssigned), guardAssigned},
                                    []Dictionary[VariableSymbol, VariableSymbol]{
                                        Dictionary[VariableSymbol, VariableSymbol](dispatchAliases),
                                        guardAliases
                                    }
                                )
                            }
                        }
                    }
                    // A void switch can complete unmatched, after running
                    // guards. A value-producing unmatched switch throws.
                    if switchExpression.Type == TypeSymbol.Void && canMiss {
                        armAssigned.Add(dispatchAssigned)
                        armAliases.Add(dispatchAliases)
                    }
                    if armAssigned.Count > 0 {
                        MergeConditionalFlow(assigned, pointerAliases, armAssigned, armAliases)
                    }
                }
            }
            case nullConditional is BoundNullConditionalAccessExpression {
                {
                    ProcessExpression(
                        nullConditional.Receiver,
                        assigned,
                        diagnostics,
                        pointerAliases,
                        tracked,
                        flowContext
                    )
                    let whenNotNullAssigned = HashSet[VariableSymbol](assigned)
                    let whenNotNullAliases = Dictionary[VariableSymbol, VariableSymbol](pointerAliases)
                    ProcessExpression(
                        nullConditional.WhenNotNull,
                        whenNotNullAssigned,
                        diagnostics,
                        whenNotNullAliases,
                        tracked,
                        flowContext
                    )
                }
            }
            case un is BoundUnaryExpression {
                ProcessExpression(un.Operand, assigned, diagnostics, pointerAliases, tracked, flowContext)
            }
            case aof is BoundAddressOfExpression {
                ProcessExpression(aof.Operand, assigned, diagnostics, pointerAliases, tracked, flowContext)
            }
            case deref is BoundDereferenceExpression {
                ProcessExpression(deref.Operand, assigned, diagnostics, pointerAliases, tracked, flowContext)
            }
            case conv is BoundConversionExpression {
                ProcessExpression(conv.Expression, assigned, diagnostics, pointerAliases, tracked, flowContext)
            }
            default {
                FunctionLiteralAndUseWalker(
                    assigned,
                    tracked,
                    diagnostics,
                    pointerAliases,
                    flowContext
                ).VisitExpression(expression)
            }
        }
    }

    private func MergeConditionalFlow(
        assigned HashSet[VariableSymbol],
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        branchAssigned IReadOnlyList[HashSet[VariableSymbol]],
        branchAliases IReadOnlyList[Dictionary[VariableSymbol, VariableSymbol]]
    ) {
        assigned.Clear()
        assigned.UnionWith(branchAssigned[0])
        for var i = 1; i < branchAssigned.Count; i++ {
            assigned.IntersectWith(branchAssigned[i])
        }
        pointerAliases.Clear()
        for pair in branchAliases[0] {
            if branchAliases.Skip(1).All(
                (aliases Dictionary[VariableSymbol, VariableSymbol]) -> aliases.TryGetValue(pair.Key, out var target) &&
                    object.ReferenceEquals(target, pair.Value)
            ) {
                pointerAliases.Add(pair.Key, pair.Value)
            }
        }
    }

    private func ProcessCallArguments(
        arguments ImmutableArray[BoundExpression],
        parameters ImmutableArray[ParameterSymbol],
        assigned HashSet[VariableSymbol],
        diagnostics DiagnosticBag?,
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        tracked HashSet[VariableSymbol],
        callSyntax SyntaxNode?,
        flowContext ExpressionFlowContext?
    ) {
        // An explicit receiver parameter is part of the signature but not of
        // the bound argument list (OverloadResolver's parameterOffset).
        let offset = if parameters.Length == arguments.Length + 1 && parameters[0].IsReceiverParameter {
            1
        } else {
            0
        }
        for var i = 0; i < arguments.Length; i++ {
            let refKind = if i + offset < parameters.Length {
                parameters[i + offset].RefKind
            } else {
                RefKind.None
            }
            ProcessCallArgument(
                arguments[i],
                refKind,
                assigned,
                diagnostics,
                pointerAliases,
                tracked,
                callSyntax,
                flowContext,
                i + 1
            )
        }
    }

    private func ProcessCallArguments(
        arguments ImmutableArray[BoundExpression],
        refKinds ImmutableArray[RefKind],
        assigned HashSet[VariableSymbol],
        diagnostics DiagnosticBag?,
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        tracked HashSet[VariableSymbol],
        callSyntax SyntaxNode?,
        flowContext ExpressionFlowContext?
    ) {
        for var i = 0; i < arguments.Length; i++ {
            let refKind = if !refKinds.IsDefault && i < refKinds.Length {
                refKinds[i]
            } else {
                RefKind.None
            }
            ProcessCallArgument(
                arguments[i],
                refKind,
                assigned,
                diagnostics,
                pointerAliases,
                tracked,
                callSyntax,
                flowContext,
                i + 1
            )
        }
    }

    private func ProcessCallArgument(
        argument BoundExpression,
        refKind RefKind,
        assigned HashSet[VariableSymbol],
        diagnostics DiagnosticBag?,
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        tracked HashSet[VariableSymbol],
        callSyntax SyntaxNode?,
        flowContext ExpressionFlowContext?,
        argumentNumber int32
    ) {
        // Issue #4400 fail-safe: every call path should have turned the
        // argument of a by-ref slot into an address (an implicit `in`
        // reference, or GS0235 for `ref`/`out`). Should some binding path
        // still hand over a plain value, report it here — every call shape
        // with by-ref parameters funnels through this analysis — rather than
        // let the emitter push a value where the callee expects an address.
        if refKind != RefKind.None &&
            (
            ConversionClassifier.IsPlainValueArgument(argument) ||
                ClrOverloadResolution.IsUnresolvedMethodGroupArgument(argument)
        ) {
            diagnostics?.ReportArgumentMustBePassedByRef(
                argument.Syntax?.Location ?? callSyntax?.Location ?? default(TextLocation),
                argumentNumber,
                if callSyntax is CallExpressionSyntax{Identifier: {Text: {Length: > 0} calleeName}} {
                    calleeName
                } else {
                    "the callee"
                }
            )
            return
        }
        // Issue #4400: an `in` argument — written `in x` or passed implicitly —
        // only lets the callee READ the storage, so it is analyzed exactly as a
        // value read of the operand (the same checks `f(x)` gets).
        if refKind == RefKind.In && argument is BoundAddressOfExpression inAddress {
            ProcessExpression(inAddress.Operand, assigned, diagnostics, pointerAliases, tracked, flowContext)
            return
        }
        if refKind != RefKind.None &&
            argument is BoundAddressOfExpression address &&
            TryGetSingleAddressedVariable(address.Operand, out var variable) {
            ProcessAddressEvaluation(address.Operand, assigned, diagnostics, pointerAliases, tracked, flowContext)
            if refKind == RefKind.Ref && !assigned.Contains(variable!!) {
                diagnostics?.ReportVariableNotAssignedBeforeRef(
                    argument.Syntax?.Location ?? callSyntax?.Location ?? default(TextLocation),
                    variable!!.Name
                )
            }
            if refKind == RefKind.Ref || refKind == RefKind.Out {
                assigned.Add(variable!!)
            }
            return
        }
        ProcessExpression(argument, assigned, diagnostics, pointerAliases, tracked, flowContext)
    }

    private func TryGetSingleAddressedVariable(
        expression BoundExpression,
        @NotNullWhen(true) out variable VariableSymbol?
    ) bool {
        switch expression {
            case block is BoundBlockExpression {
                return TryGetSingleAddressedVariable(block.Expression, out variable)
            }
            case variableExpression is BoundVariableExpression {
                variable = variableExpression.Variable
                return true
            }
            case conditional is BoundConditionalExpression when TryGetSingleAddressedVariable(
                conditional.WhenTrue,
                out var whenTrue
            ) &&
                TryGetSingleAddressedVariable(conditional.WhenFalse, out var whenFalse) &&
                object.ReferenceEquals(whenTrue, whenFalse) {
                variable = whenTrue
                return true
            }
            default {
                variable = nil
                return false
            }
        }
    }

    private func ProcessAddressEvaluation(
        expression BoundExpression,
        assigned HashSet[VariableSymbol],
        diagnostics DiagnosticBag?,
        pointerAliases Dictionary[VariableSymbol, VariableSymbol],
        tracked HashSet[VariableSymbol],
        flowContext ExpressionFlowContext?
    ) {
        switch expression {
            case block is BoundBlockExpression when flowContext is {} context {
                {
                    let exit HashSet[VariableSymbol]? = AnalyzeRegion(
                        BoundBlockStatement(block.Syntax, block.Statements),
                        assigned,
                        context.OutParams,
                        context.Function,
                        diagnostics,
                        pointerAliases,
                        tracked,
                        context.MethodExitLabel,
                        cacheKey: NotCacheable
                    )
                    assigned.Clear()
                    if exit != nil {
                        assigned.UnionWith(exit)
                        ProcessAddressEvaluation(
                            block.Expression,
                            assigned,
                            diagnostics,
                            pointerAliases,
                            tracked,
                            flowContext
                        )
                    } else {
                        assigned.UnionWith(context.OutParams)
                        assigned.UnionWith(tracked)
                    }
                }
            }
            case conditional is BoundConditionalExpression {
                {
                    ProcessExpression(
                        conditional.Condition,
                        assigned,
                        diagnostics,
                        pointerAliases,
                        tracked,
                        flowContext
                    )
                    let whenTrueAssigned = HashSet[VariableSymbol](assigned)
                    let whenTrueAliases = Dictionary[VariableSymbol, VariableSymbol](pointerAliases)
                    ProcessAddressEvaluation(
                        conditional.WhenTrue,
                        whenTrueAssigned,
                        diagnostics,
                        whenTrueAliases,
                        tracked,
                        flowContext
                    )
                    let whenFalseAssigned = HashSet[VariableSymbol](assigned)
                    let whenFalseAliases = Dictionary[VariableSymbol, VariableSymbol](pointerAliases)
                    ProcessAddressEvaluation(
                        conditional.WhenFalse,
                        whenFalseAssigned,
                        diagnostics,
                        whenFalseAliases,
                        tracked,
                        flowContext
                    )
                    MergeConditionalFlow(
                        assigned,
                        pointerAliases,
                        []HashSet[VariableSymbol]{whenTrueAssigned, whenFalseAssigned},
                        []Dictionary[VariableSymbol, VariableSymbol]{whenTrueAliases, whenFalseAliases}
                    )
                }
            }
            case BoundVariableExpression { }
            default {
                ProcessExpression(expression, assigned, diagnostics, pointerAliases, tracked, flowContext)
            }
        }
    }
}
