// <copyright file="StatementBinder.NarrowingShadow.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// ADR-0208 section 19, PR 1: the shadow join. At each `if` and `switch`
/// statement the binder computes the narrowing state that the section 9 rule
/// gives after the statement, from the exit states of its branches. It then
/// compares that state with the state the current passes left in the frames.
/// Nothing here changes the frames, the diagnostics or the bound tree. The
/// whole mechanism is off unless (cref:NarrowingComparison.Enabled) is true.
/// @remarks The branches share the frame stack. A kill in one branch edits
/// the outer frames, so the next branch sees fewer facts than it started with.
/// The shadow restores such facts for later branches, unless the later branch
/// kills them itself. This is an approximation of the exit state that PR 2
/// computes exactly by threading the state value.
internal partial class StatementBinder {
    private let shadowExits Dictionary[BoundStatement, NarrowingState] = Dictionary[BoundStatement, NarrowingState]()
    private let shadowJoins Dictionary[BoundStatement, ShadowJoin] = Dictionary[BoundStatement, ShadowJoin]()
    private var shadowListExit NarrowingState = NarrowingState.Empty
    // Effects of the statements bound so far, composed bottom-up from the
    // effects of their child statements (ADR-0208 section 13).
    private let shadowEffects Dictionary[BoundStatement, StatementEffects] = Dictionary[
        BoundStatement,
        StatementEffects
    ]()

    /// The branches of one merge point while the binder binds them.
    private class ShadowFlow {
        init(entry NarrowingState) {
            Entry = entry
            Exits = List[NarrowingState]()
            Lost = List[AccessPath]()
            AssignedByExiting = HashSet[VariableSymbol]()
            Current = entry
            Undo = List[(Path AccessPath, Previous int32)]()
            DefaultExit = -1
            Restored = List[AccessPath]()
            DefaultIn = entry
            DefaultWritten = StatementEffects.Empty
        }

        // The paths that a branch start put back into the overlay.
        prop Restored List[AccessPath] {
            get;
        }

        // The start state and the writes of the default arm.
        prop DefaultIn NarrowingState {
            get;
            set;
        }

        prop DefaultWritten StatementEffects {
            get;
            set;
        }

        // The suppressions that this merge point made, to undo at its end.
        prop Undo List[(Path AccessPath, Previous int32)] {
            get;
        }

        // The position of the default arm exit, or -1: guards bound after it still
        // run before it at run time.
        prop DefaultExit int32 {
            get;
            set;
        }

        // The dispatch state: the entry state with the effects of the header and of
        // every guard bound so far. A branch starts from it (ADR-0208 section 9).
        prop Current NarrowingState {
            get;
            set;
        }

        prop Entry NarrowingState {
            get;
        }

        prop Exits List[NarrowingState] {
            get;
        }

        prop Lost List[AccessPath] {
            get;
        }

        prop AssignedByExiting HashSet[VariableSymbol] {
            get;
        }

        prop HasBareBlock bool {
            get;
            set;
        }
    }

    /// The shadow result for one merge point.
    private class ShadowJoin {
        init(kind string, location string, flow ShadowFlow, result NarrowingState, approximate bool) {
            Kind = kind
            Location = location
            Flow = flow
            Result = result
            Approximate = approximate
        }

        prop Kind string {
            get;
        }

        prop Location string {
            get;
        }

        prop Flow ShadowFlow {
            get;
        }

        prop Result NarrowingState {
            get;
        }

        prop Approximate bool {
            get;
        }
    }

    // What the frames hold now: the state of the current passes.
    private func ShadowFramesRaw() NarrowingState -> NarrowingState.FromFrames(
        binderCtx.NarrowedVariables,
        externalCallableAliases
    )

    // The frames without the inherited facts that a header or a guard removed.
    private func ShadowFrames() NarrowingState {
        var state = ShadowFramesRaw()
        if binderCtx.ShadowSuppressed.Count > 0 {
            for path in state.Paths.ToArray() {
                if binderCtx.ShadowIsSuppressed(path) {
                    state = state.Remove(path)
                }
            }
        }
        return state
    }

