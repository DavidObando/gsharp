// <copyright file="RefStructAsyncLivenessAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

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
    internal var LastAnalyzedProgramSuppressionIndexedCount int32

    /// Completes deferred operand checks after inference for every function body and initializer root.
    /// @param functions The rewritten function bodies in source order.
    /// @param statement The complete top-level body, including library initializers.
    /// @param structs The user and synthesized types.
    /// @param interfaces The user interfaces.
    /// @param diagnostics Existing and new compilation diagnostics.
    /// @param references The compilation references used by async preparation.
    func AnalyzeProgram(
        functions ImmutableArray[KeyValuePair[FunctionSymbol, BoundBlockStatement]],
        statement BoundBlockStatement,
        structs ImmutableArray[StructSymbol],
        interfaces ImmutableArray[InterfaceSymbol],
        diagnostics ImmutableArray[Diagnostic].Builder,
        references ReferenceResolver?
    ) {
        let bag = DiagnosticBag()
        bag.AddRange(diagnostics)
        let existingCount = bag.Count
        for (function, body) in functions {
            bag.SuppressDuplicateDiagnostics(
                () -> {
                    Analyze(body.PreEmitAnalysisBody ?? body, function, bag, references)
                    return 0
                }
            )
        }
        let finder = AsyncLambdaScopeFinder(bag, references, includeOperandTemporaries: true)
        let VisitRoot = (root BoundNode?) -> bag.SuppressDuplicateDiagnostics(
            () -> {
                finder.Visit(root)
                return 0
            }
        )
        VisitRoot(statement)
        for type in structs {
            for (_, initializer) in BoundProgramOrder.FieldInitializers(type.InstanceFieldInitializers) {
                VisitRoot(initializer)
            }
            for (_, initializer) in BoundProgramOrder.FieldInitializers(type.StaticFieldInitializers) {
                VisitRoot(initializer)
            }
            for initializer in type.StaticInitializerStatements {
                VisitRoot(initializer)
            }
            if type.BaseConstructorInitializer is {} initializer {
                for argument in initializer.Arguments {
                    VisitRoot(argument)
                }
            }
            for constructor in type.ExplicitConstructors {
                if constructor.BaseInitializer is {} initializer {
                    for argument in initializer.Arguments {
                        VisitRoot(argument)
                    }
                }
            }
        }
        for type in interfaces {
            for (_, initializer) in BoundProgramOrder.FieldInitializers(type.StaticFieldInitializers) {
                VisitRoot(initializer)
            }
        }
        LastAnalyzedProgramSuppressionIndexedCount = bag.DuplicateSuppressionIndexedCount
        diagnostics.AddRange(bag.Skip(existingCount))
    }

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

        protected override func VisitBlockExpression(node BoundBlockExpression) {
            // Expression-scoped locals cannot cross suspension outside their own block.
            if AsyncBoundTreeQueries.HasAwait(node) || BodyFacts.ContainsYield(BoundExpressionStatement(nil, node)) {
                base.VisitBlockExpression(node)
            }
        }

        protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
            Record(node.Variable)
            base.VisitVariableDeclaration(node)
        }

        protected override func VisitIsExpression(node BoundIsExpression) {
            Record(node.InputVariable)
            base.VisitIsExpression(node)
        }

        override func VisitPattern(node BoundPattern?) {
            if node == nil {
                return
            }
            switch node {
                case BoundDiscardPattern{Variable: {} variable} {
                    Record(variable)
                }
                case tp is BoundTypePattern {
                    if tp.HasBinding || tp.PropertyPattern != nil {
                        Record(tp.Variable)
                    }
                }
                case pp is BoundPropertyPattern {
                    Record(pp.InputVariable)
                    Record(pp.UnwrappedVariable)
                    for field in pp.Fields {
                        Record(field.ValueVariable)
                    }
                }
                case rp is BoundRelationalPattern {
                    Record(rp.InputVariable)
                    Record(rp.ValueVariable)
                }
                case lp is BoundListPattern {
                    Record(lp.InputVariable)
                }
                case slice is BoundSlicePattern {
                    Record(slice.Variable)
                }
            }
            base.VisitPattern(node)
        }

        private func Record(variable VariableSymbol?) {
            if variable is LocalVariableSymbol local &&
                (
                RefStructAsyncLivenessAnalyzer.IsNativeRefAlias(local) ||
                    (collectByRefLikeLocals && TypeSymbol.IsByRefLike(local.Type))
            ) {
                Locals.Add(local)
            } else if collectByRefLikeLocals &&
                variable is GlobalVariableSymbol global &&
                global
                .RequiresEntryPointLocalStorage {
                // ADR-0228 / #6169: top-level by-ref-like and managed-pointer
                // globals live in <Main>$ locals (neither hoisted to state-machine
                // fields nor reconstructed by RefInitializationHoister).
                Locals.Add(global)
            }
        }
    }

    /// Collects reads (restricted to a fixed "interesting" set of variables)
    /// and whether an `await` occurs anywhere within one expression subtree.
    /// Relies on (cref:BoundTreeWalker)'s default recursion for
    /// everything except assignment targets (correctly not a read) and
    /// function-literal bodies (a separate scope, opaque by design).
    private class ReadAndAwaitCollector : BoundTreeWalker {
        private let interesting HashSet[VariableSymbol]
        private let pointsTo Dictionary[VariableSymbol, HashSet[VariableSymbol]]
        private let definitelyOverwritten HashSet[VariableSymbol]
        private let escapingLabelLiveIn IReadOnlyDictionary[BoundLabel, HashSet[VariableSymbol]]?

        init(
            interesting HashSet[VariableSymbol],
            aliasDependencies IReadOnlyDictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil,
            overwrittenAtEntry HashSet[VariableSymbol]? = nil,
            escapingLabelLiveIn IReadOnlyDictionary[BoundLabel, HashSet[VariableSymbol]]? = nil
        ) {
            Reads = HashSet[VariableSymbol]()
            PatternKills = HashSet[VariableSymbol]()
            InternalUnsafeVariables = HashSet[VariableSymbol]()
            OutgoingGotoOverwrites = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
            HasNormalExit = true
            this.interesting = interesting
            this.pointsTo = RefStructAsyncLivenessAnalyzer.ClonePointsTo(aliasDependencies)
            this.definitelyOverwritten = if overwrittenAtEntry != nil {
                HashSet[VariableSymbol](overwrittenAtEntry)
            } else {
                HashSet[VariableSymbol]()
            }
            this.escapingLabelLiveIn = escapingLabelLiveIn
        }

        prop Reads HashSet[VariableSymbol] {
            get;
        }

        prop PatternKills HashSet[VariableSymbol] {
            get;
        }

        prop InternalUnsafeVariables HashSet[VariableSymbol] {
            get;
        }

        prop OutgoingGotoOverwrites Dictionary[BoundLabel, HashSet[VariableSymbol]] {
            get;
        }

        prop ContainsAwait bool {
            get;
            private set;
        }

        prop HasNormalExit bool {
            get;
            private set;
        }

        private func MergeOutgoingGotoOverwrites(source Dictionary[BoundLabel, HashSet[VariableSymbol]]) {
            for entry in source {
                if !OutgoingGotoOverwrites.TryGetValue(entry.Key, out var sink) {
                    OutgoingGotoOverwrites[entry.Key] = HashSet[VariableSymbol](entry.Value)
                } else {
                    sink.IntersectWith(entry.Value)
                }
            }
        }

        private func RecordRead(variable VariableSymbol?) {
            if variable == nil {
                return
            }
            if interesting.Contains(variable) && !definitelyOverwritten.Contains(variable) {
                Reads.Add(variable)
            }
            if pointsTo.TryGetValue(variable, out var dependencies) {
                for dep in dependencies {
                    if !definitelyOverwritten.Contains(dep) {
                        Reads.Add(dep)
                    }
                }
            }
        }

        private func RecordOverwrite(variable VariableSymbol, allowNativeRefAlias bool = false) {
            if interesting.Contains(variable) &&
                (allowNativeRefAlias || !RefStructAsyncLivenessAnalyzer.IsNativeRefAlias(variable)) {
                definitelyOverwritten.Add(variable)
                if !Reads.Contains(variable) {
                    PatternKills.Add(variable)
                }
            }
        }

        override func VisitExpression(node BoundExpression?) {
            if node == nil {
                return
            }
            if node is BoundVariableExpression variableExpression {
                RecordRead(variableExpression.Variable)
            }
            base.VisitExpression(node)
        }

        protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
            if node.Initializer is {} initializer {
                let prePts = RefStructAsyncLivenessAnalyzer.ClonePointsTo(pointsTo)
                VisitExpression(initializer)
                if node.Variable.Type is ByRefTypeSymbol || RefStructAsyncLivenessAnalyzer.IsNativeRefAlias(
                    node.Variable
                ) {
                    let resolved = RefStructAsyncLivenessAnalyzer.PointsToExpressionUpdater(prePts, interesting)
                        .ResolveTargets(initializer)
                    RefStructAsyncLivenessAnalyzer.SetPointsTo(node.Variable, resolved, pointsTo, exceptionalUnion: nil)
                }
                RecordOverwrite(node.Variable, allowNativeRefAlias: true)
                return
            }
            base.VisitVariableDeclaration(node)
        }

        protected override func VisitAssignmentExpression(node BoundAssignmentExpression) {
            let prePts = RefStructAsyncLivenessAnalyzer.ClonePointsTo(pointsTo)
            VisitExpression(node.Expression)
            if node.Variable.Type is ByRefTypeSymbol {
                let resolved = RefStructAsyncLivenessAnalyzer.PointsToExpressionUpdater(prePts, interesting)
                    .ResolveTargets(node.Expression)
                RefStructAsyncLivenessAnalyzer.SetPointsTo(node.Variable, resolved, pointsTo, exceptionalUnion: nil)
            }
            RecordOverwrite(node.Variable)
        }

        override func VisitStatement(node BoundStatement?) {
            if node == nil {
                return
            }
            if node is BoundGotoStatement gs {
                if !OutgoingGotoOverwrites.TryGetValue(gs.Label, out var sink) {
                    OutgoingGotoOverwrites[gs.Label] = HashSet[VariableSymbol](definitelyOverwritten)
                } else {
                    sink.IntersectWith(definitelyOverwritten)
                }
                if escapingLabelLiveIn != nil && escapingLabelLiveIn.TryGetValue(gs.Label, out var targetLive) {
                    for v in targetLive {
                        if !definitelyOverwritten.Contains(v) {
                            Reads.Add(v)
                        }
                    }
                }
                return
            }
            if node is BoundConditionalGotoStatement cgs {
                VisitExpression(cgs.Condition)
                if !OutgoingGotoOverwrites.TryGetValue(cgs.Label, out var sink) {
                    OutgoingGotoOverwrites[cgs.Label] = HashSet[VariableSymbol](definitelyOverwritten)
                } else {
                    sink.IntersectWith(definitelyOverwritten)
                }
                if escapingLabelLiveIn != nil && escapingLabelLiveIn.TryGetValue(cgs.Label, out var targetLive) {
                    for v in targetLive {
                        if !definitelyOverwritten.Contains(v) {
                            Reads.Add(v)
                        }
                    }
                }
                return
            }
            base.VisitStatement(node)
        }

        protected override func VisitThrowExpression(node BoundThrowExpression) {
            base.VisitThrowExpression(node)
            HasNormalExit = false
        }

        private func VisitConditionalPair(
            condition BoundExpression,
            whenTrue BoundExpression,
            whenFalse BoundExpression
        ) {
            VisitExpression(condition)
            let trueCollector = ReadAndAwaitCollector(interesting, pointsTo, definitelyOverwritten, escapingLabelLiveIn)
            trueCollector.VisitExpression(whenTrue)
            let falseCollector = ReadAndAwaitCollector(
                interesting,
                pointsTo,
                definitelyOverwritten,
                escapingLabelLiveIn
            )
            falseCollector.VisitExpression(whenFalse)
            Reads.UnionWith(trueCollector.Reads)
            Reads.UnionWith(falseCollector.Reads)
            InternalUnsafeVariables.UnionWith(trueCollector.InternalUnsafeVariables)
            InternalUnsafeVariables.UnionWith(falseCollector.InternalUnsafeVariables)
            MergeOutgoingGotoOverwrites(trueCollector.OutgoingGotoOverwrites)
            MergeOutgoingGotoOverwrites(falseCollector.OutgoingGotoOverwrites)
            if trueCollector.ContainsAwait || falseCollector.ContainsAwait {
                ContainsAwait = true
            }
            let trueNormal = trueCollector.HasNormalExit && whenTrue.Type != TypeSymbol.Never
            let falseNormal = falseCollector.HasNormalExit && whenFalse.Type != TypeSymbol.Never
            pointsTo.Clear()
            if trueNormal {
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(pointsTo, trueCollector.pointsTo)
            }
            if falseNormal {
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(pointsTo, falseCollector.pointsTo)
            }
            if !trueNormal && !falseNormal {
                HasNormalExit = false
                return
            }
            let bothOverwritten = if trueNormal && falseNormal {
                {
                    let set = HashSet[VariableSymbol](trueCollector.definitelyOverwritten)
                    set.IntersectWith(falseCollector.definitelyOverwritten)
                    set
                }
            } else if trueNormal {
                trueCollector.definitelyOverwritten
            } else {
                falseCollector.definitelyOverwritten
            }
            for v in bothOverwritten {
                if definitelyOverwritten.Add(v) && !Reads.Contains(v) {
                    PatternKills.Add(v)
                }
            }
            let bothKills = if trueNormal && falseNormal {
                {
                    let set = HashSet[VariableSymbol](trueCollector.PatternKills)
                    set.IntersectWith(falseCollector.PatternKills)
                    set
                }
            } else if trueNormal {
                trueCollector.PatternKills
            } else {
                falseCollector.PatternKills
            }
            for k in bothKills {
                if !Reads.Contains(k) {
                    PatternKills.Add(k)
                }
            }
        }

        protected override func VisitConditionalExpression(node BoundConditionalExpression) {
            VisitConditionalPair(node.Condition, node.WhenTrue, node.WhenFalse)
        }

        protected override func VisitConditionalAddressExpression(node BoundConditionalAddressExpression) {
            VisitConditionalPair(node.Condition, node.WhenTrueOperand, node.WhenFalseOperand)
        }

        protected override func VisitNullConditionalAccessExpression(node BoundNullConditionalAccessExpression) {
            VisitExpression(node.Receiver)
            let branchCollector = ReadAndAwaitCollector(
                interesting,
                pointsTo,
                definitelyOverwritten,
                escapingLabelLiveIn
            )
            branchCollector.VisitExpression(node.WhenNotNull)
            Reads.UnionWith(branchCollector.Reads)
            InternalUnsafeVariables.UnionWith(branchCollector.InternalUnsafeVariables)
            MergeOutgoingGotoOverwrites(branchCollector.OutgoingGotoOverwrites)
            if branchCollector.ContainsAwait {
                ContainsAwait = true
            }
            if branchCollector.HasNormalExit && node.WhenNotNull.Type != TypeSymbol.Never {
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(pointsTo, branchCollector.pointsTo)
            }
        }

        protected override func VisitBinaryExpression(node BoundBinaryExpression) {
            if node
                .Op
                .Kind is BoundBinaryOperatorKind.LogicalAnd or
                BoundBinaryOperatorKind.LogicalOr or
                BoundBinaryOperatorKind
                .NullCoalesce {
                VisitExpression(node.Left)
                if !HasNormalExit || node.Left.Type == TypeSymbol.Never {
                    HasNormalExit = false
                    return
                }
                let rightCollector = ReadAndAwaitCollector(
                    interesting,
                    pointsTo,
                    definitelyOverwritten,
                    escapingLabelLiveIn
                )
                rightCollector.VisitExpression(node.Right)
                Reads.UnionWith(rightCollector.Reads)
                InternalUnsafeVariables.UnionWith(rightCollector.InternalUnsafeVariables)
                MergeOutgoingGotoOverwrites(rightCollector.OutgoingGotoOverwrites)
                if rightCollector.ContainsAwait {
                    ContainsAwait = true
                }
                if rightCollector.HasNormalExit && node.Right.Type != TypeSymbol.Never {
                    RefStructAsyncLivenessAnalyzer.UnionPointsToInto(pointsTo, rightCollector.pointsTo)
                }
                return
            }
            base.VisitBinaryExpression(node)
        }

        private func AnalyzeCompoundOverwrites(
            statement BoundStatement,
            entryPointsTo Dictionary[VariableSymbol, HashSet[VariableSymbol]]?,
            entryOverwritten HashSet[VariableSymbol],
            collectEffects bool,
            outGotoOverwrites Dictionary[BoundLabel, HashSet[VariableSymbol]]?
        )(OutOverwritten HashSet[VariableSymbol], HasNormalExit bool) {
            switch statement {
                case switchStmt is BoundPatternSwitchStatement {
                    let postDiscriminant = RefStructAsyncLivenessAnalyzer.ClonePointsTo(entryPointsTo)
                    let discrCollector = ReadAndAwaitCollector(
                        interesting,
                        postDiscriminant,
                        entryOverwritten,
                        escapingLabelLiveIn
                    )
                    discrCollector.VisitExpression(switchStmt.Discriminant)
                    if collectEffects {
                        Reads.UnionWith(discrCollector.Reads)
                        InternalUnsafeVariables.UnionWith(discrCollector.InternalUnsafeVariables)
                        if discrCollector.ContainsAwait {
                            ContainsAwait = true
                        }
                    }
                    let summary = RefStructAsyncLivenessAnalyzer.ComputeSwitchPointsToSummary(
                        switchStmt,
                        discrCollector.pointsTo,
                        interesting
                    )
                    let armCount = switchStmt.Arms.Length
                    let armBaseOverwritten = [armCount]HashSet[VariableSymbol]
                    let armReachableFromHeader = [armCount]bool
                    let headerGotos = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
                    let RecordHeaderGotos = (source Dictionary[BoundLabel, HashSet[VariableSymbol]]) -> {
                        for entry in source {
                            if !headerGotos.TryGetValue(entry.Key, out var sink) {
                                headerGotos[entry.Key] = HashSet[VariableSymbol](entry.Value)
                            } else {
                                sink.IntersectWith(entry.Value)
                            }
                        }
                    }
                    RecordHeaderGotos(discrCollector.OutgoingGotoOverwrites)
                    var fallthroughOverwritten = HashSet[VariableSymbol](discrCollector.definitelyOverwritten)
                    var fallthroughReachable = true
                    var hasUnconditionalDefault = false
                    for var pass = 0; pass < 2; pass++ {
                        for var i = 0; i < armCount; i++ {
                            let arm = switchStmt.Arms[i]
                            if (pass == 0 && arm.IsDefault) || (pass == 1 && !arm.IsDefault) {
                                continue
                            }
                            if !fallthroughReachable {
                                armBaseOverwritten[i] = HashSet[VariableSymbol]()
                                armReachableFromHeader[i] = false
                                continue
                            }
                            let armHeaderOver = HashSet[VariableSymbol](fallthroughOverwritten)
                            var patMatchedOver = HashSet[VariableSymbol](armHeaderOver)
                            var patUnmatchedOver = HashSet[VariableSymbol](armHeaderOver)
                            var patCanMatch = true
                            var patCanFail = false
                            if arm.Pattern != nil {
                                let patCollector = ReadAndAwaitCollector(
                                    interesting,
                                    summary.ArmHeaderStates[i],
                                    armHeaderOver,
                                    escapingLabelLiveIn
                                )
                                patCollector.VisitPattern(arm.Pattern)
                                RecordHeaderGotos(patCollector.OutgoingGotoOverwrites)
                                if collectEffects {
                                    Reads.UnionWith(patCollector.Reads)
                                    InternalUnsafeVariables.UnionWith(patCollector.InternalUnsafeVariables)
                                    if patCollector.ContainsAwait {
                                        ContainsAwait = true
                                    }
                                }
                                let (pm, pu, pcm, pcf) = ApplyPatternOverwrites(
                                    arm.Pattern,
                                    summary.ArmHeaderStates[i],
                                    armHeaderOver,
                                    interesting
                                )
                                patMatchedOver = pm
                                patUnmatchedOver = pu
                                patCanMatch = pcm
                                patCanFail = pcf
                            }
                            let armOver = HashSet[VariableSymbol](patMatchedOver)
                            if arm.Guard != nil && patCanMatch {
                                let guardCollector = ReadAndAwaitCollector(
                                    interesting,
                                    summary.ArmGuardEntryStates[i],
                                    armOver,
                                    escapingLabelLiveIn
                                )
                                guardCollector.VisitExpression(arm.Guard)
                                RecordHeaderGotos(guardCollector.OutgoingGotoOverwrites)
                                if collectEffects {
                                    Reads.UnionWith(guardCollector.Reads)
                                    InternalUnsafeVariables.UnionWith(guardCollector.InternalUnsafeVariables)
                                    if guardCollector.ContainsAwait {
                                        ContainsAwait = true
                                    }
                                }
                                armOver.UnionWith(guardCollector.definitelyOverwritten)
                                if patCanFail {
                                    fallthroughOverwritten = HashSet[VariableSymbol](patUnmatchedOver)
                                    fallthroughOverwritten.IntersectWith(armOver)
                                } else {
                                    fallthroughOverwritten = HashSet[VariableSymbol](armOver)
                                }
                            } else if patCanFail {
                                fallthroughOverwritten = patUnmatchedOver
                            } else {
                                fallthroughReachable = false
                                if arm.IsDefault && patCanMatch {
                                    hasUnconditionalDefault = true
                                }
                            }
                            armReachableFromHeader[i] = patCanMatch
                            armBaseOverwritten[i] = armOver
                        }
                    }
                    let labelToArm = Dictionary[BoundLabel, int]()
                    let armLabels = [armCount]List[BoundLabel]
                    let allSwitchTargets = HashSet[BoundLabel]()
                    for var i = 0; i < armCount; i++ {
                        let lc = LabelCollector()
                        lc.Visit(switchStmt.Arms[i].Body)
                        armLabels[i] = lc.Labels
                        for lbl in lc.Labels {
                            labelToArm[lbl] = i
                        }
                        allSwitchTargets.UnionWith(lc.GotoTargets)
                    }
                    let pendingArmLabelOver = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
                    let headerOutgoingGotos = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
                    for entry in headerGotos {
                        if labelToArm.ContainsKey(entry.Key) {
                            pendingArmLabelOver[entry.Key] = HashSet[VariableSymbol](entry.Value)
                        } else {
                            headerOutgoingGotos[entry.Key] = HashSet[VariableSymbol](entry.Value)
                        }
                    }
                    var switchChanged = true
                    var switchSafety = 0
                    var normalExitInitialized = false
                    let normalExitOver = HashSet[VariableSymbol]()
                    let outgoingGotos = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
                    let ArmIsReachable = (index int) -> {
                        if armReachableFromHeader[index] {
                            return true
                        }
                        for lbl in armLabels[index] {
                            if pendingArmLabelOver.ContainsKey(lbl) {
                                return true
                            }
                        }
                        return false
                    }
                    while switchChanged && switchSafety++ < 1000 {
                        switchChanged = false
                        normalExitInitialized = false
                        normalExitOver.Clear()
                        outgoingGotos.Clear()
                        for entry in headerOutgoingGotos {
                            outgoingGotos[entry.Key] = HashSet[VariableSymbol](entry.Value)
                        }
                        for var i = 0; i < armCount; i++ {
                            if !ArmIsReachable(i) {
                                continue
                            }
                            let armGotos = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
                            let (armOutOver, armNormal) = AnalyzeBlockStatementPrefix(
                                RefStructAsyncLivenessAnalyzer.EnsureBlock(switchStmt.Arms[i].Body),
                                summary.ArmEntryStates[i],
                                armBaseOverwritten[i],
                                collectEffects: false,
                                summary.ArmLabelEntries,
                                pendingArmLabelOver,
                                armGotos,
                                allSwitchTargets,
                                allowStartEntry: armReachableFromHeader[i]
                            )
                            if armNormal {
                                if !normalExitInitialized {
                                    normalExitOver.UnionWith(armOutOver)
                                    normalExitInitialized = true
                                } else {
                                    normalExitOver.IntersectWith(armOutOver)
                                }
                            }
                            for entry in armGotos {
                                if labelToArm.ContainsKey(entry.Key) {
                                    if !pendingArmLabelOver.TryGetValue(entry.Key, out var existing) {
                                        pendingArmLabelOver[entry.Key] = HashSet[VariableSymbol](entry.Value)
                                        switchChanged = true
                                    } else {
                                        let prevCount = existing.Count
                                        existing.IntersectWith(entry.Value)
                                        if existing.Count != prevCount {
                                            switchChanged = true
                                        }
                                    }
                                } else if !outgoingGotos.TryGetValue(entry.Key, out var outSet) {
                                    outgoingGotos[entry.Key] = HashSet[VariableSymbol](entry.Value)
                                } else {
                                    outSet.IntersectWith(entry.Value)
                                }
                            }
                        }
                    }
                    if collectEffects {
                        for var i = 0; i < armCount; i++ {
                            if !ArmIsReachable(i) {
                                continue
                            }
                            AnalyzeBlockStatementPrefix(
                                RefStructAsyncLivenessAnalyzer.EnsureBlock(switchStmt.Arms[i].Body),
                                summary.ArmEntryStates[i],
                                armBaseOverwritten[i],
                                collectEffects: true,
                                summary.ArmLabelEntries,
                                pendingArmLabelOver,
                                outGotoOverwrites: nil,
                                allSwitchTargets,
                                allowStartEntry: armReachableFromHeader[i]
                            )
                        }
                    }
                    if outGotoOverwrites != nil {
                        for entry in outgoingGotos {
                            if !outGotoOverwrites.TryGetValue(entry.Key, out var sink) {
                                outGotoOverwrites[entry.Key] = HashSet[VariableSymbol](entry.Value)
                            } else {
                                sink.IntersectWith(entry.Value)
                            }
                        }
                    }
                    if !hasUnconditionalDefault && fallthroughReachable {
                        if !normalExitInitialized {
                            normalExitOver.UnionWith(fallthroughOverwritten)
                            normalExitInitialized = true
                        } else {
                            normalExitOver.IntersectWith(fallthroughOverwritten)
                        }
                    }
                    return (normalExitOver, normalExitInitialized)
                }
                case tryStmt is BoundTryStatement {
                    let trySummary = RefStructAsyncLivenessAnalyzer.ComputeTryPointsToSummary(
                        tryStmt,
                        entryPointsTo,
                        interesting
                    )
                    let tryGotos = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
                    let (tryOutOver, tryNormal) = AnalyzeBlockStatementPrefix(
                        RefStructAsyncLivenessAnalyzer.EnsureBlock(tryStmt.TryBlock),
                        entryPointsTo,
                        entryOverwritten,
                        collectEffects,
                        entryLabelPointsTo: nil,
                        entryLabelOverwritten: nil,
                        tryGotos
                    )
                    var afterInitialized = false
                    let afterOver = HashSet[VariableSymbol]()
                    if tryNormal {
                        afterOver.UnionWith(tryOutOver)
                        afterInitialized = true
                    }
                    var catchDispatchOver = HashSet[VariableSymbol](entryOverwritten)
                    var catchDispatchReachable = true
                    var exceptionalFinallyInitialized = false
                    let exceptionalFinallyOver = HashSet[VariableSymbol]()
                    let outgoingGotos = Dictionary[BoundLabel, HashSet[VariableSymbol]](tryGotos)
                    for clause in tryStmt.CatchClauses {
                        var filterPts Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil
                        trySummary.FilterEntryPointsTo.TryGetValue(clause, out filterPts)
                        let clauseOver = if catchDispatchReachable {
                            HashSet[VariableSymbol](catchDispatchOver)
                        } else {
                            HashSet[VariableSymbol](entryOverwritten)
                        }
                        var catchBodyEntryOver = HashSet[VariableSymbol](clauseOver)
                        var filterNormal = true
                        var filterNonThrowing = false
                        if clause.Filter is {} filter {
                            let filterCollector = ReadAndAwaitCollector(
                                interesting,
                                filterPts,
                                clauseOver,
                                escapingLabelLiveIn
                            )
                            filterCollector.VisitExpression(filter)
                            MergeOutgoingGotoOverwrites(filterCollector.OutgoingGotoOverwrites)
                            filterNormal = filterCollector.HasNormalExit
                            filterNonThrowing = filterNormal && RefStructAsyncLivenessAnalyzer.ExpressionCannotThrow(
                                filter
                            )
                            if collectEffects {
                                Reads.UnionWith(filterCollector.Reads)
                                InternalUnsafeVariables.UnionWith(filterCollector.InternalUnsafeVariables)
                                if filterCollector.ContainsAwait {
                                    ContainsAwait = true
                                }
                            }
                            if filterNormal {
                                catchBodyEntryOver = HashSet[VariableSymbol](filterCollector.definitelyOverwritten)
                            }
                        }
                        var catchPts Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil
                        trySummary.CatchEntryPointsTo.TryGetValue(clause, out catchPts)
                        let catchGotos = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
                        let (catchOutOver, catchNormal) = AnalyzeBlockStatementPrefix(
                            RefStructAsyncLivenessAnalyzer.EnsureBlock(clause.Body),
                            catchPts,
                            catchBodyEntryOver,
                            collectEffects,
                            entryLabelPointsTo: nil,
                            entryLabelOverwritten: nil,
                            catchGotos
                        )
                        if catchDispatchReachable && !clause.ExitsThroughFinally && catchNormal && filterNormal {
                            if !afterInitialized {
                                afterOver.UnionWith(catchOutOver)
                                afterInitialized = true
                            } else {
                                afterOver.IntersectWith(catchOutOver)
                            }
                        }
                        if catchDispatchReachable {
                            if filterNormal {
                                if !exceptionalFinallyInitialized {
                                    exceptionalFinallyOver.UnionWith(catchBodyEntryOver)
                                    exceptionalFinallyInitialized = true
                                } else {
                                    exceptionalFinallyOver.IntersectWith(catchBodyEntryOver)
                                }
                            }
                            for entry in catchGotos {
                                if !outgoingGotos.TryGetValue(entry.Key, out var sink) {
                                    outgoingGotos[entry.Key] = HashSet[VariableSymbol](entry.Value)
                                } else {
                                    sink.IntersectWith(entry.Value)
                                }
                            }
                            if clause.Filter != nil {
                                if filterNonThrowing && RefStructAsyncLivenessAnalyzer.IsCatchAllExceptionType(
                                    clause.ExceptionType
                                ) {
                                    catchDispatchOver = HashSet[VariableSymbol](catchBodyEntryOver)
                                }
                            } else if RefStructAsyncLivenessAnalyzer.IsCatchAllExceptionType(clause.ExceptionType) {
                                catchDispatchReachable = false
                            }
                        }
                    }
                    if catchDispatchReachable {
                        if !exceptionalFinallyInitialized {
                            exceptionalFinallyOver.UnionWith(catchDispatchOver)
                            exceptionalFinallyInitialized = true
                        } else {
                            exceptionalFinallyOver.IntersectWith(catchDispatchOver)
                        }
                    }
                    if tryStmt.FinallyBlock is {} finallyBlock {
                        let finallyBlockStmt = RefStructAsyncLivenessAnalyzer.EnsureBlock(finallyBlock)
                        let finallyInOver = if afterInitialized {
                            afterOver
                        } else {
                            HashSet[VariableSymbol](entryOverwritten)
                        }
                        let finallyAllPathsOver = HashSet[VariableSymbol]()
                        if afterInitialized && exceptionalFinallyInitialized {
                            finallyAllPathsOver.UnionWith(afterOver)
                            finallyAllPathsOver.IntersectWith(exceptionalFinallyOver)
                        } else if afterInitialized {
                            finallyAllPathsOver.UnionWith(afterOver)
                        } else if exceptionalFinallyInitialized {
                            finallyAllPathsOver.UnionWith(exceptionalFinallyOver)
                        } else {
                            finallyAllPathsOver.UnionWith(entryOverwritten)
                        }
                        let finallyGotos = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
                        let (_, finallyNormal) = AnalyzeBlockStatementPrefix(
                            finallyBlockStmt,
                            trySummary.FinallyIn,
                            finallyAllPathsOver,
                            collectEffects,
                            entryLabelPointsTo: nil,
                            entryLabelOverwritten: nil,
                            finallyGotos
                        )
                        if afterInitialized {
                            let (normFinOver, normFinNormal) = AnalyzeBlockStatementPrefix(
                                finallyBlockStmt,
                                trySummary.AfterTry,
                                finallyInOver,
                                collectEffects: false,
                                entryLabelPointsTo: nil,
                                entryLabelOverwritten: nil,
                                outGotoOverwrites: nil
                            )
                            afterOver.Clear()
                            if normFinNormal {
                                afterOver.UnionWith(normFinOver)
                            } else {
                                afterInitialized = false
                            }
                        } else if !finallyNormal {
                            afterInitialized = false
                        }
                        let transformedGotos = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
                        for entry in outgoingGotos {
                            let (gotoFinOver, gotoFinNormal) = AnalyzeBlockStatementPrefix(
                                finallyBlockStmt,
                                trySummary.FinallyIn,
                                entry.Value,
                                collectEffects: false,
                                entryLabelPointsTo: nil,
                                entryLabelOverwritten: nil,
                                outGotoOverwrites: nil
                            )
                            if gotoFinNormal {
                                transformedGotos[entry.Key] = gotoFinOver
                            }
                        }
                        for entry in finallyGotos {
                            if !transformedGotos.TryGetValue(entry.Key, out var sink) {
                                transformedGotos[entry.Key] = HashSet[VariableSymbol](entry.Value)
                            } else {
                                sink.IntersectWith(entry.Value)
                            }
                        }
                        outgoingGotos.Clear()
                        for entry in transformedGotos {
                            outgoingGotos[entry.Key] = entry.Value
                        }
                    }
                    if outGotoOverwrites != nil {
                        for entry in outgoingGotos {
                            if !outGotoOverwrites.TryGetValue(entry.Key, out var sink) {
                                outGotoOverwrites[entry.Key] = HashSet[VariableSymbol](entry.Value)
                            } else {
                                sink.IntersectWith(entry.Value)
                            }
                        }
                    }
                    return (afterOver, afterInitialized)
                }
                case fixedStmt is BoundFixedStatement {
                    let srcCollector = ReadAndAwaitCollector(interesting, entryPointsTo, entryOverwritten)
                    srcCollector.VisitExpression(fixedStmt.PinnedSource)
                    if collectEffects {
                        Reads.UnionWith(srcCollector.Reads)
                        InternalUnsafeVariables.UnionWith(srcCollector.InternalUnsafeVariables)
                        if srcCollector.ContainsAwait {
                            ContainsAwait = true
                        }
                    }
                    return AnalyzeBlockStatementPrefix(
                        RefStructAsyncLivenessAnalyzer.EnsureBlock(fixedStmt.Body),
                        srcCollector.pointsTo,
                        srcCollector.definitelyOverwritten,
                        collectEffects,
                        entryLabelPointsTo: nil,
                        entryLabelOverwritten: nil,
                        outGotoOverwrites
                    )
                }
                default {
                    return (HashSet[VariableSymbol](entryOverwritten), true)
                }
            }
        }

        internal func ApplyPatternOverwrites(
            pattern BoundPattern?,
            entryPointsTo Dictionary[VariableSymbol, HashSet[VariableSymbol]]?,
            entryOverwritten HashSet[VariableSymbol],
            interesting HashSet[VariableSymbol]
        )(Matched HashSet[VariableSymbol], Unmatched HashSet[VariableSymbol], CanMatch bool, CanFail bool) {
            if pattern == nil {
                return (
                    HashSet[VariableSymbol](entryOverwritten),
                    HashSet[VariableSymbol](entryOverwritten),
                    true,
                    false
                )
            }
            switch pattern {
                case BoundDiscardPattern {
                    return (
                        HashSet[VariableSymbol](entryOverwritten),
                        HashSet[VariableSymbol](entryOverwritten),
                        true,
                        false
                    )
                }
                case cp is BoundConstantPattern {
                    let c = ReadAndAwaitCollector(interesting, entryPointsTo, entryOverwritten)
                    c.VisitExpression(cp.Value)
                    return (c.definitelyOverwritten, HashSet[VariableSymbol](c.definitelyOverwritten), true, true)
                }
                case rp is BoundRelationalPattern {
                    let c = ReadAndAwaitCollector(interesting, entryPointsTo, entryOverwritten)
                    c.VisitExpression(rp.Test ?? rp.Value)
                    return (c.definitelyOverwritten, HashSet[VariableSymbol](c.definitelyOverwritten), true, true)
                }
                case tp is BoundTypePattern {
                    if tp.PropertyPattern != nil {
                        let (pm, pu, pMatch, _) = ApplyPatternOverwrites(
                            tp.PropertyPattern,
                            entryPointsTo,
                            entryOverwritten,
                            interesting
                        )
                        pu.IntersectWith(entryOverwritten)
                        return (pm, pu, pMatch, true)
                    }
                    return (
                        HashSet[VariableSymbol](entryOverwritten),
                        HashSet[VariableSymbol](entryOverwritten),
                        true,
                        true
                    )
                }
                case pp is BoundPropertyPattern {
                    var matched = HashSet[VariableSymbol](entryOverwritten)
                    var curPts = RefStructAsyncLivenessAnalyzer.ClonePointsTo(entryPointsTo)
                    let unmatched = HashSet[VariableSymbol](entryOverwritten)
                    var canMatch = true
                    for field in pp.Fields {
                        let (fm, fu, fMatch, fFail) = ApplyPatternOverwrites(
                            field.Pattern,
                            curPts,
                            matched,
                            interesting
                        )
                        if fFail {
                            unmatched.IntersectWith(fu)
                        }
                        if !fMatch {
                            canMatch = false
                            break
                        }
                        matched = fm
                        let (nextPts, _, _, _) = RefStructAsyncLivenessAnalyzer.ApplyPatternPointsTo(
                            field.Pattern,
                            curPts,
                            interesting
                        )
                        curPts = nextPts
                    }
                    return (matched, unmatched, canMatch, true)
                }
                case lp is BoundListPattern {
                    var matched = HashSet[VariableSymbol](entryOverwritten)
                    var curPts = RefStructAsyncLivenessAnalyzer.ClonePointsTo(entryPointsTo)
                    let unmatched = HashSet[VariableSymbol](entryOverwritten)
                    var canMatch = true
                    for elem in lp.Elements {
                        let (em, eu, eMatch, eFail) = ApplyPatternOverwrites(elem, curPts, matched, interesting)
                        if eFail {
                            unmatched.IntersectWith(eu)
                        }
                        if !eMatch {
                            canMatch = false
                            break
                        }
                        matched = em
                        let (nextPts, _, _, _) = RefStructAsyncLivenessAnalyzer.ApplyPatternPointsTo(
                            elem,
                            curPts,
                            interesting
                        )
                        curPts = nextPts
                    }
                    return (matched, unmatched, canMatch, true)
                }
                case sp is BoundSlicePattern {
                    if sp.Pattern != nil {
                        let (pm, pu, pMatch, _) = ApplyPatternOverwrites(
                            sp.Pattern,
                            entryPointsTo,
                            entryOverwritten,
                            interesting
                        )
                        pu.IntersectWith(entryOverwritten)
                        return (pm, pu, pMatch, true)
                    }
                    return (
                        HashSet[VariableSymbol](entryOverwritten),
                        HashSet[VariableSymbol](entryOverwritten),
                        true,
                        true
                    )
                }
                case bp is BoundBinaryPattern {
                    let (lm, lu, lCanMatch, lCanFail) = ApplyPatternOverwrites(
                        bp.Left,
                        entryPointsTo,
                        entryOverwritten,
                        interesting
                    )
                    let (lPtsM, lPtsU, _, _) = RefStructAsyncLivenessAnalyzer.ApplyPatternPointsTo(
                        bp.Left,
                        entryPointsTo,
                        interesting
                    )
                    if bp.IsConjunction {
                        if !lCanMatch {
                            return (lm, lu, false, lCanFail)
                        }
                        let (rm, ru, rCanMatch, rCanFail) = ApplyPatternOverwrites(bp.Right, lPtsM, lm, interesting)
                        if lCanFail && rCanFail {
                            let u = HashSet[VariableSymbol](lu)
                            u.IntersectWith(ru)
                            return (rm, u, rCanMatch, true)
                        }
                        if lCanFail {
                            return (rm, lu, rCanMatch, true)
                        }
                        if rCanFail {
                            return (rm, ru, rCanMatch, true)
                        }
                        return (rm, HashSet[VariableSymbol](rm), rCanMatch, false)
                    }
                    if !lCanFail {
                        return (lm, HashSet[VariableSymbol](lm), true, false)
                    }
                    let (rm, ru, rCanMatch, rCanFail) = ApplyPatternOverwrites(bp.Right, lPtsU, lu, interesting)
                    if lCanMatch && rCanMatch {
                        let m = HashSet[VariableSymbol](lm)
                        m.IntersectWith(rm)
                        return (m, ru, true, rCanFail)
                    }
                    if lCanMatch {
                        return (lm, ru, true, rCanFail)
                    }
                    if rCanMatch {
                        return (rm, ru, true, rCanFail)
                    }
                    return (HashSet[VariableSymbol](ru), ru, false, rCanFail)
                }
                case np is BoundNotPattern {
                    let (m, u, innerCanMatch, innerCanFail) = ApplyPatternOverwrites(
                        np.Pattern,
                        entryPointsTo,
                        entryOverwritten,
                        interesting
                    )
                    return (u, m, innerCanFail, innerCanMatch)
                }
                default {
                    return (
                        HashSet[VariableSymbol](entryOverwritten),
                        HashSet[VariableSymbol](entryOverwritten),
                        true,
                        true
                    )
                }
            }
        }

        private func CollectAwaitCrossings(
            expression BoundExpression?,
            entryPointsTo Dictionary[VariableSymbol, HashSet[VariableSymbol]]?,
            sink HashSet[VariableSymbol]
        ) {
            if expression == nil {
                return
            }
            switch expression {
                case block is BoundBlockExpression {
                    if !block.Statements.IsDefaultOrEmpty {
                        let blockStmt = BoundBlockStatement(nil, block.Statements)
                        let flattened = Lowerer.Flatten(blockStmt)
                        if ControlFlowGraph.CanCreate(flattened) {
                            let (_, _, prefixExit, _, prefixHasNormalExit, _) = RefStructAsyncLivenessAnalyzer
                                .ComputeGraphPointsTo(
                                ControlFlowGraph.CreateWithCompoundGotoReachability(flattened),
                                entryPointsTo,
                                interesting
                            )
                            let tailCrossings = HashSet[VariableSymbol]()
                            if prefixHasNormalExit {
                                CollectAwaitCrossings(block.Expression, prefixExit, tailCrossings)
                                let rawExpr = ReadAndAwaitCollector(
                                    interesting,
                                    prefixExit,
                                    overwrittenAtEntry: nil,
                                    escapingLabelLiveIn
                                )
                                rawExpr.VisitExpression(block.Expression)
                                let innerReport = ReportingContext(nil)
                                RefStructAsyncLivenessAnalyzer.AnalyzeRegion(
                                    blockStmt,
                                    rawExpr.Reads,
                                    HashSet[VariableSymbol](),
                                    interesting,
                                    innerReport,
                                    entryPointsTo,
                                    escapingLabelLiveIn
                                )
                                sink.UnionWith(innerReport.Crossing)
                                sink.UnionWith(tailCrossings)
                                return
                            }
                            let innerReport = ReportingContext(nil)
                            RefStructAsyncLivenessAnalyzer.AnalyzeRegion(
                                blockStmt,
                                HashSet[VariableSymbol](),
                                HashSet[VariableSymbol](),
                                interesting,
                                innerReport,
                                entryPointsTo,
                                escapingLabelLiveIn
                            )
                            sink.UnionWith(innerReport.Crossing)
                            return
                        }
                    }
                    CollectAwaitCrossings(block.Expression, entryPointsTo, sink)
                }
                case cond is BoundConditionalExpression {
                    CollectAwaitCrossings(cond.Condition, entryPointsTo, sink)
                    let postCondPts = RefStructAsyncLivenessAnalyzer.ClonePointsTo(entryPointsTo)
                    PointsToExpressionUpdater(postCondPts, interesting).VisitExpression(cond.Condition)
                    CollectAwaitCrossings(cond.WhenTrue, postCondPts, sink)
                    CollectAwaitCrossings(cond.WhenFalse, postCondPts, sink)
                }
                case condAddr is BoundConditionalAddressExpression {
                    CollectAwaitCrossings(condAddr.Condition, entryPointsTo, sink)
                    let postCondPts = RefStructAsyncLivenessAnalyzer.ClonePointsTo(entryPointsTo)
                    PointsToExpressionUpdater(postCondPts, interesting).VisitExpression(condAddr.Condition)
                    CollectAwaitCrossings(condAddr.WhenTrueOperand, postCondPts, sink)
                    CollectAwaitCrossings(condAddr.WhenFalseOperand, postCondPts, sink)
                }
                default {
                    let probe = ReadAndAwaitCollector(
                        interesting,
                        entryPointsTo,
                        overwrittenAtEntry: nil,
                        escapingLabelLiveIn
                    )
                    probe.VisitExpression(expression)
                    if probe.ContainsAwait {
                        sink.UnionWith(probe.Reads)
                    }
                    sink.UnionWith(probe.InternalUnsafeVariables)
                }
            }
        }

        private func AnalyzeBlockStatementPrefix(
            blockStmt BoundBlockStatement,
            entryPointsTo Dictionary[VariableSymbol, HashSet[VariableSymbol]]?,
            entryOverwritten HashSet[VariableSymbol],
            collectEffects bool,
            entryLabelPointsTo IReadOnlyDictionary[
                BoundLabel,
                Dictionary[VariableSymbol, HashSet[VariableSymbol]]
            ]? = nil,
            entryLabelOverwritten IReadOnlyDictionary[BoundLabel, HashSet[VariableSymbol]]? = nil,
            outGotoOverwrites Dictionary[BoundLabel, HashSet[VariableSymbol]]? = nil,
            externalEntryLabels IEnumerable[BoundLabel]? = nil,
            allowStartEntry bool = true
        )(OutOverwritten HashSet[VariableSymbol], HasNormalExit bool) {
            let flattened = Lowerer.Flatten(blockStmt)
            if !ControlFlowGraph.CanCreate(flattened) {
                if collectEffects {
                    let fallback = ReadAndAwaitCollector(
                        interesting,
                        entryPointsTo,
                        entryOverwritten,
                        escapingLabelLiveIn
                    )
                    fallback.VisitStatement(blockStmt)
                    Reads.UnionWith(fallback.Reads)
                    InternalUnsafeVariables.UnionWith(fallback.InternalUnsafeVariables)
                    if fallback.ContainsAwait {
                        ContainsAwait = true
                    }
                    return (fallback.definitelyOverwritten, true)
                }
                return (HashSet[VariableSymbol](entryOverwritten), true)
            }
            let prefixGraph = ControlFlowGraph.CreateWithCompoundGotoReachability(flattened, externalEntryLabels)
            let (stmtPointsTo, compoundEntryPointsTo, _, _, _, _) = RefStructAsyncLivenessAnalyzer.ComputeGraphPointsTo(
                prefixGraph,
                entryPointsTo,
                interesting,
                entryLabelPointsTo,
                allowStartEntry
            )
            let mustOverwritten = Dictionary[ControlFlowGraph.BasicBlock, HashSet[VariableSymbol]]()
            let blockCanTransfer = Dictionary[ControlFlowGraph.BasicBlock, bool]()
            let labelToBlock = Dictionary[BoundLabel, ControlFlowGraph.BasicBlock]()
            let pendingOverwrittenForBlock = Dictionary[ControlFlowGraph.BasicBlock, HashSet[VariableSymbol]]()
            let reachable = HashSet[ControlFlowGraph.BasicBlock]()
            for b in prefixGraph.Blocks {
                mustOverwritten[b] = HashSet[VariableSymbol]()
                blockCanTransfer[b] = true
                for stmt in b.Statements {
                    if stmt is BoundLabelStatement ls {
                        labelToBlock[ls.Label] = b
                    }
                }
            }
            if entryLabelOverwritten != nil {
                for entry in entryLabelOverwritten {
                    if labelToBlock.TryGetValue(entry.Key, out var targetBlock) {
                        if !pendingOverwrittenForBlock.TryGetValue(targetBlock, out var sink) {
                            pendingOverwrittenForBlock[targetBlock] = HashSet[VariableSymbol](entry.Value)
                        } else {
                            sink.IntersectWith(entry.Value)
                        }
                    }
                }
            }
            mustOverwritten[prefixGraph.Start] = HashSet[VariableSymbol](entryOverwritten)
            blockCanTransfer[prefixGraph.Start] = true
            if allowStartEntry {
                reachable.Add(prefixGraph.Start)
            }
            let compoundGotos = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
            var changed = true
            var safety = 0
            while changed && safety++ < 10000 {
                changed = false
                for block in prefixGraph.Blocks {
                    if block.IsStart || block.IsEnd {
                        continue
                    }
                    var anyPred = false
                    var curOverwritten = HashSet[VariableSymbol]()
                    for branch in block.Incoming {
                        if reachable.Contains(branch.From) && blockCanTransfer[branch.From] {
                            if !anyPred {
                                curOverwritten = HashSet[VariableSymbol](mustOverwritten[branch.From])
                                anyPred = true
                            } else {
                                curOverwritten.IntersectWith(mustOverwritten[branch.From])
                            }
                        }
                    }
                    if pendingOverwrittenForBlock.TryGetValue(block, out var gotoOver) {
                        if !anyPred {
                            curOverwritten = HashSet[VariableSymbol](gotoOver)
                            anyPred = true
                        } else {
                            curOverwritten.IntersectWith(gotoOver)
                        }
                    }
                    if !anyPred {
                        continue
                    }
                    if reachable.Add(block) {
                        changed = true
                    }
                    var canTransfer = true
                    for stmt in block.Statements {
                        if stmt is BoundTryStatement or BoundFixedStatement or BoundPatternSwitchStatement {
                            var compEntry Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil
                            if compoundEntryPointsTo != nil {
                                compoundEntryPointsTo.TryGetValue(stmt, out compEntry)
                            }
                            let localGotos = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
                            let (compOut, compNormal) = AnalyzeCompoundOverwrites(
                                stmt,
                                compEntry,
                                curOverwritten,
                                collectEffects: false,
                                localGotos
                            )
                            for entry in localGotos {
                                if labelToBlock.TryGetValue(entry.Key, out var targetBlock) {
                                    if !pendingOverwrittenForBlock.TryGetValue(targetBlock, out var sink) {
                                        pendingOverwrittenForBlock[targetBlock] = HashSet[VariableSymbol](entry.Value)
                                        changed = true
                                    } else {
                                        let prevCount = sink.Count
                                        sink.IntersectWith(entry.Value)
                                        if sink.Count != prevCount {
                                            changed = true
                                        }
                                    }
                                } else if !compoundGotos.TryGetValue(entry.Key, out var sink) {
                                    compoundGotos[entry.Key] = HashSet[VariableSymbol](entry.Value)
                                } else {
                                    sink.IntersectWith(entry.Value)
                                }
                            }
                            curOverwritten = compOut
                            if !compNormal {
                                canTransfer = false
                                break
                            }
                            continue
                        }
                        var stmtAlias IReadOnlyDictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil
                        if stmtPointsTo != nil {
                            stmtPointsTo.TryGetValue(stmt, out stmtAlias)
                        }
                        let stmtCollector = ReadAndAwaitCollector(interesting, stmtAlias, curOverwritten)
                        switch stmt {
                            case es is BoundExpressionStatement {
                                stmtCollector.VisitExpression(es.Expression)
                            }
                            case vd is BoundVariableDeclaration {
                                stmtCollector.VisitVariableDeclaration(vd)
                            }
                            case rs is BoundReturnStatement {
                                if rs.Expression != nil {
                                    stmtCollector.VisitExpression(rs.Expression)
                                }
                                canTransfer = false
                            }
                            case th is BoundThrowStatement {
                                stmtCollector.VisitExpression(th.Expression)
                                canTransfer = false
                            }
                            case BoundRethrowStatement {
                                canTransfer = false
                            }
                            case cgs is BoundConditionalGotoStatement {
                                stmtCollector.VisitExpression(cgs.Condition)
                            }
                            case ys is BoundYieldStatement {
                                if ys.Expression != nil {
                                    stmtCollector.VisitExpression(ys.Expression)
                                }
                            }
                            case BoundLabelStatement, BoundGotoStatement { }
                            default {
                                stmtCollector.VisitStatement(stmt)
                            }
                        }
                        for entry in stmtCollector.OutgoingGotoOverwrites {
                            if labelToBlock.TryGetValue(entry.Key, out var targetBlock) {
                                if !pendingOverwrittenForBlock.TryGetValue(targetBlock, out var sink) {
                                    pendingOverwrittenForBlock[targetBlock] = HashSet[VariableSymbol](entry.Value)
                                    changed = true
                                } else {
                                    let prevCount = sink.Count
                                    sink.IntersectWith(entry.Value)
                                    if sink.Count != prevCount {
                                        changed = true
                                    }
                                }
                            } else if !compoundGotos.TryGetValue(entry.Key, out var sink) {
                                compoundGotos[entry.Key] = HashSet[VariableSymbol](entry.Value)
                            } else {
                                sink.IntersectWith(entry.Value)
                            }
                        }
                        curOverwritten = HashSet[VariableSymbol](stmtCollector.definitelyOverwritten)
                        if !canTransfer || ControlFlowGraph.StatementDefinitelyReturns(stmt) ||
                            ControlFlowGraph.HasNeverValue(stmt) {
                            canTransfer = false
                            break
                        }
                    }
                    if blockCanTransfer[block] != canTransfer {
                        blockCanTransfer[block] = canTransfer
                        changed = true
                    }
                    if !RefStructAsyncLivenessAnalyzer.SetsEqual(curOverwritten, mustOverwritten[block]) {
                        mustOverwritten[block] = curOverwritten
                        changed = true
                    }
                }
            }
            if collectEffects {
                for block in prefixGraph.Blocks {
                    if block.IsStart || block.IsEnd || !reachable.Contains(block) {
                        continue
                    }
                    var anyPred = false
                    var curOverwritten = HashSet[VariableSymbol]()
                    for branch in block.Incoming {
                        if reachable.Contains(branch.From) && blockCanTransfer[branch.From] {
                            if !anyPred {
                                curOverwritten = HashSet[VariableSymbol](mustOverwritten[branch.From])
                                anyPred = true
                            } else {
                                curOverwritten.IntersectWith(mustOverwritten[branch.From])
                            }
                        }
                    }
                    if pendingOverwrittenForBlock.TryGetValue(block, out var gotoOver) {
                        if !anyPred {
                            curOverwritten = HashSet[VariableSymbol](gotoOver)
                            anyPred = true
                        } else {
                            curOverwritten.IntersectWith(gotoOver)
                        }
                    }
                    if !anyPred {
                        continue
                    }
                    for stmt in block.Statements {
                        if stmt is BoundTryStatement or BoundFixedStatement or BoundPatternSwitchStatement {
                            var compEntry Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil
                            if compoundEntryPointsTo != nil {
                                compoundEntryPointsTo.TryGetValue(stmt, out compEntry)
                            }
                            let (compOut, compNormal) = AnalyzeCompoundOverwrites(
                                stmt,
                                compEntry,
                                curOverwritten,
                                collectEffects: true,
                                outGotoOverwrites: nil
                            )
                            curOverwritten = compOut
                            if !compNormal {
                                break
                            }
                            continue
                        }
                        var stmtAlias IReadOnlyDictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil
                        if stmtPointsTo != nil {
                            stmtPointsTo.TryGetValue(stmt, out stmtAlias)
                        }
                        let stmtCollector = ReadAndAwaitCollector(
                            interesting,
                            stmtAlias,
                            curOverwritten,
                            escapingLabelLiveIn
                        )
                        switch stmt {
                            case es is BoundExpressionStatement {
                                stmtCollector.VisitExpression(es.Expression)
                            }
                            case vd is BoundVariableDeclaration {
                                stmtCollector.VisitVariableDeclaration(vd)
                            }
                            case rs is BoundReturnStatement {
                                if rs.Expression != nil {
                                    stmtCollector.VisitExpression(rs.Expression)
                                }
                            }
                            case th is BoundThrowStatement {
                                stmtCollector.VisitExpression(th.Expression)
                            }
                            case cgs is BoundConditionalGotoStatement {
                                stmtCollector.VisitExpression(cgs.Condition)
                                if !labelToBlock.ContainsKey(cgs.Label) &&
                                    escapingLabelLiveIn != nil &&
                                    escapingLabelLiveIn
                                    .TryGetValue(cgs.Label, out var targetLive) {
                                    for v in targetLive {
                                        if !curOverwritten.Contains(v) && !stmtCollector.definitelyOverwritten.Contains(
                                            v
                                        ) {
                                            Reads.Add(v)
                                        }
                                    }
                                }
                            }
                            case gs is BoundGotoStatement {
                                if !labelToBlock.ContainsKey(gs.Label) &&
                                    escapingLabelLiveIn != nil &&
                                    escapingLabelLiveIn
                                    .TryGetValue(gs.Label, out var targetLive) {
                                    for v in targetLive {
                                        if !curOverwritten.Contains(v) {
                                            Reads.Add(v)
                                        }
                                    }
                                }
                            }
                            case ys is BoundYieldStatement {
                                if ys.Expression != nil {
                                    stmtCollector.VisitExpression(ys.Expression)
                                }
                            }
                            case BoundLabelStatement, BoundRethrowStatement { }
                            default {
                                stmtCollector.VisitStatement(stmt)
                            }
                        }
                        Reads.UnionWith(stmtCollector.Reads)
                        InternalUnsafeVariables.UnionWith(stmtCollector.InternalUnsafeVariables)
                        if stmtCollector.ContainsAwait {
                            ContainsAwait = true
                        }
                        curOverwritten = HashSet[VariableSymbol](stmtCollector.definitelyOverwritten)
                        if stmt is BoundReturnStatement or
                            BoundThrowStatement or
                            BoundRethrowStatement ||
                            ControlFlowGraph.StatementDefinitelyReturns(stmt) || ControlFlowGraph.HasNeverValue(stmt) {
                            break
                        }
                    }
                }
            }
            if outGotoOverwrites != nil {
                for entry in compoundGotos {
                    if !outGotoOverwrites.TryGetValue(entry.Key, out var sink) {
                        outGotoOverwrites[entry.Key] = HashSet[VariableSymbol](entry.Value)
                    } else {
                        sink.IntersectWith(entry.Value)
                    }
                }
            }
            var exitInitialized = false
            let exitOverwritten = HashSet[VariableSymbol]()
            let lastCodeBlock ControlFlowGraph.BasicBlock? = if prefixGraph.Blocks.Count >= 2 {
                prefixGraph.Blocks[prefixGraph.Blocks.Count - 2]
            } else {
                default(ControlFlowGraph.BasicBlock?)
            }
            for branch in prefixGraph.End.Incoming {
                let from = branch.From
                if !reachable.Contains(from) || !blockCanTransfer[from] {
                    continue
                }
                let lastStmt = if from.Statements.Count > 0 {
                    from.Statements[from.Statements.Count - 1]
                } else {
                    default(BoundStatement?)
                }
                if lastStmt is BoundGotoStatement gs {
                    if outGotoOverwrites != nil {
                        if !outGotoOverwrites.TryGetValue(gs.Label, out var sink) {
                            outGotoOverwrites[gs.Label] = HashSet[VariableSymbol](mustOverwritten[from])
                        } else {
                            sink.IntersectWith(mustOverwritten[from])
                        }
                    }
                    continue
                }
                if !from.IsStart {
                    if !object.ReferenceEquals(from, lastCodeBlock) {
                        continue
                    }
                    if lastStmt is BoundReturnStatement or BoundThrowStatement or BoundRethrowStatement {
                        continue
                    }
                    if lastStmt != nil &&
                        (
                        ControlFlowGraph.StatementDefinitelyReturns(lastStmt) || ControlFlowGraph.HasNeverValue(
                            lastStmt
                        )
                    ) {
                        continue
                    }
                }
                if !exitInitialized {
                    exitOverwritten.UnionWith(mustOverwritten[from])
                    exitInitialized = true
                } else {
                    exitOverwritten.IntersectWith(mustOverwritten[from])
                }
            }
            return (exitOverwritten, exitInitialized)
        }

        protected override func VisitBlockExpression(node BoundBlockExpression) {
            if !node.Statements.IsDefaultOrEmpty {
                let blockStmt = BoundBlockStatement(nil, node.Statements)
                let flattened = Lowerer.Flatten(blockStmt)
                if ControlFlowGraph.CanCreate(flattened) {
                    let preEntryPointsTo = RefStructAsyncLivenessAnalyzer.ClonePointsTo(pointsTo)
                    let (_, _, prefixExit, _, prefixHasNormalExit, _) = RefStructAsyncLivenessAnalyzer
                        .ComputeGraphPointsTo(
                        ControlFlowGraph.CreateWithCompoundGotoReachability(flattened),
                        pointsTo,
                        interesting
                    )
                    let prevAwait = ContainsAwait
                    ContainsAwait = false
                    let localBlockGotos = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
                    let (exitOverwritten, hasNormalOverwritten) = AnalyzeBlockStatementPrefix(
                        blockStmt,
                        pointsTo,
                        definitelyOverwritten,
                        collectEffects: true,
                        entryLabelPointsTo: nil,
                        entryLabelOverwritten: nil,
                        outGotoOverwrites: localBlockGotos
                    )
                    MergeOutgoingGotoOverwrites(localBlockGotos)
                    let prefixHasAwait = ContainsAwait
                    ContainsAwait = prevAwait || prefixHasAwait
                    if hasNormalOverwritten {
                        for v in exitOverwritten {
                            if definitelyOverwritten.Add(v) && !Reads.Contains(v) {
                                PatternKills.Add(v)
                            }
                        }
                    }
                    pointsTo.Clear()
                    if !prefixHasNormalExit {
                        HasNormalExit = false
                        if prefixHasAwait {
                            let innerReport = ReportingContext(nil)
                            RefStructAsyncLivenessAnalyzer.AnalyzeRegion(
                                blockStmt,
                                HashSet[VariableSymbol](),
                                HashSet[VariableSymbol](),
                                interesting,
                                innerReport,
                                preEntryPointsTo,
                                escapingLabelLiveIn
                            )
                            InternalUnsafeVariables.UnionWith(innerReport.Crossing)
                        }
                        return
                    }
                    RefStructAsyncLivenessAnalyzer.UnionPointsToInto(pointsTo, prefixExit)
                    let exprCollector = ReadAndAwaitCollector(
                        interesting,
                        pointsTo,
                        definitelyOverwritten,
                        escapingLabelLiveIn
                    )
                    exprCollector.VisitExpression(node.Expression)
                    Reads.UnionWith(exprCollector.Reads)
                    InternalUnsafeVariables.UnionWith(exprCollector.InternalUnsafeVariables)
                    MergeOutgoingGotoOverwrites(exprCollector.OutgoingGotoOverwrites)
                    if exprCollector.ContainsAwait {
                        ContainsAwait = true
                    }
                    if !exprCollector.HasNormalExit || node.Expression.Type == TypeSymbol.Never {
                        HasNormalExit = false
                    } else {
                        for v in exprCollector.definitelyOverwritten {
                            if definitelyOverwritten.Add(v) && !Reads.Contains(v) {
                                PatternKills.Add(v)
                            }
                        }
                    }
                    pointsTo.Clear()
                    RefStructAsyncLivenessAnalyzer.UnionPointsToInto(pointsTo, exprCollector.pointsTo)
                    if prefixHasAwait {
                        let rawExprCollector = ReadAndAwaitCollector(
                            interesting,
                            pointsTo,
                            overwrittenAtEntry: nil,
                            escapingLabelLiveIn
                        )
                        rawExprCollector.VisitExpression(node.Expression)
                        let innerReport = ReportingContext(nil)
                        RefStructAsyncLivenessAnalyzer.AnalyzeRegion(
                            blockStmt,
                            rawExprCollector.Reads,
                            HashSet[VariableSymbol](),
                            interesting,
                            innerReport,
                            preEntryPointsTo,
                            escapingLabelLiveIn
                        )
                        InternalUnsafeVariables.UnionWith(innerReport.Crossing)
                    }
                    return
                }
            }
            VisitExpression(node.Expression)
        }

        protected override func VisitIndexAssignmentExpression(node BoundIndexAssignmentExpression) {
            RecordRead(node.Target)
            base.VisitIndexAssignmentExpression(node)
        }

        protected override func VisitClrIndexAssignmentExpression(node BoundClrIndexAssignmentExpression) {
            RecordRead(node.Target)
            base.VisitClrIndexAssignmentExpression(node)
        }

        protected override func VisitFieldAssignmentExpression(node BoundFieldAssignmentExpression) {
            RecordRead(node.Receiver)
            base.VisitFieldAssignmentExpression(node)
        }

        protected override func VisitAwaitExpression(node BoundAwaitExpression) {
            ContainsAwait = true
            base.VisitAwaitExpression(node)
        }

        protected override func VisitSwitchExpression(node BoundSwitchExpression) {
            let discrCollector = ReadAndAwaitCollector(
                interesting,
                pointsTo,
                definitelyOverwritten,
                escapingLabelLiveIn
            )
            discrCollector.VisitExpression(node.Discriminant)
            Reads.UnionWith(discrCollector.Reads)
            PatternKills.UnionWith(discrCollector.PatternKills)
            InternalUnsafeVariables.UnionWith(discrCollector.InternalUnsafeVariables)
            if discrCollector.ContainsAwait {
                ContainsAwait = true
            }
            var fallthroughState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(discrCollector.pointsTo)
            var fallthroughOverwritten = HashSet[VariableSymbol](discrCollector.definitelyOverwritten)
            let armCount = node.Arms.Length
            let armBindingsList = [armCount]HashSet[VariableSymbol]
            let armPatternCollectors = [armCount]ReadAndAwaitCollector?
            let armGuardCollectors = [armCount]ReadAndAwaitCollector?
            let armPatternMatchedOverwritten = [armCount]HashSet[VariableSymbol]
            let armCanMatch = [armCount]bool
            let armGuardEntryStates = [armCount]Dictionary[VariableSymbol, HashSet[VariableSymbol]]
            let armResultEntryStates = [armCount]Dictionary[VariableSymbol, HashSet[VariableSymbol]]
            let armResultEntryOverwritten = [armCount]HashSet[VariableSymbol]
            let switchPatternBindings = HashSet[VariableSymbol]()
            var hasUnconditionalDefault = false
            var fallthroughReachable = true
            for var pass = 0; pass < 2; pass++ {
                for var i = 0; i < armCount; i++ {
                    let arm = node.Arms[i]
                    if (pass == 0 && arm.IsDefault) || (pass == 1 && !arm.IsDefault) {
                        continue
                    }
                    let armBindings = HashSet[VariableSymbol]()
                    RefStructAsyncLivenessAnalyzer.CollectPatternBindings(arm.Pattern, interesting, armBindings)
                    armBindingsList[i] = armBindings
                    switchPatternBindings.UnionWith(armBindings)
                    let prePatternPts = RefStructAsyncLivenessAnalyzer.ClonePointsTo(fallthroughState)
                    let prePatternOver = HashSet[VariableSymbol](fallthroughOverwritten)
                    let patternCollector = ReadAndAwaitCollector(
                        interesting,
                        prePatternPts,
                        prePatternOver,
                        escapingLabelLiveIn
                    )
                    if !fallthroughReachable {
                        armCanMatch[i] = false
                        armPatternCollectors[i] = patternCollector
                        armPatternMatchedOverwritten[i] = HashSet[VariableSymbol]()
                        armGuardEntryStates[i] = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                        armGuardCollectors[i] = ReadAndAwaitCollector(
                            interesting,
                            aliasDependencies: nil,
                            overwrittenAtEntry: nil,
                            escapingLabelLiveIn
                        )
                        armResultEntryStates[i] = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                        armResultEntryOverwritten[i] = HashSet[VariableSymbol]()
                        continue
                    }
                    if arm.Pattern != nil {
                        patternCollector.VisitPattern(arm.Pattern)
                    }
                    armPatternCollectors[i] = patternCollector
                    var guardEntryState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(prePatternPts)
                    var patMatchedOver = HashSet[VariableSymbol](prePatternOver)
                    var patUnmatchedOver = HashSet[VariableSymbol](prePatternOver)
                    var patCanMatch = true
                    var patCanFail = false
                    if arm.Pattern != nil {
                        let (matched, unmatched, pcm, pcf) = RefStructAsyncLivenessAnalyzer.ApplyPatternPointsTo(
                            arm.Pattern,
                            prePatternPts,
                            interesting
                        )
                        let (pm, pu, _, _) = ApplyPatternOverwrites(
                            arm.Pattern,
                            prePatternPts,
                            prePatternOver,
                            interesting
                        )
                        patMatchedOver = pm
                        patUnmatchedOver = pu
                        patCanMatch = pcm
                        patCanFail = pcf
                        guardEntryState = if patCanMatch {
                            matched
                        } else {
                            Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                        }
                        fallthroughState = if patCanFail {
                            unmatched
                        } else {
                            Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                        }
                    }
                    armCanMatch[i] = patCanMatch
                    armPatternMatchedOverwritten[i] = patMatchedOver
                    armGuardEntryStates[i] = RefStructAsyncLivenessAnalyzer.ClonePointsTo(guardEntryState)
                    let guardCollector = ReadAndAwaitCollector(
                        interesting,
                        guardEntryState,
                        patMatchedOver,
                        escapingLabelLiveIn
                    )
                    if arm.Guard != nil && patCanMatch {
                        guardCollector.VisitExpression(arm.Guard)
                        if patCanFail {
                            RefStructAsyncLivenessAnalyzer.UnionPointsToInto(fallthroughState, guardCollector.pointsTo)
                            fallthroughOverwritten = HashSet[VariableSymbol](patUnmatchedOver)
                            fallthroughOverwritten.IntersectWith(guardCollector.definitelyOverwritten)
                        } else {
                            fallthroughState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(guardCollector.pointsTo)
                            fallthroughOverwritten = HashSet[VariableSymbol](guardCollector.definitelyOverwritten)
                        }
                    } else if patCanFail {
                        fallthroughOverwritten = patUnmatchedOver
                    } else {
                        fallthroughReachable = false
                        if arm.IsDefault && patCanMatch {
                            hasUnconditionalDefault = true
                        }
                    }
                    armGuardCollectors[i] = guardCollector
                    armResultEntryStates[i] = guardCollector.pointsTo
                    armResultEntryOverwritten[i] = guardCollector.definitelyOverwritten
                }
            }
            let selectedExits = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
            var commonKillsInitialized = false
            let commonArmKills = HashSet[VariableSymbol]()
            var anyArmNormal = false
            for var i = 0; i < armCount; i++ {
                let arm = node.Arms[i]
                let armBindings = armBindingsList[i]
                let patternCollector = armPatternCollectors[i]!!
                let guardCollector = armGuardCollectors[i]!!
                let resultCollector = ReadAndAwaitCollector(
                    interesting,
                    armResultEntryStates[i],
                    armResultEntryOverwritten[i],
                    escapingLabelLiveIn
                )
                if armCanMatch[i] {
                    resultCollector.VisitExpression(arm.Result)
                }
                InternalUnsafeVariables.UnionWith(patternCollector.InternalUnsafeVariables)
                InternalUnsafeVariables.UnionWith(guardCollector.InternalUnsafeVariables)
                InternalUnsafeVariables.UnionWith(resultCollector.InternalUnsafeVariables)
                MergeOutgoingGotoOverwrites(patternCollector.OutgoingGotoOverwrites)
                MergeOutgoingGotoOverwrites(guardCollector.OutgoingGotoOverwrites)
                MergeOutgoingGotoOverwrites(resultCollector.OutgoingGotoOverwrites)
                if patternCollector.ContainsAwait || guardCollector.ContainsAwait || resultCollector.ContainsAwait {
                    ContainsAwait = true
                }
                if armCanMatch[i] && guardCollector.ContainsAwait && arm.Guard != nil {
                    let guardCrossings = HashSet[VariableSymbol]()
                    CollectAwaitCrossings(arm.Guard, armGuardEntryStates[i], guardCrossings)
                    for v in guardCrossings {
                        if !armBindings.Contains(v) && !discrCollector.definitelyOverwritten.Contains(v) &&
                            armPatternMatchedOverwritten[i].Contains(v) {
                            InternalUnsafeVariables.Add(v)
                        }
                    }
                }
                if armCanMatch[i] && resultCollector.ContainsAwait {
                    let resultCrossings = HashSet[VariableSymbol]()
                    CollectAwaitCrossings(arm.Result, armResultEntryStates[i], resultCrossings)
                    for v in resultCrossings {
                        if !armBindings.Contains(v) && !discrCollector.definitelyOverwritten.Contains(v) &&
                            armResultEntryOverwritten[i].Contains(v) {
                            InternalUnsafeVariables.Add(v)
                        }
                    }
                }
                for v in patternCollector.Reads {
                    if !armBindings.Contains(v) || patternCollector.ContainsAwait {
                        Reads.Add(v)
                    }
                }
                for v in guardCollector.Reads {
                    if !armBindings.Contains(v) || patternCollector.ContainsAwait || guardCollector.ContainsAwait {
                        Reads.Add(v)
                    }
                }
                for v in resultCollector.Reads {
                    if !armBindings.Contains(v) ||
                        patternCollector.ContainsAwait ||
                        guardCollector.ContainsAwait ||
                        resultCollector.ContainsAwait {
                        Reads.Add(v)
                    }
                }
                let armNormal = armCanMatch[i] && resultCollector.HasNormalExit && arm.Result.Type != TypeSymbol.Never
                if armNormal {
                    anyArmNormal = true
                    RefStructAsyncLivenessAnalyzer.UnionPointsToInto(selectedExits, resultCollector.pointsTo)
                    let armKills = HashSet[VariableSymbol]()
                    for v in resultCollector.definitelyOverwritten {
                        if !discrCollector.definitelyOverwritten.Contains(v) && !discrCollector.Reads.Contains(v) &&
                            !patternCollector
                            .Reads
                            .Contains(v) && !guardCollector.Reads.Contains(v) && !resultCollector.Reads.Contains(v) {
                            armKills.Add(v)
                        }
                    }
                    if !commonKillsInitialized {
                        commonArmKills.UnionWith(armKills)
                        commonKillsInitialized = true
                    } else {
                        commonArmKills.IntersectWith(armKills)
                    }
                }
            }
            let canFallthroughOut = !hasUnconditionalDefault && fallthroughReachable
            if canFallthroughOut {
                anyArmNormal = true
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(selectedExits, fallthroughState)
                let fallKills = HashSet[VariableSymbol]()
                for v in fallthroughOverwritten {
                    if !discrCollector.definitelyOverwritten.Contains(v) && !discrCollector.Reads.Contains(v) {
                        fallKills.Add(v)
                    }
                }
                if !commonKillsInitialized {
                    commonArmKills.UnionWith(fallKills)
                    commonKillsInitialized = true
                } else {
                    commonArmKills.IntersectWith(fallKills)
                }
            }
            if !anyArmNormal {
                HasNormalExit = false
            } else if commonKillsInitialized {
                for killed in commonArmKills {
                    if definitelyOverwritten.Add(killed) && !Reads.Contains(killed) {
                        PatternKills.Add(killed)
                    }
                }
            }
            pointsTo.Clear()
            RefStructAsyncLivenessAnalyzer.UnionPointsToInto(pointsTo, selectedExits)
            for v in switchPatternBindings {
                if !discrCollector.Reads.Contains(v) {
                    PatternKills.Add(v)
                }
            }
        }

        protected override func VisitIsExpression(node BoundIsExpression) {
            let leftCollector = ReadAndAwaitCollector(interesting, pointsTo, definitelyOverwritten, escapingLabelLiveIn)
            leftCollector.VisitExpression(node.Expression)
            Reads.UnionWith(leftCollector.Reads)
            PatternKills.UnionWith(leftCollector.PatternKills)
            InternalUnsafeVariables.UnionWith(leftCollector.InternalUnsafeVariables)
            if leftCollector.ContainsAwait {
                ContainsAwait = true
            }
            let isBindings = HashSet[VariableSymbol]()
            if node.InputVariable != nil && interesting.Contains(node.InputVariable) {
                isBindings.Add(node.InputVariable)
            }
            RefStructAsyncLivenessAnalyzer.CollectPatternBindings(node.Pattern, interesting, isBindings)
            let patternCollector = ReadAndAwaitCollector(
                interesting,
                leftCollector.pointsTo,
                leftCollector.definitelyOverwritten,
                escapingLabelLiveIn
            )
            patternCollector.VisitPattern(node.Pattern)
            let (matched, unmatched, patCanMatch, patCanFail) = RefStructAsyncLivenessAnalyzer.ApplyPatternPointsTo(
                node.Pattern,
                leftCollector.pointsTo,
                interesting
            )
            let (patMatchedOver, patUnmatchedOver, _, _) = ApplyPatternOverwrites(
                node.Pattern,
                leftCollector.pointsTo,
                leftCollector.definitelyOverwritten,
                interesting
            )
            pointsTo.Clear()
            if patCanMatch {
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(pointsTo, matched)
            }
            if patCanFail {
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(pointsTo, unmatched)
            }
            InternalUnsafeVariables.UnionWith(patternCollector.InternalUnsafeVariables)
            if patternCollector.ContainsAwait {
                ContainsAwait = true
            }
            for v in patternCollector.Reads {
                if !isBindings.Contains(v) || patternCollector.ContainsAwait {
                    Reads.Add(v)
                }
            }
            let guaranteedOverwritten = if patCanMatch && patCanFail {
                {
                    let set = HashSet[VariableSymbol](patMatchedOver)
                    set.IntersectWith(patUnmatchedOver)
                    set
                }
            } else if patCanMatch {
                patMatchedOver
            } else {
                patUnmatchedOver
            }
            for killed in guaranteedOverwritten {
                if !leftCollector.definitelyOverwritten.Contains(killed) && !leftCollector.Reads.Contains(killed) &&
                    !patternCollector
                    .Reads
                    .Contains(killed) && !isBindings.Contains(killed) {
                    if definitelyOverwritten.Add(killed) && !Reads.Contains(killed) {
                        PatternKills.Add(killed)
                    }
                }
            }
            for v in isBindings {
                if !leftCollector.Reads.Contains(v) {
                    PatternKills.Add(v)
                }
            }
        }

        protected override func VisitBinaryPattern(node BoundBinaryPattern) {
            let leftCollector = ReadAndAwaitCollector(interesting, pointsTo, definitelyOverwritten, escapingLabelLiveIn)
            leftCollector.VisitPattern(node.Left)
            Reads.UnionWith(leftCollector.Reads)
            if leftCollector.ContainsAwait {
                ContainsAwait = true
            }
            let (lm, lu, lCanMatch, lCanFail) = RefStructAsyncLivenessAnalyzer.ApplyPatternPointsTo(
                node.Left,
                pointsTo,
                interesting
            )
            if (node.IsConjunction && lCanMatch) || (!node.IsConjunction && lCanFail) {
                let rightEntry = if node.IsConjunction {
                    lm
                } else {
                    lu
                }
                let rightOverwritten = if node.IsConjunction {
                    leftCollector.definitelyOverwritten
                } else {
                    definitelyOverwritten
                }
                let rightCollector = ReadAndAwaitCollector(
                    interesting,
                    rightEntry,
                    rightOverwritten,
                    escapingLabelLiveIn
                )
                rightCollector.VisitPattern(node.Right)
                Reads.UnionWith(rightCollector.Reads)
                if rightCollector.ContainsAwait {
                    ContainsAwait = true
                }
            }
            let (matched, unmatched, patCanMatch, patCanFail) = RefStructAsyncLivenessAnalyzer.ApplyPatternPointsTo(
                node,
                pointsTo,
                interesting
            )
            pointsTo.Clear()
            if patCanMatch {
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(pointsTo, matched)
            }
            if patCanFail {
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(pointsTo, unmatched)
            }
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
        private let includeOperandTemporaries bool

        init(diagnostics DiagnosticBag, references ReferenceResolver?, includeOperandTemporaries bool) {
            this.diagnostics = diagnostics
            this.references = references
            this.includeOperandTemporaries = includeOperandTemporaries
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
                let loweredLambdaBody = literal.LoweredBody ?? BodyFacts.LowerLambdaBody(literal.Body)
                literal.LoweredBody = loweredLambdaBody
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
                        references,
                        includeOperandTemporaries
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
    /// @param includeOperandTemporaries Whether whole-program call rewriting has completed.
    func Analyze(
        body BoundBlockStatement?,
        enclosing FunctionSymbol?,
        diagnostics DiagnosticBag?,
        references ReferenceResolver?,
        includeOperandTemporaries bool = true
    ) {
        if body == nil || enclosing == nil || diagnostics == nil {
            return
        }
        if enclosing.IsAsyncOrSuspending || Binder.IsIteratorReturnType(enclosing.Type) {
            // By-ref-like locals stay async-only (issue #2350's own scope; a
            // plain iterator still blanket-rejects them elsewhere) — only
            // native ref-alias locals (#4222) are interesting in an iterator
            // that isn't also async.
            AnalyzeScope(
                body,
                diagnostics,
                collectByRefLikeLocals: enclosing.IsAsyncOrSuspending,
                references,
                includeOperandTemporaries
            )
        }
        let finder = AsyncLambdaScopeFinder(diagnostics, references, includeOperandTemporaries)
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
        references ReferenceResolver?,
        includeOperandTemporaries bool
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
        if !collectByRefLikeLocals || !includeOperandTemporaries {
            return
        }
        // Preserve source-local rules and prove the actual explicit and implicit suspension representation.
        try {
            let preparationReferences = references ?? ReferenceResolver.Default()
            let handlerLowered = InterpolatedStringHandlerLowerer.LowerBody(body, preparationReferences)
            let spilledBody = AsyncStateMachineRewriter.PrepareBody(handlerLowered, preparationReferences)
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
        } catch (ex EmitDiagnosticException) {
            diagnostics.Report(Compilation.CreateInternalErrorDiagnostic(ex))
        }
    }

    private class PointerTargetCollector {
        init() {
            Targets = HashSet[VariableSymbol]()
        }

        prop Targets HashSet[VariableSymbol] {
            get;
        }

        // Follow only the addressed storage chain (not index or condition sub-expressions),
        // because scalar indices like `c.Value` in `&a[c.Value]` are evaluated before the
        // address is taken and do not require `c` to survive suspension.
        func Visit(node BoundExpression?) {
            if node == nil {
                return
            }
            switch node {
                case variableExpression is BoundVariableExpression {
                    Targets.Add(variableExpression.Variable)
                }
                case assign is BoundAssignmentExpression {
                    Visit(assign.Expression)
                }
                case addressOf is BoundAddressOfExpression {
                    Visit(addressOf.Operand)
                }
                case dereference is BoundDereferenceExpression {
                    Visit(dereference.Operand)
                }
                case field is BoundFieldAccessExpression {
                    if field.Receiver != nil && !RefStructAsyncLivenessAnalyzer.IsReferenceOwnerType(
                        field.Receiver.Type
                    ) {
                        Visit(field.Receiver)
                    }
                }
                case clrProp is BoundClrPropertyAccessExpression {
                    if clrProp.Receiver != nil &&
                        (
                        (
                            clrProp.Member is System
                                .Reflection
                                .FieldInfo &&
                                !RefStructAsyncLivenessAnalyzer.IsReferenceOwnerType(clrProp.Receiver.Type)
                        ) ||
                            RefCapabilities.IsRefReturningAccess(clrProp)
                    ) {
                        Visit(clrProp.Receiver)
                    }
                }
                case tuple is BoundTupleElementAccessExpression {
                    Visit(tuple.Receiver)
                }
                case idx is BoundIndexExpression {
                    if !idx.IsArrayBackedElementAccess {
                        Visit(idx.Target)
                    }
                }
                case clrIdx is BoundClrIndexExpression {
                    if RefCapabilities.IsRefReturningAccess(clrIdx) {
                        Visit(clrIdx.Target)
                    }
                }
                case conditionalAddress is BoundConditionalAddressExpression {
                    Visit(conditionalAddress.WhenTrueOperand)
                    Visit(conditionalAddress.WhenFalseOperand)
                }
                case conditional is BoundConditionalExpression {
                    Visit(conditional.WhenTrue)
                    Visit(conditional.WhenFalse)
                }
                case switchExpr is BoundSwitchExpression {
                    for arm in switchExpr.Arms {
                        Visit(arm.Result)
                    }
                }
                case conversion is BoundConversionExpression {
                    Visit(conversion.Expression)
                }
                case asExpr is BoundAsExpression {
                    Visit(asExpr.Expression)
                }
                case block is BoundBlockExpression {
                    Visit(block.Expression)
                }
            }
        }
    }

    private class PointerMutationDetector : BoundTreeWalker {
        prop Found bool {
            get;
            private set;
        }

        protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
            if node.Initializer != nil &&
                (
                node.Variable.Type is ByRefTypeSymbol || RefStructAsyncLivenessAnalyzer.IsNativeRefAlias(node.Variable)
            ) {
                Found = true
            }
            base.VisitVariableDeclaration(node)
        }

        protected override func VisitAssignmentExpression(node BoundAssignmentExpression) {
            if node.Variable.Type is ByRefTypeSymbol {
                Found = true
            }
            base.VisitAssignmentExpression(node)
        }
    }

    private class LabelCollector : BoundTreeWalker {
        prop Labels List[BoundLabel] {
            get;
        }
        prop GotoTargets List[BoundLabel] {
            get;
        }

        init() {
            Labels = List[BoundLabel]()
            GotoTargets = List[BoundLabel]()
        }

        override func VisitStatement(node BoundStatement?) {
            if node is BoundLabelStatement ls {
                Labels.Add(ls.Label)
                return
            }
            if node is BoundGotoStatement gs {
                GotoTargets.Add(gs.Label)
                return
            }
            if node is BoundConditionalGotoStatement cgs {
                GotoTargets.Add(cgs.Label)
            }
            base.VisitStatement(node)
        }
    }

    private class PointsToExpressionUpdater : BoundTreeWalker {
        private let state Dictionary[VariableSymbol, HashSet[VariableSymbol]]
        private let interesting HashSet[VariableSymbol]
        private let exceptionalUnion Dictionary[VariableSymbol, HashSet[VariableSymbol]]?
        private let gotoExits Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]?

        init(
            state Dictionary[VariableSymbol, HashSet[VariableSymbol]],
            interesting HashSet[VariableSymbol],
            exceptionalUnion Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil,
            gotoExits Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]? = nil
        ) {
            this.state = state
            this.interesting = interesting
            this.exceptionalUnion = exceptionalUnion
            this.gotoExits = gotoExits
            HasNormalExit = true
        }

        prop HasNormalExit bool {
            get;
            private set;
        }

        internal func ResolveTargets(expression BoundExpression?) HashSet[VariableSymbol] {
            if expression == nil {
                return HashSet[VariableSymbol]()
            }
            switch expression {
                case ve is BoundVariableExpression {
                    let resolved = HashSet[VariableSymbol]()
                    if interesting.Contains(ve.Variable) &&
                        (
                        TypeSymbol.IsByRefLike(ve.Variable.Type) || RefStructAsyncLivenessAnalyzer.IsNativeRefAlias(
                            ve.Variable
                        )
                    ) {
                        resolved.Add(ve.Variable)
                    }
                    if state.TryGetValue(ve.Variable, out var transitive) {
                        resolved.UnionWith(transitive)
                    }
                    return resolved
                }
                case conv is BoundConversionExpression {
                    return ResolveTargets(conv.Expression)
                }
                case assign is BoundAssignmentExpression {
                    let rhsTargets = ResolveTargets(assign.Expression)
                    if assign.Variable.Type is ByRefTypeSymbol {
                        RefStructAsyncLivenessAnalyzer.SetPointsTo(assign.Variable, rhsTargets, state, exceptionalUnion)
                    }
                    return rhsTargets
                }
                case addr is BoundAddressOfExpression {
                    return ResolveAddressedStorageTargets(addr.Operand)
                }
                case deref is BoundDereferenceExpression {
                    return ResolveAddressedStorageTargets(deref.Operand)
                }
                case cond is BoundConditionalExpression {
                    return ResolveConditionalTargets(cond.Condition, cond.WhenTrue, cond.WhenFalse)
                }
                case condAddr is BoundConditionalAddressExpression {
                    return ResolveConditionalTargets(
                        condAddr.Condition,
                        condAddr.WhenTrueOperand,
                        condAddr.WhenFalseOperand
                    )
                }
                case nc is BoundNullConditionalAccessExpression {
                    VisitExpression(nc.Receiver)
                    if !HasNormalExit || nc.Receiver.Type == TypeSymbol.Never {
                        HasNormalExit = false
                        return HashSet[VariableSymbol]()
                    }
                    let notNullState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(state)
                    let notNullUpdater = PointsToExpressionUpdater(
                        notNullState,
                        interesting,
                        exceptionalUnion,
                        gotoExits
                    )
                    let notNullTargets = notNullUpdater.ResolveTargets(nc.WhenNotNull)
                    if notNullUpdater.HasNormalExit && nc.WhenNotNull.Type != TypeSymbol.Never {
                        RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, notNullState)
                        return notNullTargets
                    }
                    return HashSet[VariableSymbol]()
                }
                case block is BoundBlockExpression {
                    if !block.Statements.IsDefaultOrEmpty {
                        let flattened = Lowerer.Flatten(BoundBlockStatement(nil, block.Statements))
                        if ControlFlowGraph.CanCreate(flattened) {
                            let (
                                _,
                                _,
                                prefixExit,
                                prefixExceptional,
                                prefixHasNormalExit,
                                prefixGotoExits
                            ) = RefStructAsyncLivenessAnalyzer
                                .ComputeGraphPointsTo(
                                ControlFlowGraph.CreateWithCompoundGotoReachability(flattened),
                                state,
                                interesting
                            )
                            if exceptionalUnion != nil {
                                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(exceptionalUnion, prefixExceptional)
                            }
                            if gotoExits != nil {
                                RefStructAsyncLivenessAnalyzer.UnionGotoMapInto(gotoExits, prefixGotoExits)
                            }
                            state.Clear()
                            if !prefixHasNormalExit {
                                HasNormalExit = false
                                return HashSet[VariableSymbol]()
                            }
                            RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, prefixExit)
                        } else {
                            base.VisitBlockExpression(block)
                            return CollectResolvedTargetsFromState(block.Expression)
                        }
                    }
                    let tailTargets = ResolveTargets(block.Expression)
                    if block.Expression.Type == TypeSymbol.Never {
                        HasNormalExit = false
                    }
                    return tailTargets
                }
                case sw is BoundSwitchExpression {
                    return ResolveSwitchTargets(sw)
                }
                case bin is BoundBinaryExpression when bin.Op.Kind == BoundBinaryOperatorKind.NullCoalesce {
                    let leftTargets = ResolveTargets(bin.Left)
                    if !HasNormalExit || bin.Left.Type == TypeSymbol.Never {
                        HasNormalExit = false
                        return HashSet[VariableSymbol]()
                    }
                    let rightState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(state)
                    let rightUpdater = PointsToExpressionUpdater(rightState, interesting, exceptionalUnion, gotoExits)
                    let rightTargets = rightUpdater.ResolveTargets(bin.Right)
                    let result = HashSet[VariableSymbol](leftTargets)
                    if rightUpdater.HasNormalExit && bin.Right.Type != TypeSymbol.Never {
                        RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, rightState)
                        result.UnionWith(rightTargets)
                    }
                    return result
                }
                default {
                    VisitExpression(expression)
                    return CollectResolvedTargetsFromState(expression)
                }
            }
        }

        private func ResolveConditionalTargets(
            condition BoundExpression,
            whenTrue BoundExpression,
            whenFalse BoundExpression
        ) HashSet[VariableSymbol] {
            VisitExpression(condition)
            if !HasNormalExit || condition.Type == TypeSymbol.Never {
                HasNormalExit = false
                return HashSet[VariableSymbol]()
            }
            let trueState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(state)
            let trueUpdater = PointsToExpressionUpdater(trueState, interesting, exceptionalUnion, gotoExits)
            let trueTargets = trueUpdater.ResolveTargets(whenTrue)
            let falseState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(state)
            let falseUpdater = PointsToExpressionUpdater(falseState, interesting, exceptionalUnion, gotoExits)
            let falseTargets = falseUpdater.ResolveTargets(whenFalse)
            let trueNormal = trueUpdater.HasNormalExit && whenTrue.Type != TypeSymbol.Never
            let falseNormal = falseUpdater.HasNormalExit && whenFalse.Type != TypeSymbol.Never
            state.Clear()
            let result = HashSet[VariableSymbol]()
            if trueNormal {
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, trueState)
                result.UnionWith(trueTargets)
            }
            if falseNormal {
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, falseState)
                result.UnionWith(falseTargets)
            }
            HasNormalExit = trueNormal || falseNormal
            return result
        }

        private func ResolveAddressedStorageTargets(operand BoundExpression?) HashSet[VariableSymbol] {
            if operand == nil {
                return HashSet[VariableSymbol]()
            }
            switch operand {
                case ve is BoundVariableExpression {
                    return ResolveTargets(ve)
                }
                case deref is BoundDereferenceExpression {
                    return ResolveTargets(deref.Operand)
                }
                case conv is BoundConversionExpression {
                    return ResolveAddressedStorageTargets(conv.Expression)
                }
                case field is BoundFieldAccessExpression {
                    if field.Receiver == nil {
                        return HashSet[VariableSymbol]()
                    }
                    if RefStructAsyncLivenessAnalyzer.IsReferenceOwnerType(field.Receiver.Type) {
                        VisitExpression(field.Receiver)
                        return HashSet[VariableSymbol]()
                    }
                    return ResolveAddressedStorageTargets(field.Receiver)
                }
                case clrField is BoundClrPropertyAccessExpression when clrField.Member is System.Reflection.FieldInfo {
                    if clrField.Receiver == nil {
                        return HashSet[VariableSymbol]()
                    }
                    if RefStructAsyncLivenessAnalyzer.IsReferenceOwnerType(clrField.Receiver.Type) {
                        VisitExpression(clrField.Receiver)
                        return HashSet[VariableSymbol]()
                    }
                    return ResolveAddressedStorageTargets(clrField.Receiver)
                }
                case tuple is BoundTupleElementAccessExpression {
                    return ResolveAddressedStorageTargets(tuple.Receiver)
                }
                case idx is BoundIndexExpression {
                    let resolved = if idx.IsArrayBackedElementAccess {
                        VisitExpression(idx.Target)
                        HashSet[VariableSymbol]()
                    } else {
                        ResolveAddressedStorageTargets(idx.Target)
                    }
                    for indexExpr in idx.Indices {
                        VisitExpression(indexExpr)
                    }
                    return resolved
                }
                case clrIdx is BoundClrIndexExpression {
                    let resolved = if !RefCapabilities.IsRefReturningAccess(clrIdx) {
                        VisitExpression(clrIdx.Target)
                        HashSet[VariableSymbol]()
                    } else {
                        ResolveAddressedStorageTargets(clrIdx.Target)
                    }
                    for arg in clrIdx.Arguments {
                        VisitExpression(arg)
                    }
                    return resolved
                }
                case cond is BoundConditionalExpression {
                    VisitExpression(cond.Condition)
                    if !HasNormalExit || cond.Condition.Type == TypeSymbol.Never {
                        HasNormalExit = false
                        return HashSet[VariableSymbol]()
                    }
                    let trueState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(state)
                    let trueUpdater = PointsToExpressionUpdater(trueState, interesting, exceptionalUnion, gotoExits)
                    let trueTargets = trueUpdater.ResolveAddressedStorageTargets(cond.WhenTrue)
                    let falseState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(state)
                    let falseUpdater = PointsToExpressionUpdater(falseState, interesting, exceptionalUnion, gotoExits)
                    let falseTargets = falseUpdater.ResolveAddressedStorageTargets(cond.WhenFalse)
                    let trueNormal = trueUpdater.HasNormalExit && cond.WhenTrue.Type != TypeSymbol.Never
                    let falseNormal = falseUpdater.HasNormalExit && cond.WhenFalse.Type != TypeSymbol.Never
                    state.Clear()
                    let result = HashSet[VariableSymbol]()
                    if trueNormal {
                        RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, trueState)
                        result.UnionWith(trueTargets)
                    }
                    if falseNormal {
                        RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, falseState)
                        result.UnionWith(falseTargets)
                    }
                    HasNormalExit = trueNormal || falseNormal
                    return result
                }
                case condAddr is BoundConditionalAddressExpression {
                    VisitExpression(condAddr.Condition)
                    if !HasNormalExit || condAddr.Condition.Type == TypeSymbol.Never {
                        HasNormalExit = false
                        return HashSet[VariableSymbol]()
                    }
                    let trueState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(state)
                    let trueUpdater = PointsToExpressionUpdater(trueState, interesting, exceptionalUnion, gotoExits)
                    let trueTargets = trueUpdater.ResolveAddressedStorageTargets(condAddr.WhenTrueOperand)
                    let falseState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(state)
                    let falseUpdater = PointsToExpressionUpdater(falseState, interesting, exceptionalUnion, gotoExits)
                    let falseTargets = falseUpdater.ResolveAddressedStorageTargets(condAddr.WhenFalseOperand)
                    let trueNormal = trueUpdater.HasNormalExit && condAddr.WhenTrueOperand.Type != TypeSymbol.Never
                    let falseNormal = falseUpdater.HasNormalExit && condAddr.WhenFalseOperand.Type != TypeSymbol.Never
                    state.Clear()
                    let result = HashSet[VariableSymbol]()
                    if trueNormal {
                        RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, trueState)
                        result.UnionWith(trueTargets)
                    }
                    if falseNormal {
                        RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, falseState)
                        result.UnionWith(falseTargets)
                    }
                    HasNormalExit = trueNormal || falseNormal
                    return result
                }
                case block is BoundBlockExpression {
                    if !block.Statements.IsDefaultOrEmpty {
                        let flattened = Lowerer.Flatten(BoundBlockStatement(nil, block.Statements))
                        if ControlFlowGraph.CanCreate(flattened) {
                            let (
                                _,
                                _,
                                prefixExit,
                                prefixExceptional,
                                prefixHasNormalExit,
                                prefixGotoExits
                            ) = RefStructAsyncLivenessAnalyzer
                                .ComputeGraphPointsTo(
                                ControlFlowGraph.CreateWithCompoundGotoReachability(flattened),
                                state,
                                interesting
                            )
                            if exceptionalUnion != nil {
                                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(exceptionalUnion, prefixExceptional)
                            }
                            if gotoExits != nil {
                                RefStructAsyncLivenessAnalyzer.UnionGotoMapInto(gotoExits, prefixGotoExits)
                            }
                            state.Clear()
                            if !prefixHasNormalExit {
                                HasNormalExit = false
                                return HashSet[VariableSymbol]()
                            }
                            RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, prefixExit)
                        } else {
                            base.VisitBlockExpression(block)
                            return CollectResolvedTargetsFromState(block.Expression)
                        }
                    }
                    return ResolveAddressedStorageTargets(block.Expression)
                }
                default {
                    VisitExpression(operand)
                    return HashSet[VariableSymbol]()
                }
            }
        }

        private func CollectResolvedTargetsFromState(expression BoundExpression?) HashSet[VariableSymbol] {
            let collector = PointerTargetCollector()
            collector.Visit(expression)
            let resolved = HashSet[VariableSymbol]()
            for referenced in collector.Targets {
                if interesting.Contains(referenced) &&
                    (
                    TypeSymbol.IsByRefLike(referenced.Type) || RefStructAsyncLivenessAnalyzer.IsNativeRefAlias(
                        referenced
                    )
                ) {
                    resolved.Add(referenced)
                }
                if state.TryGetValue(referenced, out var transitive) {
                    resolved.UnionWith(transitive)
                }
            }
            return resolved
        }

        protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
            if node.Initializer is {} initializer {
                if node.Variable.Type is ByRefTypeSymbol || RefStructAsyncLivenessAnalyzer.IsNativeRefAlias(
                    node.Variable
                ) {
                    let targets = ResolveTargets(initializer)
                    RefStructAsyncLivenessAnalyzer.SetPointsTo(node.Variable, targets, state, exceptionalUnion)
                } else {
                    VisitExpression(initializer)
                }
                return
            }
            base.VisitVariableDeclaration(node)
        }

        protected override func VisitAssignmentExpression(node BoundAssignmentExpression) {
            if node.Variable.Type is ByRefTypeSymbol {
                let targets = ResolveTargets(node.Expression)
                RefStructAsyncLivenessAnalyzer.SetPointsTo(node.Variable, targets, state, exceptionalUnion)
                return
            }
            VisitExpression(node.Expression)
        }

        protected override func VisitThrowExpression(node BoundThrowExpression) {
            base.VisitThrowExpression(node)
            HasNormalExit = false
        }

        private func VisitConditionalPair(
            condition BoundExpression,
            whenTrue BoundExpression,
            whenFalse BoundExpression
        ) {
            VisitExpression(condition)
            if !HasNormalExit || condition.Type == TypeSymbol.Never {
                HasNormalExit = false
                return
            }
            let whenTrueState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(state)
            let trueUpdater = PointsToExpressionUpdater(whenTrueState, interesting, exceptionalUnion, gotoExits)
            trueUpdater.VisitExpression(whenTrue)
            let whenFalseState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(state)
            let falseUpdater = PointsToExpressionUpdater(whenFalseState, interesting, exceptionalUnion, gotoExits)
            falseUpdater.VisitExpression(whenFalse)
            let trueNormal = trueUpdater.HasNormalExit && whenTrue.Type != TypeSymbol.Never
            let falseNormal = falseUpdater.HasNormalExit && whenFalse.Type != TypeSymbol.Never
            state.Clear()
            if trueNormal {
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, whenTrueState)
            }
            if falseNormal {
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, whenFalseState)
            }
            HasNormalExit = trueNormal || falseNormal
        }

        protected override func VisitConditionalExpression(node BoundConditionalExpression) {
            VisitConditionalPair(node.Condition, node.WhenTrue, node.WhenFalse)
        }

        protected override func VisitConditionalAddressExpression(node BoundConditionalAddressExpression) {
            VisitConditionalPair(node.Condition, node.WhenTrueOperand, node.WhenFalseOperand)
        }

        protected override func VisitNullConditionalAccessExpression(node BoundNullConditionalAccessExpression) {
            VisitExpression(node.Receiver)
            if !HasNormalExit || node.Receiver.Type == TypeSymbol.Never {
                HasNormalExit = false
                return
            }
            let whenNotNullState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(state)
            let notNullUpdater = PointsToExpressionUpdater(whenNotNullState, interesting, exceptionalUnion, gotoExits)
            notNullUpdater.VisitExpression(node.WhenNotNull)
            if notNullUpdater.HasNormalExit && node.WhenNotNull.Type != TypeSymbol.Never {
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, whenNotNullState)
            }
        }

        protected override func VisitBlockExpression(node BoundBlockExpression) {
            if !node.Statements.IsDefaultOrEmpty {
                let flattened = Lowerer.Flatten(BoundBlockStatement(nil, node.Statements))
                if ControlFlowGraph.CanCreate(flattened) {
                    let (
                        _,
                        _,
                        prefixExit,
                        prefixExceptional,
                        prefixHasNormalExit,
                        prefixGotoExits
                    ) = RefStructAsyncLivenessAnalyzer
                        .ComputeGraphPointsTo(
                        ControlFlowGraph.CreateWithCompoundGotoReachability(flattened),
                        state,
                        interesting
                    )
                    if exceptionalUnion != nil {
                        RefStructAsyncLivenessAnalyzer.UnionPointsToInto(exceptionalUnion, prefixExceptional)
                    }
                    if gotoExits != nil {
                        RefStructAsyncLivenessAnalyzer.UnionGotoMapInto(gotoExits, prefixGotoExits)
                    }
                    state.Clear()
                    if !prefixHasNormalExit {
                        HasNormalExit = false
                        return
                    }
                    RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, prefixExit)
                } else {
                    base.VisitBlockExpression(node)
                    return
                }
            }
            VisitExpression(node.Expression)
            if node.Expression.Type == TypeSymbol.Never {
                HasNormalExit = false
            }
        }

        private func ResolveSwitchTargets(node BoundSwitchExpression) HashSet[VariableSymbol] {
            VisitExpression(node.Discriminant)
            if !HasNormalExit || node.Discriminant.Type == TypeSymbol.Never {
                HasNormalExit = false
                return HashSet[VariableSymbol]()
            }
            var fallthroughState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(state)
            let selectedExits = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
            let resultTargets = HashSet[VariableSymbol]()
            let armStates = [node.Arms.Length]Dictionary[VariableSymbol, HashSet[VariableSymbol]]
            let armCanMatch = [node.Arms.Length]bool
            var fallthroughReachable = true
            var hasUnconditionalDefault = false
            // Emission evaluates non-default pattern/guard clauses first and dispatches
            // `default` only after all non-default arms fail.
            for var pass = 0; pass < 2; pass++ {
                for var i = 0; i < node.Arms.Length; i++ {
                    let arm = node.Arms[i]
                    if (pass == 0 && arm.IsDefault) || (pass == 1 && !arm.IsDefault) {
                        continue
                    }
                    if !fallthroughReachable {
                        armStates[i] = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                        armCanMatch[i] = false
                        continue
                    }
                    var armState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(fallthroughState)
                    var patCanMatch = true
                    var patCanFail = false
                    if arm.Pattern != nil {
                        let (matched, unmatched, pcm, pcf) = RefStructAsyncLivenessAnalyzer.ApplyPatternPointsTo(
                            arm.Pattern,
                            armState,
                            interesting,
                            exceptionalUnion,
                            gotoExits
                        )
                        patCanMatch = pcm
                        patCanFail = pcf
                        armState = if patCanMatch {
                            matched
                        } else {
                            Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                        }
                        fallthroughState = if patCanFail {
                            unmatched
                        } else {
                            Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                        }
                    }
                    armCanMatch[i] = patCanMatch
                    if arm.Guard != nil && patCanMatch {
                        PointsToExpressionUpdater(armState, interesting, exceptionalUnion, gotoExits).VisitExpression(
                            arm.Guard
                        )
                        // Pattern match + guard evaluation can fail and continue to later arms.
                        if patCanFail {
                            RefStructAsyncLivenessAnalyzer.UnionPointsToInto(fallthroughState, armState)
                        } else {
                            fallthroughState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(armState)
                        }
                    } else if !patCanFail {
                        fallthroughReachable = false
                        if arm.IsDefault && patCanMatch {
                            hasUnconditionalDefault = true
                        }
                    }
                    armStates[i] = armState
                }
            }
            var anyArmNormal = false
            for var i = 0; i < node.Arms.Length; i++ {
                if !armCanMatch[i] {
                    continue
                }
                let armState = armStates[i]
                let armUpdater = PointsToExpressionUpdater(armState, interesting, exceptionalUnion, gotoExits)
                let armTargets = armUpdater.ResolveTargets(node.Arms[i].Result)
                if armUpdater.HasNormalExit && node.Arms[i].Result.Type != TypeSymbol.Never {
                    anyArmNormal = true
                    RefStructAsyncLivenessAnalyzer.UnionPointsToInto(selectedExits, armState)
                    resultTargets.UnionWith(armTargets)
                }
            }
            if !hasUnconditionalDefault && fallthroughReachable {
                anyArmNormal = true
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(selectedExits, fallthroughState)
            }
            state.Clear()
            RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, selectedExits)
            HasNormalExit = anyArmNormal
            return resultTargets
        }

        protected override func VisitSwitchExpression(node BoundSwitchExpression) {
            let _ = ResolveSwitchTargets(node)
        }

        protected override func VisitIsExpression(node BoundIsExpression) {
            VisitExpression(node.Expression)
            if !HasNormalExit || node.Expression.Type == TypeSymbol.Never {
                HasNormalExit = false
                return
            }
            let (matched, unmatched, patCanMatch, patCanFail) = RefStructAsyncLivenessAnalyzer.ApplyPatternPointsTo(
                node.Pattern,
                state,
                interesting,
                exceptionalUnion,
                gotoExits
            )
            state.Clear()
            if patCanMatch {
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, matched)
            }
            if patCanFail {
                RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, unmatched)
            }
        }

        protected override func VisitBinaryExpression(node BoundBinaryExpression) {
            if node
                .Op
                .Kind is BoundBinaryOperatorKind.LogicalAnd or
                BoundBinaryOperatorKind.LogicalOr or
                BoundBinaryOperatorKind
                .NullCoalesce {
                VisitExpression(node.Left)
                if !HasNormalExit || node.Left.Type == TypeSymbol.Never {
                    HasNormalExit = false
                    return
                }
                let rightState = RefStructAsyncLivenessAnalyzer.ClonePointsTo(state)
                let rightUpdater = PointsToExpressionUpdater(rightState, interesting, exceptionalUnion, gotoExits)
                rightUpdater.VisitExpression(node.Right)
                if rightUpdater.HasNormalExit && node.Right.Type != TypeSymbol.Never {
                    RefStructAsyncLivenessAnalyzer.UnionPointsToInto(state, rightState)
                }
                return
            }
            base.VisitBinaryExpression(node)
        }
    }

    private func EnsureBlock(
        statement BoundStatement
    ) BoundBlockStatement -> if statement is BoundBlockStatement block {
        block
    } else {
        BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](statement))
    }

    private func ApplyPatternPointsTo(
        pattern BoundPattern?,
        entryState Dictionary[VariableSymbol, HashSet[VariableSymbol]]?,
        interesting HashSet[VariableSymbol],
        exceptionalUnion Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil,
        gotoExits Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]? = nil
    )(
        MatchedState Dictionary[VariableSymbol, HashSet[VariableSymbol]],
        UnmatchedState Dictionary[VariableSymbol, HashSet[VariableSymbol]],
        CanMatch bool,
        CanFail bool
    ) {
        if pattern == nil {
            return (ClonePointsTo(entryState), Dictionary[VariableSymbol, HashSet[VariableSymbol]](), true, false)
        }
        switch pattern {
            case BoundDiscardPattern {
                return (ClonePointsTo(entryState), Dictionary[VariableSymbol, HashSet[VariableSymbol]](), true, false)
            }
            case cp is BoundConstantPattern {
                let s = ClonePointsTo(entryState)
                PointsToExpressionUpdater(s, interesting, exceptionalUnion, gotoExits).VisitExpression(cp.Value)
                return (s, ClonePointsTo(s), true, true)
            }
            case rp is BoundRelationalPattern {
                let s = ClonePointsTo(entryState)
                PointsToExpressionUpdater(s, interesting, exceptionalUnion, gotoExits).VisitExpression(
                    rp.Test ?? rp.Value
                )
                return (s, ClonePointsTo(s), true, true)
            }
            case tp is BoundTypePattern {
                if tp.PropertyPattern != nil {
                    let (matched, unmatched, pCanMatch, _) = ApplyPatternPointsTo(
                        tp.PropertyPattern,
                        entryState,
                        interesting,
                        exceptionalUnion,
                        gotoExits
                    )
                    UnionPointsToInto(unmatched, entryState)
                    return (matched, unmatched, pCanMatch, true)
                }
                return (ClonePointsTo(entryState), ClonePointsTo(entryState), true, true)
            }
            case pp is BoundPropertyPattern {
                var matched = ClonePointsTo(entryState)
                let unmatched = ClonePointsTo(entryState)
                var canMatch = true
                for field in pp.Fields {
                    let (fm, fu, fMatch, fFail) = ApplyPatternPointsTo(
                        field.Pattern,
                        matched,
                        interesting,
                        exceptionalUnion,
                        gotoExits
                    )
                    if fFail {
                        UnionPointsToInto(unmatched, fu)
                    }
                    if !fMatch {
                        canMatch = false
                        matched = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                        break
                    }
                    matched = fm
                }
                return (matched, unmatched, canMatch, true)
            }
            case lp is BoundListPattern {
                var matched = ClonePointsTo(entryState)
                let unmatched = ClonePointsTo(entryState)
                var canMatch = true
                for elem in lp.Elements {
                    let (em, eu, eMatch, eFail) = ApplyPatternPointsTo(
                        elem,
                        matched,
                        interesting,
                        exceptionalUnion,
                        gotoExits
                    )
                    if eFail {
                        UnionPointsToInto(unmatched, eu)
                    }
                    if !eMatch {
                        canMatch = false
                        matched = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                        break
                    }
                    matched = em
                }
                return (matched, unmatched, canMatch, true)
            }
            case sp is BoundSlicePattern {
                if sp.Pattern != nil {
                    let (pm, pu, pMatch, _) = ApplyPatternPointsTo(
                        sp.Pattern,
                        entryState,
                        interesting,
                        exceptionalUnion,
                        gotoExits
                    )
                    UnionPointsToInto(pu, entryState)
                    return (pm, pu, pMatch, true)
                }
                return (ClonePointsTo(entryState), ClonePointsTo(entryState), true, true)
            }
            case bp is BoundBinaryPattern {
                let (lm, lu, lCanMatch, lCanFail) = ApplyPatternPointsTo(
                    bp.Left,
                    entryState,
                    interesting,
                    exceptionalUnion,
                    gotoExits
                )
                if bp.IsConjunction {
                    if !lCanMatch {
                        return (Dictionary[VariableSymbol, HashSet[VariableSymbol]](), lu, false, lCanFail)
                    }
                    let (rm, ru, rCanMatch, rCanFail) = ApplyPatternPointsTo(
                        bp.Right,
                        lm,
                        interesting,
                        exceptionalUnion,
                        gotoExits
                    )
                    let u = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                    if lCanFail {
                        UnionPointsToInto(u, lu)
                    }
                    if rCanFail {
                        UnionPointsToInto(u, ru)
                    }
                    return (
                        if rCanMatch {
                            rm
                        } else {
                            Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                        },
                        u,
                        rCanMatch,
                        lCanFail || rCanFail
                    )
                }
                if !lCanFail {
                    return (lm, Dictionary[VariableSymbol, HashSet[VariableSymbol]](), true, false)
                }
                let (rm, ru, rCanMatch, rCanFail) = ApplyPatternPointsTo(
                    bp.Right,
                    lu,
                    interesting,
                    exceptionalUnion,
                    gotoExits
                )
                let m = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                if lCanMatch {
                    UnionPointsToInto(m, lm)
                }
                if rCanMatch {
                    UnionPointsToInto(m, rm)
                }
                return (
                    m,
                    if rCanFail {
                        ru
                    } else {
                        Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                    },
                    lCanMatch || rCanMatch,
                    rCanFail
                )
            }
            case np is BoundNotPattern {
                let (m, u, innerCanMatch, innerCanFail) = ApplyPatternPointsTo(
                    np.Pattern,
                    entryState,
                    interesting,
                    exceptionalUnion,
                    gotoExits
                )
                return (u, m, innerCanFail, innerCanMatch)
            }
            default {
                return (ClonePointsTo(entryState), ClonePointsTo(entryState), true, true)
            }
        }
    }

    private func IsCatchAllExceptionType(type TypeSymbol?) bool -> type == nil ||
        type.ClrType == typeof(System.Exception) ||
        type.ClrType == typeof(System.Object)

    private func AddressOperandCannotThrow(operand BoundExpression?) bool {
        switch operand {
            case BoundVariableExpression{Variable: LocalVariableSymbol or ParameterSymbol} {
                return true
            }
            case field is BoundFieldAccessExpression {
                return field.Receiver != nil &&
                    !IsReferenceOwnerType(field.Receiver.Type) &&
                    AddressOperandCannotThrow(field.Receiver)
            }
            case tuple is BoundTupleElementAccessExpression {
                return AddressOperandCannotThrow(tuple.Receiver)
            }
            default {
                return false
            }
        }
    }

    private func ExpressionCannotThrow(expression BoundExpression?) bool {
        if expression == nil {
            return true
        }
        switch expression {
            case BoundLiteralExpression, BoundDefaultExpression, BoundVariableExpression, BoundUtf8StringExpression {
                return true
            }
            case addr is BoundAddressOfExpression {
                return AddressOperandCannotThrow(addr.Operand)
            }
            case assign is BoundAssignmentExpression {
                return ExpressionCannotThrow(assign.Expression)
            }
            case structLit is BoundStructLiteralExpression {
                if structLit
                    .StructType
                    .IsClass ||
                    structLit.CallsDataConstructor ||
                    structLit.CallsPrimaryConstructor ||
                    structLit.CopySource != nil {
                    return false
                }
                for fieldInit in structLit.Initializers {
                    if fieldInit.Property != nil || !ExpressionCannotThrow(fieldInit.Value) {
                        return false
                    }
                }
                return true
            }
            case block is BoundBlockExpression {
                for stmt in block.Statements {
                    if !StatementCannotThrow(stmt) {
                        return false
                    }
                }
                return ExpressionCannotThrow(block.Expression)
            }
            case cond is BoundConditionalExpression {
                return ExpressionCannotThrow(cond.Condition) &&
                    ExpressionCannotThrow(cond.WhenTrue) &&
                    ExpressionCannotThrow(cond.WhenFalse)
            }
            case unary is BoundUnaryExpression {
                return unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation && ExpressionCannotThrow(unary.Operand)
            }
            case binary is BoundBinaryExpression {
                if !(
                    binary
                        .Op
                        .Kind is BoundBinaryOperatorKind.LogicalAnd or
                        BoundBinaryOperatorKind.LogicalOr or
                        BoundBinaryOperatorKind.Equals or
                        BoundBinaryOperatorKind.NotEquals or
                        BoundBinaryOperatorKind.Less or
                        BoundBinaryOperatorKind.LessOrEquals or
                        BoundBinaryOperatorKind.Greater or
                        BoundBinaryOperatorKind.GreaterOrEquals
                ) {
                    return false
                }
                return ExpressionCannotThrow(binary.Left) && ExpressionCannotThrow(binary.Right)
            }
            default {
                return false
            }
        }
    }

    private func StatementCannotThrow(statement BoundStatement?) bool {
        if statement == nil {
            return true
        }
        switch statement {
            case block is BoundBlockStatement {
                for stmt in block.Statements {
                    if !StatementCannotThrow(stmt) {
                        return false
                    }
                }
                return true
            }
            case es is BoundExpressionStatement {
                return ExpressionCannotThrow(es.Expression)
            }
            case vd is BoundVariableDeclaration {
                return ExpressionCannotThrow(vd.Initializer)
            }
            case BoundLabelStatement, BoundGotoStatement {
                return true
            }
            case cgs is BoundConditionalGotoStatement {
                return ExpressionCannotThrow(cgs.Condition)
            }
            default {
                return false
            }
        }
    }

    private func IsReferenceOwnerType(type TypeSymbol) bool {
        var current = PlatformTypeSymbol.StripTopLevel(type)
        if current is ByRefTypeSymbol byRef {
            current = byRef.PointeeType
        }
        if current is NullableTypeSymbol nullable {
            current = nullable.UnderlyingType
        }
        return Binder.IsReferenceTypeForConstraint(current)
    }

    private func SetPointsTo(
        target VariableSymbol,
        targets HashSet[VariableSymbol],
        state Dictionary[VariableSymbol, HashSet[VariableSymbol]],
        exceptionalUnion Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil
    ) {
        let filtered = HashSet[VariableSymbol]()
        for item in targets {
            if !object.ReferenceEquals(item, target) {
                filtered.Add(item)
            }
        }
        if filtered.Count > 0 {
            state[target] = filtered
        } else {
            state.Remove(target)
        }
        if exceptionalUnion != nil {
            UnionPointsToInto(exceptionalUnion, state)
        }
    }

    private func ClonePointsTo(source IReadOnlyDictionary[VariableSymbol, HashSet[VariableSymbol]]?) Dictionary[
        VariableSymbol,
        HashSet[VariableSymbol]
    ] {
        let copy = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
        if source == nil {
            return copy
        }
        for entry in source {
            if entry.Value.Count > 0 {
                copy[entry.Key] = HashSet[VariableSymbol](entry.Value)
            }
        }
        return copy
    }

    private func UnionPointsToInto(
        target Dictionary[VariableSymbol, HashSet[VariableSymbol]],
        source IReadOnlyDictionary[VariableSymbol, HashSet[VariableSymbol]]?
    ) {
        if source == nil {
            return
        }
        for entry in source {
            if entry.Value.Count == 0 {
                continue
            }
            if !target.TryGetValue(entry.Key, out var set) {
                set = HashSet[VariableSymbol]()
                target[entry.Key] = set
            }
            set.UnionWith(entry.Value)
        }
    }

    private func PointsToEqual(
        a Dictionary[VariableSymbol, HashSet[VariableSymbol]],
        b Dictionary[VariableSymbol, HashSet[VariableSymbol]]
    ) bool {
        if a.Count != b.Count {
            return false
        }
        for entry in a {
            if !b.TryGetValue(entry.Key, out var other) || !SetsEqual(entry.Value, other) {
                return false
            }
        }
        return true
    }

    private func UnionGotoMapInto(
        target Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]],
        source IReadOnlyDictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]?
    ) {
        if source == nil {
            return
        }
        for entry in source {
            if !target.TryGetValue(entry.Key, out var sink) {
                sink = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                target[entry.Key] = sink
            }
            UnionPointsToInto(sink, entry.Value)
        }
    }

    private func UnionGotoExitsInto(
        target Dictionary[VariableSymbol, HashSet[VariableSymbol]],
        gotoMap IReadOnlyDictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]?
    ) {
        if gotoMap == nil {
            return
        }
        for entry in gotoMap {
            UnionPointsToInto(target, entry.Value)
        }
    }

    private func ForwardGotoExits(
        sourceGotos IReadOnlyDictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]?,
        pendingIncomingForBlock Dictionary[
            ControlFlowGraph.BasicBlock,
            Dictionary[VariableSymbol, HashSet[VariableSymbol]]
        ]?,
        labelToBlock Dictionary[BoundLabel, ControlFlowGraph.BasicBlock]?,
        outGotoExits Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]?
    ) bool {
        if sourceGotos == nil || sourceGotos.Count == 0 {
            return false
        }
        var changed = false
        for entry in sourceGotos {
            if labelToBlock != nil && pendingIncomingForBlock != nil && labelToBlock.TryGetValue(
                entry.Key,
                out var targetBlock
            ) {
                if !pendingIncomingForBlock.TryGetValue(targetBlock, out var sink) {
                    sink = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                    pendingIncomingForBlock[targetBlock] = sink
                    UnionPointsToInto(sink, entry.Value)
                    changed = true
                } else {
                    let before = ClonePointsTo(sink)
                    UnionPointsToInto(sink, entry.Value)
                    if !PointsToEqual(before, sink) {
                        changed = true
                    }
                }
            } else if outGotoExits != nil {
                if !outGotoExits.TryGetValue(entry.Key, out var sink) {
                    sink = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                    outGotoExits[entry.Key] = sink
                }
                UnionPointsToInto(sink, entry.Value)
            }
        }
        return changed
    }

    private func ComputeRegionPointsToSummary(
        regionBody BoundStatement,
        entryPointsTo Dictionary[VariableSymbol, HashSet[VariableSymbol]]?,
        interesting HashSet[VariableSymbol],
        entryLabelPointsTo IReadOnlyDictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]? = nil,
        externalEntryLabels IEnumerable[BoundLabel]? = nil,
        allowStartEntry bool = true
    )(
        ExitState Dictionary[VariableSymbol, HashSet[VariableSymbol]],
        ExceptionalUnion Dictionary[VariableSymbol, HashSet[VariableSymbol]],
        HasNormalExit bool,
        GotoExits Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]
    ) {
        let graph = ControlFlowGraph.CreateWithCompoundGotoReachability(
            Lowerer.Flatten(regionBody),
            externalEntryLabels
        )
        let (_, _, exitState, exceptionalUnion, hasNormalExit, gotoExits) = ComputeGraphPointsTo(
            graph,
            entryPointsTo,
            interesting,
            entryLabelPointsTo,
            allowStartEntry
        )
        return (exitState, exceptionalUnion, hasNormalExit, gotoExits)
    }

    private class TryPointsToSummary {
        init(
            filterEntryPointsTo Dictionary[BoundCatchClause, Dictionary[VariableSymbol, HashSet[VariableSymbol]]],
            catchEntryPointsTo Dictionary[BoundCatchClause, Dictionary[VariableSymbol, HashSet[VariableSymbol]]],
            finallyIn Dictionary[VariableSymbol, HashSet[VariableSymbol]],
            afterTry Dictionary[VariableSymbol, HashSet[VariableSymbol]],
            hasNormalExit bool,
            combinedExceptional Dictionary[VariableSymbol, HashSet[VariableSymbol]],
            gotoExits Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]
        ) {
            FilterEntryPointsTo = filterEntryPointsTo
            CatchEntryPointsTo = catchEntryPointsTo
            FinallyIn = finallyIn
            AfterTry = afterTry
            HasNormalExit = hasNormalExit
            CombinedExceptional = combinedExceptional
            GotoExits = gotoExits
        }

        prop FilterEntryPointsTo Dictionary[BoundCatchClause, Dictionary[VariableSymbol, HashSet[VariableSymbol]]] {
            get;
        }
        prop CatchEntryPointsTo Dictionary[BoundCatchClause, Dictionary[VariableSymbol, HashSet[VariableSymbol]]] {
            get;
        }
        prop FinallyIn Dictionary[VariableSymbol, HashSet[VariableSymbol]] {
            get;
        }
        prop AfterTry Dictionary[VariableSymbol, HashSet[VariableSymbol]] {
            get;
        }
        prop HasNormalExit bool {
            get;
        }
        prop CombinedExceptional Dictionary[VariableSymbol, HashSet[VariableSymbol]] {
            get;
        }
        prop GotoExits Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]] {
            get;
        }
    }

    private func ComputeTryPointsToSummary(
        tryStmt BoundTryStatement,
        entryPointsTo Dictionary[VariableSymbol, HashSet[VariableSymbol]]?,
        interesting HashSet[VariableSymbol]
    ) TryPointsToSummary {
        let (tryExit, tryExceptional, tryHasNormalExit, tryGotoExits) = ComputeRegionPointsToSummary(
            tryStmt.TryBlock,
            entryPointsTo,
            interesting
        )
        let exceptionalIn = ClonePointsTo(entryPointsTo)
        UnionPointsToInto(exceptionalIn, tryExceptional)
        UnionPointsToInto(exceptionalIn, tryExit)
        UnionGotoExitsInto(exceptionalIn, tryGotoExits)
        let afterTry = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
        var afterTryHasNormalExit = false
        if tryHasNormalExit {
            afterTryHasNormalExit = true
            UnionPointsToInto(afterTry, tryExit)
        }
        let combinedExceptional = ClonePointsTo(exceptionalIn)
        let outgoingGotos = Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]()
        UnionGotoMapInto(outgoingGotos, tryGotoExits)
        let filterEntryPointsTo = Dictionary[BoundCatchClause, Dictionary[VariableSymbol, HashSet[VariableSymbol]]](
            ReferenceEqualityComparer.Instance
        )
        let catchEntryPointsTo = Dictionary[BoundCatchClause, Dictionary[VariableSymbol, HashSet[VariableSymbol]]](
            ReferenceEqualityComparer.Instance
        )
        var handlerDispatchState = ClonePointsTo(exceptionalIn)
        for clause in tryStmt.CatchClauses {
            filterEntryPointsTo[clause] = ClonePointsTo(handlerDispatchState)
            let catchIn = ClonePointsTo(handlerDispatchState)
            if clause.Filter is {} filter {
                let filterExceptional = ClonePointsTo(handlerDispatchState)
                PointsToExpressionUpdater(catchIn, interesting, filterExceptional, outgoingGotos).VisitExpression(
                    filter
                )
                UnionPointsToInto(combinedExceptional, filterExceptional)
                UnionPointsToInto(combinedExceptional, catchIn)
                // Filter evaluation can return false or throw, carrying mutations to later handlers and finally.
                if IsCatchAllExceptionType(clause.ExceptionType) && ExpressionCannotThrow(filter) {
                    handlerDispatchState = ClonePointsTo(catchIn)
                } else {
                    UnionPointsToInto(handlerDispatchState, filterExceptional)
                    UnionPointsToInto(handlerDispatchState, catchIn)
                }
            }
            catchEntryPointsTo[clause] = ClonePointsTo(catchIn)
            let (catchExit, catchExceptional, catchHasNormalExit, catchGotoExits) = ComputeRegionPointsToSummary(
                clause.Body,
                catchIn,
                interesting
            )
            if !clause.ExitsThroughFinally && catchHasNormalExit {
                afterTryHasNormalExit = true
                UnionPointsToInto(afterTry, catchExit)
            }
            UnionPointsToInto(combinedExceptional, catchExceptional)
            UnionPointsToInto(combinedExceptional, catchExit)
            UnionGotoExitsInto(combinedExceptional, catchGotoExits)
            UnionGotoMapInto(outgoingGotos, catchGotoExits)
        }
        let finallyIn = ClonePointsTo(combinedExceptional)
        UnionPointsToInto(finallyIn, afterTry)
        var finalState = afterTry
        var finalHasNormalExit = afterTryHasNormalExit
        if tryStmt.FinallyBlock is {} finallyBlock {
            let (finallyExit, finallyExceptional, _, finallyGotoExits) = ComputeRegionPointsToSummary(
                finallyBlock,
                finallyIn,
                interesting
            )
            UnionPointsToInto(combinedExceptional, finallyExceptional)
            UnionPointsToInto(combinedExceptional, finallyExit)
            UnionGotoExitsInto(combinedExceptional, finallyGotoExits)
            // Keep unioned finallyIn for analyzing the finally body itself, but compute
            // the normal continuation after the try exclusively from reachable normal afterTry paths.
            if afterTryHasNormalExit {
                let (normalFinallyExit, _, normalFinallyHasNormalExit, _) = ComputeRegionPointsToSummary(
                    finallyBlock,
                    afterTry,
                    interesting
                )
                finalState = normalFinallyExit
                finalHasNormalExit = normalFinallyHasNormalExit
            } else {
                finalState = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                finalHasNormalExit = false
            }
            let transformedGotos = Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]()
            for entry in outgoingGotos {
                let (gotoFinallyExit, _, gotoFinallyHasNormalExit, _) = ComputeRegionPointsToSummary(
                    finallyBlock,
                    entry.Value,
                    interesting
                )
                if gotoFinallyHasNormalExit {
                    transformedGotos[entry.Key] = gotoFinallyExit
                }
            }
            UnionGotoMapInto(transformedGotos, finallyGotoExits)
            outgoingGotos.Clear()
            UnionGotoMapInto(outgoingGotos, transformedGotos)
        }
        return TryPointsToSummary(
            filterEntryPointsTo,
            catchEntryPointsTo,
            finallyIn,
            finalState,
            finalHasNormalExit,
            combinedExceptional,
            outgoingGotos
        )
    }

    private class SwitchPointsToSummary {
        init(
            armHeaderStates[]Dictionary[VariableSymbol, HashSet[VariableSymbol]],
            armGuardEntryStates[]Dictionary[VariableSymbol, HashSet[VariableSymbol]],
            armEntryStates[]Dictionary[VariableSymbol, HashSet[VariableSymbol]],
            armLabelEntries Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]],
            afterSwitch Dictionary[VariableSymbol, HashSet[VariableSymbol]],
            hasNormalExit bool,
            combinedExceptional Dictionary[VariableSymbol, HashSet[VariableSymbol]],
            gotoExits Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]
        ) {
            ArmHeaderStates = armHeaderStates
            ArmGuardEntryStates = armGuardEntryStates
            ArmEntryStates = armEntryStates
            ArmLabelEntries = armLabelEntries
            AfterSwitch = afterSwitch
            HasNormalExit = hasNormalExit
            CombinedExceptional = combinedExceptional
            GotoExits = gotoExits
        }

        prop ArmHeaderStates[]Dictionary[VariableSymbol, HashSet[VariableSymbol]] {
            get;
        }
        prop ArmGuardEntryStates[]Dictionary[VariableSymbol, HashSet[VariableSymbol]] {
            get;
        }
        prop ArmEntryStates[]Dictionary[VariableSymbol, HashSet[VariableSymbol]] {
            get;
        }
        prop ArmLabelEntries Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]] {
            get;
        }
        prop AfterSwitch Dictionary[VariableSymbol, HashSet[VariableSymbol]] {
            get;
        }
        prop HasNormalExit bool {
            get;
        }
        prop CombinedExceptional Dictionary[VariableSymbol, HashSet[VariableSymbol]] {
            get;
        }
        prop GotoExits Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]] {
            get;
        }
    }

    private func ComputeSwitchPointsToSummary(
        switchStmt BoundPatternSwitchStatement,
        postDiscriminantState Dictionary[VariableSymbol, HashSet[VariableSymbol]]?,
        interesting HashSet[VariableSymbol]
    ) SwitchPointsToSummary {
        let armCount = switchStmt.Arms.Length
        let armHeaderStates = [armCount]Dictionary[VariableSymbol, HashSet[VariableSymbol]]
        let armGuardEntryStates = [armCount]Dictionary[VariableSymbol, HashSet[VariableSymbol]]
        let armEntryStates = [armCount]Dictionary[VariableSymbol, HashSet[VariableSymbol]]
        let labelToArm = Dictionary[BoundLabel, int]()
        let armLabels = [armCount]List[BoundLabel]
        let allSwitchTargets = HashSet[BoundLabel]()
        for var i = 0; i < armCount; i++ {
            let lc = LabelCollector()
            lc.Visit(switchStmt.Arms[i].Body)
            armLabels[i] = lc.Labels
            for lbl in lc.Labels {
                labelToArm[lbl] = i
            }
            allSwitchTargets.UnionWith(lc.GotoTargets)
        }
        let pendingArmLabelEntries = Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]()
        let armDispatchIn = [armCount]Dictionary[VariableSymbol, HashSet[VariableSymbol]]
        let armReachableFromHeader = [armCount]bool
        var fallthroughState = ClonePointsTo(postDiscriminantState)
        let afterSwitch = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
        var hasNormalExit = false
        let combinedExceptional = ClonePointsTo(postDiscriminantState)
        let outgoingGotos = Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]()
        var fallthroughReachable = true
        var hasUnconditionalDefault = false
        let headerGotos = Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]()
        // Emission evaluates non-default patterns/guards first and dispatches
        // `default` only after all non-default arms fail.
        for var pass = 0; pass < 2; pass++ {
            for var i = 0; i < armCount; i++ {
                let arm = switchStmt.Arms[i]
                if (pass == 0 && arm.IsDefault) || (pass == 1 && !arm.IsDefault) {
                    continue
                }
                if !fallthroughReachable {
                    armHeaderStates[i] = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                    armGuardEntryStates[i] = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                    armDispatchIn[i] = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                    armReachableFromHeader[i] = false
                    continue
                }
                let headerState = ClonePointsTo(fallthroughState)
                armHeaderStates[i] = headerState
                var armIn = ClonePointsTo(headerState)
                var patCanMatch = true
                var patCanFail = false
                if arm.Pattern != nil {
                    let (matched, unmatched, pcm, pcf) = ApplyPatternPointsTo(
                        arm.Pattern,
                        armIn,
                        interesting,
                        combinedExceptional,
                        headerGotos
                    )
                    patCanMatch = pcm
                    patCanFail = pcf
                    if patCanMatch {
                        UnionPointsToInto(combinedExceptional, matched)
                    }
                    if patCanFail {
                        UnionPointsToInto(combinedExceptional, unmatched)
                    }
                    armIn = if patCanMatch {
                        matched
                    } else {
                        Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                    }
                    fallthroughState = if patCanFail {
                        unmatched
                    } else {
                        Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                    }
                }
                armGuardEntryStates[i] = ClonePointsTo(armIn)
                if arm.Guard != nil && patCanMatch {
                    PointsToExpressionUpdater(armIn, interesting, combinedExceptional, headerGotos).VisitExpression(
                        arm.Guard
                    )
                    UnionPointsToInto(combinedExceptional, armIn)
                    if patCanFail {
                        UnionPointsToInto(fallthroughState, armIn)
                    } else {
                        fallthroughState = ClonePointsTo(armIn)
                    }
                } else if !patCanFail {
                    fallthroughReachable = false
                    if arm.IsDefault && patCanMatch {
                        hasUnconditionalDefault = true
                    }
                }
                armReachableFromHeader[i] = patCanMatch
                armDispatchIn[i] = armIn
            }
        }
        let headerOutgoingGotos = Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]()
        for entry in headerGotos {
            if labelToArm.ContainsKey(entry.Key) {
                if !pendingArmLabelEntries.TryGetValue(entry.Key, out var sink) {
                    sink = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                    pendingArmLabelEntries[entry.Key] = sink
                }
                UnionPointsToInto(sink, entry.Value)
            } else {
                if !headerOutgoingGotos.TryGetValue(entry.Key, out var sink) {
                    sink = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                    headerOutgoingGotos[entry.Key] = sink
                }
                UnionPointsToInto(sink, entry.Value)
                UnionPointsToInto(combinedExceptional, entry.Value)
            }
        }
        // Walk arm bodies in source order until cross-arm label entries (fallthrough
        // and interior cross-arm gotos) reach a fixed point.
        let ArmIsReachable = (index int) -> {
            if armReachableFromHeader[index] {
                return true
            }
            for lbl in armLabels[index] {
                if pendingArmLabelEntries.ContainsKey(lbl) {
                    return true
                }
            }
            return false
        }
        var switchChanged = true
        var safety = 0
        while switchChanged && safety++ < 1000 {
            switchChanged = false
            afterSwitch.Clear()
            hasNormalExit = false
            outgoingGotos.Clear()
            UnionGotoMapInto(outgoingGotos, headerOutgoingGotos)
            for var i = 0; i < armCount; i++ {
                let arm = switchStmt.Arms[i]
                let armIn = ClonePointsTo(armDispatchIn[i])
                armEntryStates[i] = armIn
                if !ArmIsReachable(i) {
                    continue
                }
                let (armExit, armExceptional, armHasNormalExit, armGotoExits) = ComputeRegionPointsToSummary(
                    arm.Body,
                    armIn,
                    interesting,
                    pendingArmLabelEntries,
                    allSwitchTargets,
                    allowStartEntry: armReachableFromHeader[i]
                )
                UnionPointsToInto(combinedExceptional, armExceptional)
                if armHasNormalExit {
                    hasNormalExit = true
                    UnionPointsToInto(afterSwitch, armExit)
                }
                for entry in armGotoExits {
                    if labelToArm.ContainsKey(entry.Key) {
                        if !pendingArmLabelEntries.TryGetValue(entry.Key, out var sink) {
                            sink = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                            pendingArmLabelEntries[entry.Key] = sink
                            UnionPointsToInto(sink, entry.Value)
                            switchChanged = true
                        } else {
                            let before = ClonePointsTo(sink)
                            UnionPointsToInto(sink, entry.Value)
                            if !PointsToEqual(before, sink) {
                                switchChanged = true
                            }
                        }
                    } else {
                        if !outgoingGotos.TryGetValue(entry.Key, out var sink) {
                            sink = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                            outgoingGotos[entry.Key] = sink
                        }
                        UnionPointsToInto(sink, entry.Value)
                        UnionPointsToInto(combinedExceptional, entry.Value)
                    }
                }
            }
        }
        if !hasUnconditionalDefault && fallthroughReachable {
            hasNormalExit = true
            UnionPointsToInto(afterSwitch, fallthroughState)
        }
        return SwitchPointsToSummary(
            armHeaderStates,
            armGuardEntryStates,
            armEntryStates,
            pendingArmLabelEntries,
            afterSwitch,
            hasNormalExit,
            combinedExceptional,
            outgoingGotos
        )
    }

    private func AdvancePointsToStatement(
        statement BoundStatement,
        state Dictionary[VariableSymbol, HashSet[VariableSymbol]],
        interesting HashSet[VariableSymbol],
        exceptionalUnion Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil,
        pendingIncomingForBlock Dictionary[
            ControlFlowGraph.BasicBlock,
            Dictionary[VariableSymbol, HashSet[VariableSymbol]]
        ]? = nil,
        labelToBlock Dictionary[BoundLabel, ControlFlowGraph.BasicBlock]? = nil,
        outGotoExits Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]? = nil
    )(FallsThrough bool, PendingGotosChanged bool) {
        let localGotos = Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]()
        switch statement {
            case es is BoundExpressionStatement {
                PointsToExpressionUpdater(state, interesting, exceptionalUnion, localGotos).VisitExpression(
                    es.Expression
                )
                let changed = ForwardGotoExits(localGotos, pendingIncomingForBlock, labelToBlock, outGotoExits)
                let falls = !ControlFlowGraph.HasNeverValue(statement)
                return (falls, changed)
            }
            case vd is BoundVariableDeclaration {
                {
                    PointsToExpressionUpdater(state, interesting, exceptionalUnion, localGotos).VisitStatement(vd)
                    let changed = ForwardGotoExits(localGotos, pendingIncomingForBlock, labelToBlock, outGotoExits)
                    let falls = !ControlFlowGraph.HasNeverValue(statement)
                    return (falls, changed)
                }
            }
            case ys is BoundYieldStatement {
                {
                    if ys.Expression != nil {
                        PointsToExpressionUpdater(state, interesting, exceptionalUnion, localGotos).VisitExpression(
                            ys.Expression
                        )
                    }
                    let changed = ForwardGotoExits(localGotos, pendingIncomingForBlock, labelToBlock, outGotoExits)
                    return (true, changed)
                }
            }
            case rs is BoundReturnStatement {
                {
                    if rs.Expression != nil {
                        PointsToExpressionUpdater(state, interesting, exceptionalUnion, localGotos).VisitExpression(
                            rs.Expression
                        )
                    }
                    let changed = ForwardGotoExits(localGotos, pendingIncomingForBlock, labelToBlock, outGotoExits)
                    return (false, changed)
                }
            }
            case th is BoundThrowStatement {
                {
                    PointsToExpressionUpdater(state, interesting, exceptionalUnion, localGotos).VisitExpression(
                        th.Expression
                    )
                    let changed = ForwardGotoExits(localGotos, pendingIncomingForBlock, labelToBlock, outGotoExits)
                    return (false, changed)
                }
            }
            case BoundRethrowStatement {
                return (false, false)
            }
            case cgs is BoundConditionalGotoStatement {
                {
                    PointsToExpressionUpdater(state, interesting, exceptionalUnion, localGotos).VisitExpression(
                        cgs.Condition
                    )
                    let changed = ForwardGotoExits(localGotos, pendingIncomingForBlock, labelToBlock, outGotoExits)
                    return (true, changed)
                }
            }
            case tryStmt is BoundTryStatement {
                {
                    let summary = ComputeTryPointsToSummary(tryStmt, state, interesting)
                    if exceptionalUnion != nil {
                        UnionPointsToInto(exceptionalUnion, summary.CombinedExceptional)
                    }
                    let changed = ForwardGotoExits(
                        summary.GotoExits,
                        pendingIncomingForBlock,
                        labelToBlock,
                        outGotoExits
                    )
                    state.Clear()
                    if summary.HasNormalExit {
                        UnionPointsToInto(state, summary.AfterTry)
                    }
                    return (summary.HasNormalExit, changed)
                }
            }
            case fixedStmt is BoundFixedStatement {
                {
                    PointsToExpressionUpdater(state, interesting, exceptionalUnion, localGotos).VisitExpression(
                        fixedStmt.PinnedSource
                    )
                    let (bodyExit, bodyExceptional, bodyHasNormalExit, bodyGotoExits) = ComputeRegionPointsToSummary(
                        fixedStmt.Body,
                        state,
                        interesting
                    )
                    if exceptionalUnion != nil {
                        UnionPointsToInto(exceptionalUnion, bodyExceptional)
                    }
                    let changedA = ForwardGotoExits(localGotos, pendingIncomingForBlock, labelToBlock, outGotoExits)
                    let changedB = ForwardGotoExits(bodyGotoExits, pendingIncomingForBlock, labelToBlock, outGotoExits)
                    state.Clear()
                    if bodyHasNormalExit {
                        UnionPointsToInto(state, bodyExit)
                    }
                    return (bodyHasNormalExit, changedA || changedB)
                }
            }
            case switchStmt is BoundPatternSwitchStatement {
                {
                    PointsToExpressionUpdater(state, interesting, exceptionalUnion, localGotos).VisitExpression(
                        switchStmt.Discriminant
                    )
                    let summary = ComputeSwitchPointsToSummary(switchStmt, state, interesting)
                    if exceptionalUnion != nil {
                        UnionPointsToInto(exceptionalUnion, summary.CombinedExceptional)
                    }
                    let changedA = ForwardGotoExits(localGotos, pendingIncomingForBlock, labelToBlock, outGotoExits)
                    let changedB = ForwardGotoExits(
                        summary.GotoExits,
                        pendingIncomingForBlock,
                        labelToBlock,
                        outGotoExits
                    )
                    state.Clear()
                    if summary.HasNormalExit {
                        UnionPointsToInto(state, summary.AfterSwitch)
                    }
                    return (summary.HasNormalExit, changedA || changedB)
                }
            }
            default {
                return (true, false)
            }
        }
    }

    private func GraphMayMutatePointers(graph ControlFlowGraph) bool {
        let detector = PointerMutationDetector()
        for block in graph.Blocks {
            for stmt in block.Statements {
                detector.VisitStatement(stmt)
                if detector.Found {
                    return true
                }
            }
        }
        return false
    }

    private func GraphHasCompoundStatements(graph ControlFlowGraph) bool {
        for block in graph.Blocks {
            for stmt in block.Statements {
                if stmt is BoundTryStatement or BoundFixedStatement or BoundPatternSwitchStatement {
                    return true
                }
            }
        }
        return false
    }

    private func CollectEndExits(
        graph ControlFlowGraph,
        reachable HashSet[ControlFlowGraph.BasicBlock]?,
        blockCanTransfer Dictionary[ControlFlowGraph.BasicBlock, bool]?,
        outMap Dictionary[ControlFlowGraph.BasicBlock, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]?
    )(
        ExitState Dictionary[VariableSymbol, HashSet[VariableSymbol]],
        HasNormalExit bool,
        GotoExits Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]
    ) {
        let exitState = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
        var hasNormalExit = false
        let gotoExits = Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]()
        let lastCodeBlock ControlFlowGraph.BasicBlock? = if graph.Blocks.Count >= 2 {
            graph.Blocks[graph.Blocks.Count - 2]
        } else {
            default(ControlFlowGraph.BasicBlock?)
        }
        for branch in graph.End.Incoming {
            let from = branch.From
            if reachable != nil && !reachable.Contains(from) {
                continue
            }
            if from.IsStart {
                hasNormalExit = true
                if outMap != nil {
                    UnionPointsToInto(exitState, outMap[from])
                }
                continue
            }
            if blockCanTransfer != nil && blockCanTransfer.TryGetValue(from, out var canTransfer) && !canTransfer {
                continue
            }
            let lastStmt = if from.Statements.Count > 0 {
                from.Statements[from.Statements.Count - 1]
            } else {
                default(BoundStatement?)
            }
            if lastStmt is BoundGotoStatement gs {
                if !gotoExits.TryGetValue(gs.Label, out var sink) {
                    sink = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                    gotoExits[gs.Label] = sink
                }
                if outMap != nil {
                    UnionPointsToInto(sink, outMap[from])
                }
                continue
            }
            if !object.ReferenceEquals(from, lastCodeBlock) {
                // Only the final block before End can fall through normally; earlier edges
                // to End come from returns or throws.
                continue
            }
            if lastStmt is BoundReturnStatement or BoundThrowStatement or BoundRethrowStatement {
                continue
            }
            if lastStmt != nil &&
                (ControlFlowGraph.StatementDefinitelyReturns(lastStmt) || ControlFlowGraph.HasNeverValue(lastStmt)) {
                continue
            }
            hasNormalExit = true
            if outMap != nil {
                UnionPointsToInto(exitState, outMap[from])
            }
        }
        return (exitState, hasNormalExit, gotoExits)
    }

    private func ComputeGraphPointsTo(
        graph ControlFlowGraph,
        entryPointsTo Dictionary[VariableSymbol, HashSet[VariableSymbol]]?,
        interesting HashSet[VariableSymbol],
        entryLabelPointsTo IReadOnlyDictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]? = nil,
        allowStartEntry bool = true
    )(
        StatementPointsTo Dictionary[BoundStatement, IReadOnlyDictionary[VariableSymbol, HashSet[VariableSymbol]]]?,
        CompoundEntryPointsTo Dictionary[BoundStatement, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]?,
        ExitState Dictionary[VariableSymbol, HashSet[VariableSymbol]],
        ExceptionalUnion Dictionary[VariableSymbol, HashSet[VariableSymbol]],
        HasNormalExit bool,
        GotoExits Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]
    ) {
        let hasEntry = entryPointsTo != nil && entryPointsTo.Count > 0
        let hasEntryLabels = entryLabelPointsTo != nil && entryLabelPointsTo.Count > 0
        if interesting.Count == 0 ||
            (
            allowStartEntry &&
                !hasEntry &&
                !hasEntryLabels &&
                !GraphMayMutatePointers(graph) &&
                !GraphHasCompoundStatements(graph)
        ) {
            let (fastExit, fastNormal, fastGotos) = CollectEndExits(graph, nil, nil, nil)
            return (nil, nil, fastExit, Dictionary[VariableSymbol, HashSet[VariableSymbol]](), fastNormal, fastGotos)
        }
        let outMap = Dictionary[ControlFlowGraph.BasicBlock, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]()
        let blockCanTransfer = Dictionary[ControlFlowGraph.BasicBlock, bool]()
        let labelToBlock = Dictionary[BoundLabel, ControlFlowGraph.BasicBlock]()
        let pendingIncomingForBlock = Dictionary[
            ControlFlowGraph.BasicBlock,
            Dictionary[VariableSymbol, HashSet[VariableSymbol]]
        ]()
        let reachable = HashSet[ControlFlowGraph.BasicBlock]()
        for b in graph.Blocks {
            outMap[b] = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
            blockCanTransfer[b] = true
            for stmt in b.Statements {
                if stmt is BoundLabelStatement ls {
                    labelToBlock[ls.Label] = b
                }
            }
        }
        let exceptionalUnion = if allowStartEntry {
            ClonePointsTo(entryPointsTo)
        } else {
            Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
        }
        if entryLabelPointsTo != nil {
            for entry in entryLabelPointsTo {
                if labelToBlock.TryGetValue(entry.Key, out var targetBlock) {
                    if !pendingIncomingForBlock.TryGetValue(targetBlock, out var sink) {
                        sink = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                        pendingIncomingForBlock[targetBlock] = sink
                    }
                    UnionPointsToInto(sink, entry.Value)
                    UnionPointsToInto(exceptionalUnion, entry.Value)
                }
            }
        }
        outMap[graph.Start] = ClonePointsTo(entryPointsTo)
        if allowStartEntry {
            reachable.Add(graph.Start)
        }
        let stmtPointsTo = Dictionary[BoundStatement, IReadOnlyDictionary[VariableSymbol, HashSet[VariableSymbol]]](
            ReferenceEqualityComparer.Instance
        )
        let compoundEntryPointsTo = Dictionary[BoundStatement, Dictionary[VariableSymbol, HashSet[VariableSymbol]]](
            ReferenceEqualityComparer.Instance
        )
        let compoundGotos = Dictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]()
        var changed = true
        var safety = 0
        while changed && safety++ < 10000 {
            changed = false
            for block in graph.Blocks {
                if block.IsStart || block.IsEnd {
                    continue
                }
                var anyReachablePred = false
                let state = Dictionary[VariableSymbol, HashSet[VariableSymbol]]()
                for branch in block.Incoming {
                    if reachable.Contains(branch.From) && blockCanTransfer[branch.From] {
                        anyReachablePred = true
                        UnionPointsToInto(state, outMap[branch.From])
                    }
                }
                if pendingIncomingForBlock.TryGetValue(block, out var gotoIn) {
                    anyReachablePred = true
                    UnionPointsToInto(state, gotoIn)
                }
                if !anyReachablePred {
                    continue
                }
                if reachable.Add(block) {
                    changed = true
                }
                var canTransfer = true
                for stmt in block.Statements {
                    stmtPointsTo[stmt] = ClonePointsTo(state)
                    if stmt is BoundTryStatement or BoundFixedStatement or BoundPatternSwitchStatement {
                        compoundEntryPointsTo[stmt] = ClonePointsTo(state)
                    }
                    UnionPointsToInto(exceptionalUnion, state)
                    let (fallsThrough, gotosChanged) = AdvancePointsToStatement(
                        stmt,
                        state,
                        interesting,
                        exceptionalUnion,
                        pendingIncomingForBlock,
                        labelToBlock,
                        compoundGotos
                    )
                    if gotosChanged {
                        changed = true
                    }
                    UnionPointsToInto(exceptionalUnion, state)
                    if !fallsThrough {
                        canTransfer = false
                        break
                    }
                }
                if blockCanTransfer[block] != canTransfer {
                    blockCanTransfer[block] = canTransfer
                    changed = true
                }
                if !PointsToEqual(state, outMap[block]) {
                    outMap[block] = state
                    changed = true
                }
            }
        }
        let (exitState, hasNormalExit, gotoExits) = CollectEndExits(graph, reachable, blockCanTransfer, outMap)
        UnionGotoMapInto(gotoExits, compoundGotos)
        return (stmtPointsTo, compoundEntryPointsTo, exitState, exceptionalUnion, hasNormalExit, gotoExits)
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
        diagnostics ReportingContext?,
        entryPointsTo Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil,
        escapingLabelLiveIn IReadOnlyDictionary[BoundLabel, HashSet[VariableSymbol]]? = nil,
        entryLabelPointsTo IReadOnlyDictionary[BoundLabel, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]? = nil,
        exportedLabelLiveIn Dictionary[BoundLabel, HashSet[VariableSymbol]]? = nil,
        externalEntryLabels IEnumerable[BoundLabel]? = nil
    ) HashSet[VariableSymbol] {
        let graph = ControlFlowGraph.CreateWithCompoundGotoReachability(
            Lowerer.Flatten(regionBody),
            externalEntryLabels
        )
        let (stmtPointsTo, compoundEntryPointsTo, _, _, _, _) = ComputeGraphPointsTo(
            graph,
            entryPointsTo,
            interesting,
            entryLabelPointsTo
        )
        let liveIn = Dictionary[ControlFlowGraph.BasicBlock, HashSet[VariableSymbol]]()
        let labelToBlock = Dictionary[BoundLabel, ControlFlowGraph.BasicBlock]()
        var hasCompound = false
        for b in graph.Blocks {
            liveIn[b] = HashSet[VariableSymbol]()
            for stmt in b.Statements {
                if stmt is BoundLabelStatement ls {
                    labelToBlock[ls.Label] = b
                }
                if stmt is BoundTryStatement or BoundFixedStatement or BoundPatternSwitchStatement {
                    hasCompound = true
                }
            }
        }
        let lastCodeBlock ControlFlowGraph.BasicBlock? = if graph.Blocks.Count >= 2 {
            graph.Blocks[graph.Blocks.Count - 2]
        } else {
            default(ControlFlowGraph.BasicBlock?)
        }
        let ComputeLiveOut = func (block ControlFlowGraph.BasicBlock) HashSet[VariableSymbol] {
            let result = HashSet[VariableSymbol](ambientLive)
            let lastStmt = if block.Statements.Count > 0 {
                block.Statements[block.Statements.Count - 1]
            } else {
                default(BoundStatement?)
            }
            for branch in block.Outgoing {
                if branch.To.IsEnd {
                    if lastStmt is BoundGotoStatement gs &&
                        escapingLabelLiveIn != nil &&
                        escapingLabelLiveIn.TryGetValue(gs.Label, out var gotoLive) {
                        result.UnionWith(gotoLive)
                    } else if lastStmt is BoundConditionalGotoStatement cgs &&
                        escapingLabelLiveIn != nil &&
                        escapingLabelLiveIn
                        .TryGetValue(cgs.Label, out var condGotoLive) {
                        result.UnionWith(condGotoLive)
                        if object.ReferenceEquals(block, lastCodeBlock) &&
                            (block.Outgoing.Count == 1 || !object.ReferenceEquals(branch, block.Outgoing[0])) {
                            result.UnionWith(liveOutOfRegion)
                        }
                    } else {
                        result.UnionWith(liveOutOfRegion)
                    }
                } else {
                    result.UnionWith(liveIn[branch.To])
                }
            }
            return result
        }
        let BuildCurrentLabelLiveIn = func () Dictionary[BoundLabel, HashSet[VariableSymbol]]? {
            if !hasCompound &&
                labelToBlock.Count == 0 &&
                (escapingLabelLiveIn == nil || escapingLabelLiveIn.Count == 0) {
                return nil
            }
            let labelMap = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
            if escapingLabelLiveIn != nil {
                for entry in escapingLabelLiveIn {
                    labelMap[entry.Key] = entry.Value
                }
            }
            for entry in labelToBlock {
                labelMap[entry.Key] = liveIn[entry.Value]
            }
            return labelMap
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
                let currentLabels = BuildCurrentLabelLiveIn()
                let newLiveIn = SimulateBlockBackward(
                    block,
                    liveOut,
                    interesting,
                    diagnostics: nil,
                    stmtPointsTo,
                    compoundEntryPointsTo,
                    currentLabels
                )
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
            let finalLabels = BuildCurrentLabelLiveIn()
            for var i = graph.Blocks.Count - 1; i >= 0; i-- {
                let block = graph.Blocks[i]
                if block.IsStart || block.IsEnd {
                    continue
                }
                let liveOut = ComputeLiveOut(block)
                SimulateBlockBackward(
                    block,
                    liveOut,
                    interesting,
                    diagnostics,
                    stmtPointsTo,
                    compoundEntryPointsTo,
                    finalLabels
                )
            }
        }
        if exportedLabelLiveIn != nil {
            for entry in labelToBlock {
                exportedLabelLiveIn[entry.Key] = HashSet[VariableSymbol](liveIn[entry.Value])
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
        diagnostics ReportingContext?,
        stmtPointsTo Dictionary[BoundStatement, IReadOnlyDictionary[VariableSymbol, HashSet[VariableSymbol]]]? = nil,
        compoundEntryPointsTo Dictionary[BoundStatement, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]? = nil,
        escapingLabelLiveIn IReadOnlyDictionary[BoundLabel, HashSet[VariableSymbol]]? = nil
    ) HashSet[VariableSymbol] {
        let live = HashSet[VariableSymbol](liveOut)
        for var i = block.Statements.Count - 1; i >= 0; i-- {
            ProcessStatementBackward(
                block.Statements[i],
                live,
                interesting,
                diagnostics,
                stmtPointsTo,
                compoundEntryPointsTo,
                escapingLabelLiveIn
            )
        }
        return live
    }

    private func ProcessStatementBackward(
        statement BoundStatement,
        live HashSet[VariableSymbol],
        interesting HashSet[VariableSymbol],
        diagnostics ReportingContext?,
        stmtPointsTo Dictionary[BoundStatement, IReadOnlyDictionary[VariableSymbol, HashSet[VariableSymbol]]]? = nil,
        compoundEntryPointsTo Dictionary[BoundStatement, Dictionary[VariableSymbol, HashSet[VariableSymbol]]]? = nil,
        escapingLabelLiveIn IReadOnlyDictionary[BoundLabel, HashSet[VariableSymbol]]? = nil
    ) {
        var aliasDependencies IReadOnlyDictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil
        if stmtPointsTo != nil {
            stmtPointsTo.TryGetValue(statement, out aliasDependencies)
        }
        var entryPointsTo Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil
        if compoundEntryPointsTo != nil {
            compoundEntryPointsTo.TryGetValue(statement, out entryPointsTo)
        }
        switch statement {
            case es is BoundExpressionStatement {
                ApplyExpression(
                    es.Expression,
                    live,
                    interesting,
                    diagnostics,
                    statement,
                    aliasDependencies,
                    escapingLabelLiveIn
                )
            }
            case vd is BoundVariableDeclaration {
                {
                    let collector = ReadAndAwaitCollector(
                        interesting,
                        aliasDependencies,
                        overwrittenAtEntry: nil,
                        escapingLabelLiveIn
                    )
                    if vd.Initializer is {} initializer {
                        collector.VisitExpression(initializer)
                    }
                    let isInteresting = interesting.Contains(vd.Variable)
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
                        ReportIfUnsafe(live, killTarget, diagnostics, statement, "await", collector.PatternKills)
                    }
                    if collector.InternalUnsafeVariables.Count > 0 {
                        let remainingUnsafe = if collector.ContainsAwait {
                            {
                                let set = HashSet[VariableSymbol](collector.InternalUnsafeVariables)
                                for v in live {
                                    if !object.ReferenceEquals(v, killTarget) && !collector.PatternKills.Contains(v) {
                                        set.Remove(v)
                                    }
                                }
                                set
                            }
                        } else {
                            collector.InternalUnsafeVariables
                        }
                        if remainingUnsafe.Count > 0 {
                            ReportIfUnsafe(remainingUnsafe, excludedSelfKill: nil, diagnostics, statement, "await")
                        }
                    }
                    if killTarget != nil {
                        live.Remove(killTarget)
                    }
                    for killed in collector.PatternKills {
                        live.Remove(killed)
                    }
                }
            }
            case ys is BoundYieldStatement {
                ReportIfUnsafe(live, excludedSelfKill: nil, diagnostics, statement, "yield")
                ApplyExpression(
                    ys.Expression,
                    live,
                    interesting,
                    diagnostics,
                    statement,
                    aliasDependencies,
                    escapingLabelLiveIn
                )
            }
            case rs is BoundReturnStatement {
                if rs.Expression != nil {
                    ApplyExpression(
                        rs.Expression,
                        live,
                        interesting,
                        diagnostics,
                        statement,
                        aliasDependencies,
                        escapingLabelLiveIn
                    )
                }
            }
            case th is BoundThrowStatement {
                ApplyExpression(
                    th.Expression,
                    live,
                    interesting,
                    diagnostics,
                    statement,
                    aliasDependencies,
                    escapingLabelLiveIn
                )
            }
            case BoundRethrowStatement { }
            case cgs is BoundConditionalGotoStatement {
                ApplyExpression(
                    cgs.Condition,
                    live,
                    interesting,
                    diagnostics,
                    statement,
                    aliasDependencies,
                    escapingLabelLiveIn
                )
            }
            case BoundLabelStatement, BoundGotoStatement { }
            case tryStmt is BoundTryStatement {
                ProcessTryBackward(tryStmt, live, interesting, diagnostics, entryPointsTo, escapingLabelLiveIn)
            }
            case fixedStmt is BoundFixedStatement {
                ProcessFixedBackward(fixedStmt, live, interesting, diagnostics, entryPointsTo, escapingLabelLiveIn)
            }
            case switchStmt is BoundPatternSwitchStatement {
                ProcessSwitchBackward(switchStmt, live, interesting, diagnostics, entryPointsTo, escapingLabelLiveIn)
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
        diagnostics ReportingContext?,
        entryPointsTo Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil,
        escapingLabelLiveIn IReadOnlyDictionary[BoundLabel, HashSet[VariableSymbol]]? = nil
    ) {
        let afterTry = HashSet[VariableSymbol](live)
        let hasPointsTo = entryPointsTo != nil ||
            GraphMayMutatePointers(ControlFlowGraph.Create(Lowerer.Flatten(tryStmt)))
        var trySummary TryPointsToSummary? = nil
        if hasPointsTo {
            trySummary = ComputeTryPointsToSummary(tryStmt, entryPointsTo, interesting)
        }
        var finallyLiveIn HashSet[VariableSymbol]? = nil
        var innerEscapingLabels = escapingLabelLiveIn
        if tryStmt.FinallyBlock is {} finallyBlock {
            let finallyOut = HashSet[VariableSymbol](afterTry)
            let escapingTargets = HashSet[BoundLabel]()
            if escapingLabelLiveIn != nil && escapingLabelLiveIn.Count > 0 {
                let lc = LabelCollector()
                lc.Visit(tryStmt.TryBlock)
                for clause in tryStmt.CatchClauses {
                    lc.Visit(clause.Body)
                }
                let localLabels = HashSet[BoundLabel](lc.Labels)
                for target in lc.GotoTargets {
                    if !localLabels.Contains(target) && escapingLabelLiveIn.TryGetValue(target, out var targetLive) {
                        finallyOut.UnionWith(targetLive)
                        escapingTargets.Add(target)
                    }
                }
            }
            finallyLiveIn = AnalyzeRegion(
                finallyBlock,
                finallyOut,
                HashSet[VariableSymbol](),
                interesting,
                diagnostics,
                trySummary?.FinallyIn,
                escapingLabelLiveIn
            )
            if escapingTargets.Count > 0 && escapingLabelLiveIn != nil {
                let transformed = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
                for entry in escapingLabelLiveIn {
                    if escapingTargets.Contains(entry.Key) {
                        transformed[entry.Key] = AnalyzeRegion(
                            finallyBlock,
                            entry.Value,
                            HashSet[VariableSymbol](),
                            interesting,
                            diagnostics: nil,
                            trySummary?.FinallyIn,
                            escapingLabelLiveIn
                        )
                    } else {
                        transformed[entry.Key] = entry.Value
                    }
                }
                innerEscapingLabels = transformed
            }
        }
        // Normal completion of the try body (or a catch clause) falls into
        // finally (if any); otherwise it falls to whatever's after the whole
        // try statement.
        let normalFallthrough = finallyLiveIn ?? afterTry
        let catchAmbient = finallyLiveIn ?? HashSet[VariableSymbol]()
        var subsequentCatchLive = if finallyLiveIn != nil {
            HashSet[VariableSymbol](finallyLiveIn)
        } else {
            HashSet[VariableSymbol]()
        }
        for var i = tryStmt.CatchClauses.Length - 1; i >= 0; i-- {
            let clause = tryStmt.CatchClauses[i]
            var clauseEntry Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil
            trySummary?.CatchEntryPointsTo.TryGetValue(clause, out clauseEntry)
            let catchBodyLiveIn = AnalyzeRegion(
                clause.Body,
                normalFallthrough,
                catchAmbient,
                interesting,
                diagnostics,
                clauseEntry,
                innerEscapingLabels
            )
            var clauseEntryLive HashSet[VariableSymbol]
            if clause.Filter is {} filter {
                var filterEntry Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil
                trySummary?.FilterEntryPointsTo.TryGetValue(clause, out filterEntry)
                clauseEntryLive = HashSet[VariableSymbol](catchBodyLiveIn)
                clauseEntryLive.UnionWith(subsequentCatchLive)
                ApplyExpression(
                    filter,
                    clauseEntryLive,
                    interesting,
                    diagnostics,
                    tryStmt,
                    filterEntry,
                    innerEscapingLabels
                )
                if !ExpressionCannotThrow(filter) {
                    clauseEntryLive.UnionWith(subsequentCatchLive)
                }
            } else {
                clauseEntryLive = HashSet[VariableSymbol](catchBodyLiveIn)
            }
            if clause.Variable != nil {
                clauseEntryLive.Remove(clause.Variable)
            }
            if !IsCatchAllExceptionType(clause.ExceptionType) {
                clauseEntryLive.UnionWith(subsequentCatchLive)
            }
            subsequentCatchLive = clauseEntryLive
        }
        // The try body's own normal exit also falls into finally (or after
        // the statement); the ambient set additionally lets an exception
        // reach a catch/finally from any interior point.
        let tryLiveIn = AnalyzeRegion(
            tryStmt.TryBlock,
            normalFallthrough,
            subsequentCatchLive,
            interesting,
            diagnostics,
            entryPointsTo,
            innerEscapingLabels
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
        diagnostics ReportingContext?,
        entryPointsTo Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil,
        escapingLabelLiveIn IReadOnlyDictionary[BoundLabel, HashSet[VariableSymbol]]? = nil
    ) {
        let bodyLiveIn = AnalyzeRegion(
            fixedStmt.Body,
            live,
            HashSet[VariableSymbol](),
            interesting,
            diagnostics,
            entryPointsTo,
            escapingLabelLiveIn
        )
        bodyLiveIn.Remove(fixedStmt.PinnedVariable)
        bodyLiveIn.Remove(fixedStmt.PointerVariable)
        if fixedStmt.SourceVariable != nil {
            bodyLiveIn.Remove(fixedStmt.SourceVariable)
        }
        live.Clear()
        live.UnionWith(bodyLiveIn)
        ApplyExpression(fixedStmt.PinnedSource, live, interesting, diagnostics, nil, entryPointsTo)
    }

    /// A pattern switch, unlike `select`, can complete having matched no
    /// arm when there's no exhaustive `default` — that "nothing matched"
    /// path must also contribute to what's live before the statement (it
    /// falls straight through to whatever's live after it).
    private func ProcessSwitchBackward(
        switchStmt BoundPatternSwitchStatement,
        live HashSet[VariableSymbol],
        interesting HashSet[VariableSymbol],
        diagnostics ReportingContext?,
        entryPointsTo Dictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil,
        escapingLabelLiveIn IReadOnlyDictionary[BoundLabel, HashSet[VariableSymbol]]? = nil
    ) {
        let afterSwitch = HashSet[VariableSymbol](live)
        let union = HashSet[VariableSymbol]()
        let switchPatternBindings = HashSet[VariableSymbol]()
        var hasUnconditionalDefault = false
        let hasPointsTo = entryPointsTo != nil ||
            GraphMayMutatePointers(ControlFlowGraph.Create(Lowerer.Flatten(switchStmt)))
        var switchSummary SwitchPointsToSummary? = nil
        if hasPointsTo {
            let postDiscriminant = ClonePointsTo(entryPointsTo)
            PointsToExpressionUpdater(postDiscriminant, interesting).VisitExpression(switchStmt.Discriminant)
            switchSummary = ComputeSwitchPointsToSummary(switchStmt, postDiscriminant, interesting)
        }
        let combinedLabels = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
        if escapingLabelLiveIn != nil {
            for entry in escapingLabelLiveIn {
                combinedLabels[entry.Key] = entry.Value
            }
        }
        let armLabelEntries = switchSummary?.ArmLabelEntries
        let allSwitchTargets = HashSet[BoundLabel]()
        for var i = 0; i < switchStmt.Arms.Length; i++ {
            let lc = LabelCollector()
            lc.Visit(switchStmt.Arms[i].Body)
            allSwitchTargets.UnionWith(lc.GotoTargets)
        }
        // Converge exported label live-in sets across all arms (supporting both forward
        // fallthrough/interior jumps and backward jumps between arms).
        var switchChanged = true
        var safety = 0
        while switchChanged && safety++ < 1000 {
            switchChanged = false
            for var i = switchStmt.Arms.Length - 1; i >= 0; i-- {
                let arm = switchStmt.Arms[i]
                let armEntry = if switchSummary != nil {
                    switchSummary.ArmEntryStates[i]
                } else {
                    default(Dictionary[VariableSymbol, HashSet[VariableSymbol]]?)
                }
                let armExported = Dictionary[BoundLabel, HashSet[VariableSymbol]]()
                AnalyzeRegion(
                    arm.Body,
                    afterSwitch,
                    HashSet[VariableSymbol](),
                    interesting,
                    diagnostics: nil,
                    armEntry,
                    combinedLabels,
                    armLabelEntries,
                    armExported,
                    allSwitchTargets
                )
                for entry in armExported {
                    if !combinedLabels.TryGetValue(entry.Key, out var existing) || !SetsEqual(existing, entry.Value) {
                        combinedLabels[entry.Key] = entry.Value
                        switchChanged = true
                    }
                }
            }
        }
        let armCount = switchStmt.Arms.Length
        let armBodyLiveIn = [armCount]HashSet[VariableSymbol]
        for var i = armCount - 1; i >= 0; i-- {
            let arm = switchStmt.Arms[i]
            if arm.IsDefault && arm.Guard == nil && arm.Pattern == nil {
                hasUnconditionalDefault = true
            }
            let armEntry = if switchSummary != nil {
                switchSummary.ArmEntryStates[i]
            } else {
                default(Dictionary[VariableSymbol, HashSet[VariableSymbol]]?)
            }
            armBodyLiveIn[i] = AnalyzeRegion(
                arm.Body,
                afterSwitch,
                HashSet[VariableSymbol](),
                interesting,
                diagnostics,
                armEntry,
                combinedLabels,
                armLabelEntries,
                exportedLabelLiveIn: nil,
                allSwitchTargets
            )
        }
        // Propagate liveness backward along the exact runtime dispatch chain:
        // `default` arm(s) run last (or fall through to `afterSwitch`), preceded by
        // non-default arms tested in source order where failed patterns/guards flow
        // into later arms.
        var fallthroughLive = if !hasUnconditionalDefault {
            HashSet[VariableSymbol](afterSwitch)
        } else {
            HashSet[VariableSymbol]()
        }
        let patternAnalyzer = ReadAndAwaitCollector(interesting)
        for var pass = 1; pass >= 0; pass-- {
            for var i = armCount - 1; i >= 0; i-- {
                let arm = switchStmt.Arms[i]
                if (pass == 1 && !arm.IsDefault) || (pass == 0 && arm.IsDefault) {
                    continue
                }
                let armHeaderState = if switchSummary != nil {
                    switchSummary.ArmHeaderStates[i]
                } else {
                    default(Dictionary[VariableSymbol, HashSet[VariableSymbol]]?)
                }
                let armGuardState = if switchSummary != nil {
                    switchSummary.ArmGuardEntryStates[i]
                } else {
                    default(Dictionary[VariableSymbol, HashSet[VariableSymbol]]?)
                }
                var patCanMatch = true
                var patCanFail = arm.Pattern != nil
                let patMatchedOver = HashSet[VariableSymbol]()
                let patUnmatchedOver = HashSet[VariableSymbol]()
                if arm.Pattern != nil {
                    let (pm, pu, pcm, pcf) = patternAnalyzer.ApplyPatternOverwrites(
                        arm.Pattern,
                        armHeaderState,
                        HashSet[VariableSymbol](),
                        interesting
                    )
                    patMatchedOver.UnionWith(pm)
                    patUnmatchedOver.UnionWith(pu)
                    patCanMatch = pcm
                    patCanFail = pcf
                }
                let matchLive = if patCanMatch {
                    HashSet[VariableSymbol](armBodyLiveIn[i])
                } else {
                    HashSet[VariableSymbol]()
                }
                if arm.Guard != nil && patCanMatch {
                    if !arm.IsDefault || patCanFail {
                        matchLive.UnionWith(fallthroughLive)
                    } else {
                        matchLive.UnionWith(afterSwitch)
                    }
                    ApplyExpression(
                        arm.Guard,
                        matchLive,
                        interesting,
                        diagnostics,
                        switchStmt,
                        armGuardState,
                        escapingLabelLiveIn
                    )
                }
                if arm.Pattern != nil {
                    let armBindings = HashSet[VariableSymbol]()
                    CollectPatternBindings(arm.Pattern, interesting, armBindings)
                    matchLive.ExceptWith(armBindings)
                    let failLive = if patCanFail {
                        HashSet[VariableSymbol](fallthroughLive)
                    } else {
                        HashSet[VariableSymbol]()
                    }
                    matchLive.ExceptWith(patMatchedOver)
                    failLive.ExceptWith(patUnmatchedOver)
                    let stepLive = HashSet[VariableSymbol]()
                    if patCanMatch {
                        stepLive.UnionWith(matchLive)
                    }
                    if patCanFail {
                        stepLive.UnionWith(failLive)
                    }
                    let patternCollector = ReadAndAwaitCollector(
                        interesting,
                        armHeaderState,
                        overwrittenAtEntry: nil,
                        escapingLabelLiveIn
                    )
                    patternCollector.VisitPattern(arm.Pattern)
                    for v in patternCollector.Reads {
                        if !armBindings.Contains(v) || patternCollector.ContainsAwait {
                            stepLive.Add(v)
                        }
                    }
                    if patternCollector.ContainsAwait {
                        ReportIfUnsafe(
                            stepLive,
                            excludedSelfKill: nil,
                            diagnostics,
                            switchStmt,
                            "await",
                            patternCollector.PatternKills
                        )
                    }
                    stepLive.ExceptWith(armBindings)
                    stepLive.ExceptWith(patternCollector.PatternKills)
                    switchPatternBindings.UnionWith(armBindings)
                    fallthroughLive = stepLive
                } else {
                    fallthroughLive = matchLive
                }
            }
        }
        union.UnionWith(fallthroughLive)
        union.ExceptWith(switchPatternBindings)
        live.Clear()
        live.UnionWith(union)
        ApplyExpression(switchStmt.Discriminant, live, interesting, diagnostics, switchStmt, entryPointsTo)
    }

    private func CollectPatternBindings(
        pattern BoundPattern?,
        interesting HashSet[VariableSymbol],
        sink HashSet[VariableSymbol]
    ) {
        if pattern == nil {
            return
        }
        let Record = (variable VariableSymbol?) -> {
            if variable != nil && interesting.Contains(variable) {
                sink.Add(variable)
            }
        }
        switch pattern {
            case BoundDiscardPattern{Variable: {} variable} {
                Record(variable)
            }
            case tp is BoundTypePattern {
                if tp.HasBinding || tp.PropertyPattern != nil {
                    Record(tp.Variable)
                }
                if tp.PropertyPattern != nil {
                    CollectPatternBindings(tp.PropertyPattern, interesting, sink)
                }
            }
            case pp is BoundPropertyPattern {
                Record(pp.InputVariable)
                Record(pp.UnwrappedVariable)
                for field in pp.Fields {
                    Record(field.ValueVariable)
                    CollectPatternBindings(field.Pattern, interesting, sink)
                }
            }
            case rp is BoundRelationalPattern {
                Record(rp.InputVariable)
                Record(rp.ValueVariable)
            }
            case lp is BoundListPattern {
                Record(lp.InputVariable)
                for elem in lp.Elements {
                    CollectPatternBindings(elem, interesting, sink)
                }
            }
            case slice is BoundSlicePattern {
                Record(slice.Variable)
                if slice.Pattern != nil {
                    CollectPatternBindings(slice.Pattern, interesting, sink)
                }
            }
            case bp is BoundBinaryPattern {
                CollectPatternBindings(bp.Left, interesting, sink)
                CollectPatternBindings(bp.Right, interesting, sink)
            }
            case np is BoundNotPattern {
                CollectPatternBindings(np.Pattern, interesting, sink)
            }
        }
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
        owningStatement BoundStatement?,
        aliasDependencies IReadOnlyDictionary[VariableSymbol, HashSet[VariableSymbol]]? = nil,
        escapingLabelLiveIn IReadOnlyDictionary[BoundLabel, HashSet[VariableSymbol]]? = nil
    ) {
        if expression == nil {
            return
        }
        let collector = ReadAndAwaitCollector(
            interesting,
            aliasDependencies,
            overwrittenAtEntry: nil,
            escapingLabelLiveIn
        )
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
            ReportIfUnsafe(live, killTarget, diagnostics, owningStatement, "await", collector.PatternKills)
        }
        if collector.InternalUnsafeVariables.Count > 0 {
            let remainingUnsafe = if collector.ContainsAwait {
                {
                    let set = HashSet[VariableSymbol](collector.InternalUnsafeVariables)
                    for v in live {
                        if !object.ReferenceEquals(v, killTarget) && !collector.PatternKills.Contains(v) {
                            set.Remove(v)
                        }
                    }
                    set
                }
            } else {
                collector.InternalUnsafeVariables
            }
            if remainingUnsafe.Count > 0 {
                ReportIfUnsafe(remainingUnsafe, excludedSelfKill: nil, diagnostics, owningStatement, "await")
            }
        }
        if killTarget != nil {
            live.Remove(killTarget)
        }
        for killed in collector.PatternKills {
            live.Remove(killed)
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
        suspensionKeyword string,
        excludedKills HashSet[VariableSymbol]? = nil
    ) {
        if diagnostics == nil {
            return
        }
        // Synthetic statements stay hidden to stepping; their await retains the diagnostic source.
        let suspensionLocation = AsyncBoundTreeQueries.FindFirstAwaitSyntax(owningStatement)
            ?.Location ??
            default(TextLocation)
        let fallbackLocation = if suspensionLocation.Text != nil {
            suspensionLocation
        } else {
            owningStatement?.Syntax?.Location ?? default(TextLocation)
        }
        for v in live {
            if object.ReferenceEquals(v, excludedSelfKill) || (excludedKills != nil && excludedKills.Contains(v)) {
                continue
            }
            diagnostics.Crossing.Add(v)
            let bag = diagnostics.Diagnostics
            if bag == nil {
                continue
            }
            let location = v.DeclaringSyntax?.Location ?? fallbackLocation
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
            } else if v.Type is ByRefTypeSymbol {
                bag.ReportByRefCannotEscape(
                    location,
                    "the top-level pointer variable '${v.Name}' cannot remain live across $article '$suspensionKeyword' suspension point; restructure the code so its value is no longer needed after the '$suspensionKeyword'"
                )
            } else {
                // Inference can renumber synthesized locals; keep their diagnostics tied to source, not spill ordinals.
                let subject = if v.DeclaringSyntax == nil {
                    "compiler-generated temporary"
                } else {
                    "variable '${v.Name}'"
                }
                bag.ReportByRefLikeEscape(
                    location,
                    v.Type,
                    "be declared as a local in $suspensionContext and remain live across $article '$suspensionKeyword' suspension point ($subject); restructure the code so its value is no longer needed after the '$suspensionKeyword'"
                )
            }
        }
    }
}