    // The state the shadow flow sees now: the frames, plus the overlay facts for paths that no frame holds.
    private func ShadowSnapshot() NarrowingState {
        var state = ShadowFrames()
        for path in binderCtx.ShadowOverlay.Paths {
            // The newer of the frame fact and the overlay fact wins.
            let effective = binderCtx.ShadowEffectiveType(path, state.NarrowedType(path))
            if effective != nil {
                state = state.With(path, effective)
            }
        }
        return state
    }

    /// Starts a statement list. Returns the overlay to restore when it ends.
    private func ShadowEnterList() NarrowingState -> binderCtx.ShadowOverlay

    /// Records the exit state of a statement list and restores the overlay of
    /// the enclosing list. `BindBlockStatements` calls this before it pops its frame.
    private func ShadowLeaveList(savedOverlay NarrowingState, savedBase NarrowingState) {
        if NarrowingComparison.Enabled {
            shadowListExit = ShadowSnapshot()
        }
        binderCtx.ShadowOverlay = savedOverlay
        binderCtx.ShadowOverlayBase = savedBase
    }

    /// Records the exit state of a bound block. A bare block statement also
    /// becomes a comparison point: the facts it lifts must survive its end
    /// (row R3).
    private func ShadowRecordBlock(block BoundBlockStatement, entry ShadowFlow?) {
        if !NarrowingComparison.Enabled {
            return
        }
        let exit = if CanCompleteNormally(block) {
            shadowListExit
        } else {
            NarrowingState.Unreachable
        }
        shadowExits[block] = exit
        if entry != nil && block.Syntax is BlockStatementSyntax blockSyntax {
            entry.Exits.Add(exit)
            shadowJoins[block] = ShadowJoin("block", ShadowLocation(blockSyntax.Location), entry, exit, false)
        }
    }

    /// Starts a merge point. Call it after the condition or discriminant is bound.
    private func ShadowBegin(header BoundExpression? = nil, initializer BoundStatement? = nil) ShadowFlow? {
        if !NarrowingComparison.Enabled {
            return nil
        }
        // The legacy passes invalidate after the whole statement. The condition,
        // the discriminant and the initializer run before any branch, so the
        // branches start from the state after their effects.
        let flow = ShadowFlow(ShadowSnapshot())
        if initializer != nil {
            ShadowApplyEffects(flow, ShadowEffectsOf(initializer, flow.Current))
        }
        if header != nil {
            let collector = NewCollector(nil, externalCallableAliases)
            collector.VisitExpression(header)
            ShadowApplyEffects(flow, ShadowSnapshotEffects(collector, flow.Current))
        }
        return flow
    }

    /// Adds one branch. [`facts`](paramref) are the facts the branch's own
    /// condition proves. [`bound`](paramref) is the bound branch, or `nil` for
    /// the implicit empty branch.
    private func ShadowAddBranch(
        flow ShadowFlow?,
        facts Dictionary[AccessPath, TypeSymbol]?,
        bound BoundStatement?,
        isDefault bool = false
    ) {
        if flow == nil {
            return
        }
        if isDefault {
            flow.DefaultExit = flow.Exits.Count
        }
        var branchIn = flow.Current
        if facts != nil {
            branchIn = branchIn.WithAll(facts)
        }
        if bound == nil {
            flow.Exits.Add(branchIn)
            return
        }
        if isDefault {
            flow.DefaultIn = branchIn
            flow.DefaultWritten = ShadowEffectsOf(bound, branchIn)
        }
        var exit NarrowingState
        if !CanCompleteNormally(bound) {
            exit = NarrowingState.Unreachable
            flow.AssignedByExiting.UnionWith(ShadowEffectsOf(bound).AssignedRoots)
        } else {
            exit = if shadowExits.TryGetValue(bound, out var recorded) {
                recorded
            } else {
                ShadowSnapshot()
            }
        }
        flow.Exits.Add(exit)
        if bound is BoundBlockStatement block {
            for child in block.Statements {
                if child is BoundBlockStatement nested && nested.Syntax is BlockStatementSyntax {
                    flow.HasBareBlock = true
                }
            }
        }
        // A later branch starts from the frames this branch left behind.
        let now = ShadowSnapshot()
        for path in flow.Entry.Paths {
            if now.NarrowedType(path) == nil && !flow.Lost.Any((lost AccessPath) -> lost.Equals(path)) {
                flow.Lost.Add(path)
            }
        }
    }

    // Applies effects that run before the branches, and remembers what they removed.
    private func ShadowApplyEffects(flow ShadowFlow, effects StatementEffects) {
        let before = flow.Current
        let kills = (root VariableSymbol) -> binderCtx.MayBeAssignedByClosure(root)
        flow.Current = before.Kill(effects, kills, MayBeMutatedByEscapedClosure)
        if flow.DefaultExit >= 0 {
            // A guard bound after the default arm runs before it. It removes what the
            // default arm inherited, not what the arm wrote.
            let removed = flow.DefaultIn.Kill(effects, kills, MayBeMutatedByEscapedClosure)
            var exit = flow.Exits[flow.DefaultExit]
            for path in flow.DefaultIn.Paths {
                if removed.NarrowedType(path) == nil && !flow.DefaultWritten.AssignsRoot(path.Root) {
                    exit = exit.Remove(path)
                }
            }
            flow.Exits[flow.DefaultExit] = exit
        }
        for path in before.Paths {
            if flow.Current.NarrowedType(path) == nil {
                // Later reads and exits must not see the inherited frame fact again.
                let had = binderCtx.ShadowSuppressed.TryGetValue(path, out var previous)
                flow.Undo.Add(
                    (
                        path,
                        if had {
                            previous
                        } else {
                            -1
                        }
                    )
                )
                binderCtx.ShadowSuppressed[path] = binderCtx.NarrowedVariables.Count
                binderCtx.ShadowOverlay = binderCtx.ShadowOverlay.Remove(path)
            }
        }
    }

    /// Starts a branch. Facts that an earlier sibling removed from the shared
    /// frames are put back into the overlay, so reads in this branch see them.
    private func ShadowBeginBranch(flow ShadowFlow?) {
        if flow == nil {
            return
        }
        let frames = ShadowFrames()
        for path in flow.Lost {
            let restored = flow.Current.NarrowedType(path)
            if restored != nil && frames.NarrowedType(path) == nil && binderCtx.ShadowOverlay.NarrowedType(
                path
            ) == nil {
                flow.Restored.Add(path)
                binderCtx.ShadowOverlay = binderCtx.ShadowOverlay.With(path, restored)
            }
        }
    }

    /// Adds the effects of a `switch` arm guard to the dispatch state.
    private func ShadowAddGuard(flow ShadowFlow?, guard_ BoundExpression?) {
        if flow == nil || guard_ == nil {
            return
        }
        let collector = NewCollector(nil, externalCallableAliases)
        collector.VisitExpression(guard_)
        ShadowApplyEffects(flow, ShadowSnapshotEffects(collector, flow.Current))
    }

    /// Finishes a merge point and parks the shadow state on the bound statement.
    /// [`reachesWithoutArm`](paramref) adds the entry state as one more
    /// predecessor, for a `switch` that no arm may match.
    private func ShadowFinish(
        flow ShadowFlow?,
        kind string,
        location TextLocation,
        statements[]BoundStatement,
        reachesWithoutArm bool,
        approximate bool
    ) {
        if flow == nil {
            return
        }
        // The restored facts belong to the branches, not to the state after the statement.
        for path in flow.Restored {
            binderCtx.ShadowOverlay = binderCtx.ShadowOverlay.Remove(path)
        }
        for var i = flow.Undo.Count - 1; i >= 0; i-- {
            if flow.Undo[i].Previous < 0 {
                binderCtx.ShadowSuppressed.Remove(flow.Undo[i].Path)
            } else {
                binderCtx.ShadowSuppressed[flow.Undo[i].Path] = flow.Undo[i].Previous
            }
        }
        if reachesWithoutArm {
            // The guards have run on the path where no arm matches.
            flow.Exits.Add(flow.Current)
        }
        let result = NarrowingState.Join(flow.Exits)
        let record = ShadowJoin(kind, ShadowLocation(location), flow, result, approximate)
        for statement in statements {
            shadowExits[statement] = result
            shadowJoins[statement] = record
        }
    }

    private func ShadowLocation(location TextLocation) string -> NarrowingComparison.Format(location)

    // The effects of a statement by one full walk. [`relevant`](paramref) lists
    // the paths of a state: a root of such a path counts as assigned when the
    // collector says so, which also covers implicit field and property roots.
    private func ShadowEffectsOf(statement BoundStatement, relevant NarrowingState? = nil) StatementEffects {
        let collector = NewCollector(nil, externalCallableAliases)
        collector.Visit(statement)
        return ShadowSnapshotEffects(collector, relevant)
    }

    private func ShadowSnapshotEffects(collector AssignedRootsCollector, relevant NarrowingState?) StatementEffects {
        let roots = List[VariableSymbol](collector.Roots)
        if relevant != nil {
            for path in relevant.Paths {
                if !roots.Contains(path.Root) && collector.AssignsRoot(path.Root) {
                    roots.Add(path.Root)
                }
            }
        }
        return StatementEffects.Create(
            roots,
            collector.WritableReferenceRoots,
            collector.MayMutateMemberPaths,
            collector.MayMutateAnyRoot,
            collector.MayMutateAnyRootViaPointer,
            collector.MayMutateGlobalRoots,
            collector.MayMutateWritableReferenceRoots,
            collector.MayRunEscapedClosure
        )
    }

    // Collects the effects of a statement from its own expressions and from the
    // recorded effects of its child statements, which it does not walk again.
    private class ComposingCollector : AssignedRootsCollector {
        init(known Dictionary[BoundStatement, StatementEffects], aliases IEnumerable[VariableSymbol]) : base(
            nil,
            aliases
        ) {
            this.known = known
            Reused = List[StatementEffects]()
        }

        private let known Dictionary[BoundStatement, StatementEffects]

        prop Reused List[StatementEffects] {
            get;
        }

        override func VisitStatement(node BoundStatement?) {
            if node != nil && known.TryGetValue(node, out var recorded) {
                Reused.Add(recorded)
                return
            }
            base.VisitStatement(node)
        }
    }

    private class FunctionLiteralFinder : BoundTreeWalker {
        prop Found bool {
            get;
            private set;
        }

        open override func VisitExpression(node BoundExpression?) {
            if node is BoundFunctionLiteralExpression {
                Found = true
                return
            }
            base.VisitExpression(node)
        }
    }

    // Composes the effects of [`statement`](paramref) bottom-up, records them,
    // and compares them with a full walk. A difference is reported, because it
    // shows an effect that the union of the children does not carry.
    private func ShadowRecordEffects(statement BoundStatement) {
        // The collector analyses a function literal at its call sites, so the union
        // of recorded child records does not equal its result for a statement that
        // contains one. Such a statement is walked, and it stays out of the table.
        let closures = FunctionLiteralFinder()
        closures.Visit(statement)
        if closures.Found {
            CompilationMeasurements.Count("narrowing.effects-walked-for-closure")
            return
        }
        let collector = ComposingCollector(shadowEffects, externalCallableAliases)
        collector.Visit(statement)
        let own = ShadowSnapshotEffects(collector, nil)
        let composed = own.Union(StatementEffects.Compose(collector.Reused))
        CompilationMeasurements.Count("narrowing.effects-composed")
        CompilationMeasurements.Count("narrowing.effects-child-reuses", collector.Reused.Count)
        shadowEffects[statement] = composed
        let walked = ShadowEffectsOf(statement)
        if !composed.SameEffects(walked) {
            // A superset is sound: the parent only removes more facts. A record
            // that lacks an effect of the full walk would keep a fact it must kill.
            NarrowingComparison.ReportJoin(
                NarrowingComparison.Format(statement.Syntax?.Location),
                "<effects>",
                walked.ToString(),
                composed.ToString(),
                if composed.Covers(walked) {
                    "compose-superset"
                } else {
                    "UNCLASSIFIED(effects-compose)"
                }
            )
        }
    }

    /// Compares the shadow state of [`statement`](paramref) with the frames,
    /// then moves the overlay past the statement. Call it after every pass
    /// that follows a statement in a block.
    private func ShadowAfterStatement(statement BoundStatement) {
        if !NarrowingComparison.Enabled {
            return
        }
        ShadowRecordEffects(statement)
        var target = statement
        while target is BoundBlockStatement labeledBlock &&
            labeledBlock.Syntax is LabeledStatementSyntax &&
            labeledBlock
            .Statements
            .Length == 2 &&
            labeledBlock.Statements[0] is BoundLabelStatement {
            target = labeledBlock.Statements[1]
        }
        if !shadowJoins.TryGetValue(target, out var join) {
            if binderCtx.ShadowOverlay.Count > 0 {
                binderCtx.ShadowOverlay = binderCtx.ShadowOverlay.Kill(
                    ShadowEffectsOf(statement, binderCtx.ShadowOverlay),
                    (root VariableSymbol) -> binderCtx.MayBeAssignedByClosure(root),
                    MayBeMutatedByEscapedClosure
                )
            }
            return
        }
        if join.Result.IsUnreachable {
            return
        }
        let old = ShadowFramesRaw()
        let seen = List[AccessPath]()
        let candidates = List[AccessPath]()
        for path in join.Result.Paths {
            candidates.Add(path)
        }
        for path in join.Flow.Entry.Paths {
            candidates.Add(path)
        }
        for exit in join.Flow.Exits {
            for path in exit.Paths {
                candidates.Add(path)
            }
        }
        for path in candidates {
            if seen.Any((other AccessPath) -> other.Equals(path)) {
                continue
            }
            seen.Add(path)
            let oldType = old.NarrowedType(path)
            let newType = join.Result.NarrowedType(path)
            if oldType == nil && newType == nil {
                continue
            }
            if oldType != nil && newType != nil && object.Equals(oldType, newType) {
                continue
            }
            // A fact that an earlier merge point already proved is carried, not new.
            // The shadow state before the statement already held the type, so the
            // earlier merge point reported it.
            if newType != nil && object.Equals(binderCtx.ShadowEffectiveType(path, oldType), newType) {
                continue
            }
            var row = ShadowClassify(join, path, oldType, newType)
            if row.StartsWith("UNCLASSIFIED", StringComparison.Ordinal) {
                // A disagreement outside the ADR table is a defect of the model.
                // Name the branch states so that the cause is readable.
                let exits = string.Join(" | ", join.Flow.Exits.Select((exit NarrowingState) -> exit.ToString()))
                row = "${row} entry=${join.Flow.Entry} exits=${exits}"
            }
            NarrowingComparison.ReportJoin(
                join.Location,
                path.ToString(),
                ShadowText(oldType),
                ShadowText(newType),
                row
            )
        }
        // Past this statement, the shadow facts that the frames lack form the overlay.
        var next = NarrowingState.Empty
        var nextBase = NarrowingState.Empty
        for path in join.Result.Paths {
            let proven = join.Result.NarrowedType(path)!!
            let frameType = old.NarrowedType(path)
            if !object.Equals(frameType, proven) {
                next = next.With(path, proven)
                if frameType != nil {
                    nextBase = nextBase.With(path, frameType)
                }
            }
        }
        binderCtx.ShadowOverlay = next
        binderCtx.ShadowOverlayBase = nextBase
    }

    private func ShadowText(type TypeSymbol?) string -> if type == nil {
        "nil"
    } else {
        type.ToString()
    }

    // Names the row of ADR-0208 section 16 that explains a disagreement.
    private func ShadowClassify(join ShadowJoin, path AccessPath, oldType TypeSymbol?, newType TypeSymbol?) string {
        if newType == nil {
            return "UNCLASSIFIED(old-only)"
        }
        if oldType != nil && Conversion.IsRepresentationPreservingImplicit(oldType, newType) {
            return "UNCLASSIFIED(weaker)"
        }
        if join.Approximate {
            return "approx"
        }
        if join.Kind == "switch" {
            return "R4"
        }
        if join.Kind == "block" {
            return "R3"
        }
        if path.HasMembers {
            return "R5"
        }
        if binderCtx.FunctionContainsUserGotoOrLabel {
            return "R6"
        }
        if join.Flow.AssignedByExiting.Contains(path.Root) {
            return "R2"
        }
        if join.Flow.HasBareBlock {
            return "R3"
        }
        return "R1"
    }
}
