// <copyright file="StatementBinder.Jumps.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Threading

internal partial class StatementBinder {
    private func BindGotoStatement(syntax GotoStatementSyntax) BoundStatement {
        let labelName = syntax.LabelIdentifier.ValueText
        let labelDefined = binderCtx.DefinedUserLabels.Contains(labelName)
        let snapshot = CaptureGotoNarrowingSnapshot()
        if currentStatementListFallsThrough && !labelDefined && !binderCtx.PendingGotoAssignmentStarts.ContainsKey(
            labelName
        ) {
            binderCtx.PendingGotoAssignmentStarts[labelName] = binderCtx.AssignmentNarrowingGeneration
        }
        if currentStatementListFallsThrough && !labelDefined {
            if !binderCtx.PendingGotoNarrowingSnapshots.TryGetValue(labelName, out var snapshots) {
                snapshots = List[GotoNarrowingSnapshot]()
                binderCtx.PendingGotoNarrowingSnapshots[labelName] = snapshots
            }
            snapshots.Add(snapshot)
        } else if currentStatementListFallsThrough && binderCtx.BackwardGotoNarrowingStates.TryGetValue(
            labelName,
            out var backwardState
        ) {
            binderCtx.DeferredUnreachableGotoEdges.Add((nil, labelName, snapshot))
        } else if !currentStatementListFallsThrough && binderCtx.PotentialReachabilityLabel is {} sourceLabel {
            binderCtx.DeferredUnreachableGotoEdges.Add((sourceLabel, labelName, snapshot))
        }
        let label = GetOrCreateUserLabelForGoto(labelName, syntax.LabelIdentifier.Location)
        userGotoHandlerRegions.Add(
            (labelName, syntax.LabelIdentifier.Location, exceptionHandlerRegions.Reverse().ToImmutableArray())
        )
        return BoundGotoStatement(syntax, label)
    }

    /// Issue #1884: resolves the (cref:BoundLabel) a `goto`
    /// targets, creating a placeholder up front when the label has not been
    /// declared yet (a forward reference — the label may appear later in the
    /// same function). The placeholder is recorded in
    /// (cref:BinderContext.UnresolvedGotoLabels) until
    /// (cref:DefineUserLabel) declares it; (cref:FinalizeUserLabels)
    /// reports GS0469 for any name still unresolved once the function finishes
    /// binding.
    private func GetOrCreateUserLabelForGoto(labelName string, location TextLocation) BoundLabel {
        if binderCtx.UserLabels.TryGetValue(labelName, out var label) {
            return label
        }
        label = CreateUserLabel(labelName)
        binderCtx.UserLabels[labelName] = label
        binderCtx.UnresolvedGotoLabels[labelName] = location
        return label
    }

    // Issue #5569: creates the label object of a user label name, reusing the one that the first pass of a
    // retried return value created for the same name.
    private func CreateUserLabel(labelName string) BoundLabel {
        if retriedValueUserLabels?.TryGetValue(labelName, out var label) == true {
            return label
        }
        return BoundLabel(labelName)
    }

    /// Issue #1884: declares a `goto` label at a `label: statement`
    /// site, reusing any placeholder created by an earlier forward-referencing
    /// `goto` ((cref:GetOrCreateUserLabelForGoto)). A second
    /// declaration of the same name in the same function is GS0470.
    private func DefineUserLabel(labelName string, location TextLocation) BoundLabel {
        if !binderCtx.DefinedUserLabels.Add(labelName) {
            Diagnostics.ReportDuplicateGotoLabel(location, labelName)
            // Keep each recovered declaration distinct without changing the canonical goto target.
            return BoundLabel(labelName)
        }
        userLabelHandlerRegions[labelName] = exceptionHandlerRegions.Reverse().ToImmutableArray()
        let wasReachable = currentStatementListFallsThrough
        let incomingSnapshots = InvalidateAssignmentNarrowingsBypassedByGoto(
            labelName,
            currentStatementListFallsThrough
        )
        currentStatementListFallsThrough = currentStatementListFallsThrough ||
            incomingSnapshots != nil &&
            incomingSnapshots.Count > 0
        this.binderCtx.PotentialReachabilityLabel = labelName
        if currentStatementListFallsThrough {
            binderCtx.ReachableUserLabels.Add(labelName)
        }
        if !wasReachable && currentStatementListFallsThrough {
            internalReachabilityGeneration++
        }
        let backwardState = BackwardGotoNarrowingState(CaptureGotoNarrowingSnapshot())
        AddUpstreamLabelDependencies(backwardState, incomingSnapshots)
        binderCtx.BackwardGotoNarrowingStates[labelName] = backwardState
        binderCtx.UnresolvedGotoLabels.Remove(labelName)
        if !binderCtx.UserLabels.TryGetValue(labelName, out var label) {
            label = CreateUserLabel(labelName)
            binderCtx.UserLabels[labelName] = label
        }
        return label
    }

    /// Issue #1884: reports GS0469 for every `goto` target that is still
    /// unresolved once the enclosing function has finished binding. Called
    /// once per function-equivalent binding session (a plain function/method/
    /// constructor/accessor body, or — for top-level statements — once after
    /// all global statements share the synthesized entry point's body).
    internal func FinalizeUserLabels() {
        FinalizeNestedUserLabelNarrowings()
        for entry in binderCtx.UnresolvedGotoLabels {
            Diagnostics.ReportUndefinedGotoLabel(entry.Value, entry.Key)
        }
        for branch in userGotoHandlerRegions {
            if userLabelHandlerRegions.TryGetValue(branch.LabelName, out var targetRegions) &&
                !IsHandlerRegionPrefix(targetRegions, branch.SourceRegions) {
                Diagnostics.ReportGotoIntoExceptionHandler(branch.Location, branch.LabelName)
            }
        }
        binderCtx.UnresolvedGotoLabels.Clear()
        binderCtx.PendingGotoAssignmentStarts.Clear()
        binderCtx.AssignmentNarrowingGenerations.Clear()
        this.binderCtx.AssignmentNarrowingGeneration = 0
        binderCtx.PendingGotoNarrowingSnapshots.Clear()
        binderCtx.BackwardGotoNarrowingStates.Clear()
        boundFinallyBlocks.Clear()
        finallyEntryExternalCallableAliases.Clear()
        finallyFlowSummaries.Clear()
        activeCleanupStatements.Clear()
        activeCleanupRegions.Clear()
        userGotoHandlerRegions.Clear()
        userLabelHandlerRegions.Clear()
        binderCtx.ReachableUserLabels.Clear()
        binderCtx.DeferredUnreachableGotoEdges.Clear()
        this.binderCtx.PotentialReachabilityLabel = nil
    }

    internal func FinalizeNestedUserLabelNarrowings() {
        ActivateDeferredReachableGotoEdges()
        ReportUnsafeBackwardGotoNarrowings()
    }

    private func ActivateDeferredReachableGotoEdges() {
        let remaining = List[(SourceLabel string?, TargetLabel string, Snapshot GotoNarrowingSnapshot)](
            binderCtx.DeferredUnreachableGotoEdges
        )
        var changed = true
        while changed {
            changed = false
            for var i = remaining.Count - 1; i >= 0; i-- {
                let edge = remaining[i]
                if edge.SourceLabel != nil && !binderCtx.ReachableUserLabels.Contains(edge.SourceLabel!!) {
                    continue
                }
                if !binderCtx.BackwardGotoNarrowingStates.TryGetValue(edge.TargetLabel, out var targetState) {
                    remaining.RemoveAt(i)
                    continue
                }
                let targetFinallySet = HashSet[FinallyClauseSyntax](targetState.TargetSnapshot.ActiveFinallyClauses)
                let targetCleanupSet = HashSet[BoundStatement](targetState.TargetSnapshot.ActiveCleanupStatements)
                if !ApplyExitedFinallyEffects(edge.Snapshot.Clone(), targetFinallySet, targetCleanupSet) {
                    remaining.RemoveAt(i)
                    continue
                }
                targetState.Edges.Add(BackwardGotoNarrowingEdge(edge.Snapshot, targetState.Accesses))
                changed |= binderCtx.ReachableUserLabels.Add(edge.TargetLabel)
                remaining.RemoveAt(i)
            }
        }
    }

    private func CaptureGotoNarrowingSnapshot() GotoNarrowingSnapshot {
        let narrowedAtSource = Dictionary[AccessPath, TypeSymbol]()
        let narrowingFrameIndices = Dictionary[AccessPath, int32]()
        let narrowingProofGenerations = Dictionary[AccessPath, int32]()
        // Frames are ordered outermost to innermost, so overwriting records
        // the currently effective narrowing for a repeated root.
        for var i = 0; i < binderCtx.NarrowedVariables.Count; i++ {
            let frame = binderCtx.NarrowedVariables[i]
            for entry in frame {
                narrowedAtSource[entry.Key] = entry.Value
                narrowingFrameIndices[entry.Key] = i
                narrowingProofGenerations[entry.Key] = binderCtx.GetNarrowingProofGeneration(frame)
            }
        }
        return GotoNarrowingSnapshot(
            narrowedAtSource,
            narrowingFrameIndices,
            narrowingProofGenerations,
            binderCtx.AssignmentNarrowingGenerations,
            externalCallableAliases,
            activeFinallyClauses.ToImmutableArray(),
            activeCleanupStatements.ToImmutableArray(),
            activeCleanupRegions.ToImmutableArray(),
            binderCtx.DefinedUserLabels.ToImmutableHashSet()
        )
    }

    private func AddUpstreamLabelDependencies(
        targetState BackwardGotoNarrowingState,
        incomingSnapshots IReadOnlyList[GotoNarrowingSnapshot]?
    ) {
        if incomingSnapshots == nil {
            return
        }
        for path in targetState.TargetSnapshot.NarrowedVariables.Keys {
            for snapshot in incomingSnapshots {
                for priorState in binderCtx.BackwardGotoNarrowingStates {
                    if !snapshot.DefinedLabels.Contains(priorState.Key) ||
                        !NarrowingProofDependsOn(snapshot, priorState.Value.TargetSnapshot, path) {
                        continue
                    }
                    if !targetState.UpstreamLabels.TryGetValue(path, out var labels) {
                        labels = HashSet[string]()
                        targetState.UpstreamLabels.Add(path, labels)
                    }
                    labels.Add(priorState.Key)
                    if priorState.Value.UpstreamLabels.TryGetValue(path, out var upstream) {
                        labels.UnionWith(upstream)
                    }
                }
            }
        }
    }

    /// Binds a loop body while pushing the loop's break/continue labels (and
    /// optional ADR-0070 label name) onto (cref:BinderContext.LoopStack).
    /// @param body The loop body statement.
    /// @param labelName The ADR-0070 label, or `null`.
    /// @param breakLabel The synthesized break label.
    /// @param continueLabel The synthesized continue label.
    /// @param inheritedNarrowingFrameCount Number of active frames whose
    /// narrowings predate this loop iteration.
    /// @param backEdgeTail Optional post/condition evaluation executed
    /// between body completion and the next iteration.
    /// @param backEdgeCondition Optional condition that must be true
    /// before control reaches the next iteration.
    /// @param bindIteration Optional binder for a repeated header and
    /// body, so both are rebound after inherited narrowing is invalidated.
    /// @param iterationRunsUserCode Whether the loop header calls user code
    /// before every body run, as an enumerator `MoveNext` does (ADR-0208 R11, #5170).
    private func BindLoopBody(
        body StatementSyntax,
        labelName string?,
        out breakLabel BoundLabel,
        out continueLabel BoundLabel,
        inheritedNarrowingFrameCount int32 = -1,
        backEdgeTail BoundStatement? = nil,
        backEdgeCondition BoundExpression? = nil,
        bindIteration(() -> (Body BoundStatement, Tail BoundStatement?, Condition BoundExpression?))? = nil,
        iterationRunsUserCode bool = false
    ) BoundStatement {
        var inheritedNarrowingFrameCount = inheritedNarrowingFrameCount
        var backEdgeTail = backEdgeTail
        var backEdgeCondition = backEdgeCondition
        let BindCore = func (out localBreakLabel BoundLabel, out localContinueLabel BoundLabel) BoundStatement {
            binderCtx.LabelCounter++
            localBreakLabel = BoundLabel("break${binderCtx.LabelCounter}")
            localContinueLabel = BoundLabel("continue${binderCtx.LabelCounter}")
            binderCtx.LoopStack.Push((labelName, localBreakLabel, localContinueLabel))
            try {
                if bindIteration != nil {
                    let iteration = bindIteration()
                    backEdgeTail = iteration.Tail
                    backEdgeCondition = iteration.Condition
                    return iteration.Body
                }
                return Invariant.Required(
                    BindStatement(body),
                    "a loop body has a bound statement",
                    expression: "BindStatement(body)"
                )
            } finally {
                binderCtx.LoopStack.Pop()
            }
        }
        inheritedNarrowingFrameCount = if inheritedNarrowingFrameCount < 0 {
            binderCtx.NarrowedVariables.Count
        } else {
            inheritedNarrowingFrameCount
        }
        if !HasActiveNarrowings(inheritedNarrowingFrameCount) {
            return BindCore(out breakLabel, out continueLabel)
        }
        let saved = CaptureSpeculativeBindState()
        let narrowingSnapshots = saved.NarrowingFrames
        // Issue #2943: first bind supplies exact assignment symbols and lowered
        // control flow. If a write can reach the back-edge, restore speculative
        // state, remove only inherited narrowings, and bind the body again.
        // Comparison mode: reports of a bind that is discarded must not reach the report.
        let speculation = NarrowingComparison.BeginSpeculation()
        let firstBody = BindCore(out var firstBreakLabel, out var firstContinueLabel)
        let mutations = CollectLoopBackEdgeMutations(
            firstBody,
            firstBreakLabel,
            firstContinueLabel,
            backEdgeTail,
            backEdgeCondition
        )
        if iterationRunsUserCode {
            mutations.MarkIterationRunsUserCode()
        }
        let loopEntryExternalCallableAliases = ComputeLoopEntryExternalCallableAliases(
            firstBody,
            backEdgeTail,
            firstBreakLabel,
            firstContinueLabel,
            saved.ExternalCallableAliases,
            backEdgeCondition
        )
        let narrowingInvalidations = CollectInheritedNarrowingInvalidations(
            mutations,
            mutations.MayMutateMemberPaths,
            inheritedNarrowingFrameCount,
            narrowingSnapshots
        )
        if narrowingInvalidations.Count == 0 && loopEntryExternalCallableAliases.SetEquals(
            saved.ExternalCallableAliases
        ) {
            NarrowingComparison.EndSpeculation(speculation, true)
            // ADR-0213 slice L0: the walker's lower bound against the analysis above. Report only.
            if NarrowingComparison.LoopsEnabled {
                ReportLoopComparison(body, narrowingSnapshots, inheritedNarrowingFrameCount, narrowingInvalidations)
            }
            breakLabel = firstBreakLabel
            continueLabel = firstContinueLabel
            return firstBody
        }
        NarrowingComparison.EndSpeculation(speculation, false)
        if NarrowingComparison.LoopsEnabled {
            ReportLoopComparison(body, narrowingSnapshots, inheritedNarrowingFrameCount, narrowingInvalidations)
        }
        // ADR-0208 section 18: counts the loop bodies that this design binds twice.
        CompilationMeasurements.Count("narrowing.loop-rebinds")
        RestoreSpeculativeBindState(saved)
        InvalidateInheritedNarrowings(narrowingInvalidations)
        RestoreItems(externalCallableAliases, loopEntryExternalCallableAliases.ToArray())
        return BindCore(out breakLabel, out continueLabel)
    }

    /// The function-wide binder state that a speculative bind can change: diagnostics, narrowing frame
    /// contents, pending exit and goto narrowing states, labels and jumps, callable aliases, assignment
    /// generations, reachability, finally and cleanup bookkeeping, the synthetic local counter, and the held
    /// returns of a speculative lambda body (issue #5569). A loop body (issue #2943) and a speculative lambda
    /// return value (issue #5569) bind again after a restore.
    private sealed class SpeculativeBindState {
        internal let DiagnosticCount int32
        internal let NarrowingFrames[]Dictionary[AccessPath, TypeSymbol]
        internal let PendingEarlyExitFrames[]KeyValuePair[BoundIfStatement, Dictionary[AccessPath, TypeSymbol]]
        internal let PendingSwitchExitFrames[]KeyValuePair[
            BoundPatternSwitchStatement,
            Dictionary[AccessPath, TypeSymbol]
        ]
        internal let DefinedUserLabels[]string
        internal let PendingGotoAssignmentStarts[]KeyValuePair[string, int32]
        internal let ExternalCallableAliases[]VariableSymbol
        internal let AssignmentNarrowingGenerations[]KeyValuePair[VariableSymbol, int32]
        internal let AssignmentNarrowingGeneration int32
        internal let PendingGotoNarrowingSnapshots Dictionary[string, List[GotoNarrowingSnapshot]]
        internal let BackwardGotoNarrowingStates Dictionary[string, BackwardGotoNarrowingState]
        internal let ReachableUserLabels[]string
        internal let DeferredUnreachableGotoEdges[](
            SourceLabel string?,
            TargetLabel string,
            Snapshot GotoNarrowingSnapshot
        )
        internal let PotentialReachabilityLabel string?
        internal let UserLabels[]KeyValuePair[string, BoundLabel]
        internal let UnresolvedGotoLabels[]KeyValuePair[string, TextLocation]
        internal let UserLabelHandlerRegions[]KeyValuePair[string, ImmutableArray[SyntaxNode]]
        internal let UserGotoHandlerRegions[](
            LabelName string,
            Location TextLocation,
            SourceRegions ImmutableArray[SyntaxNode]
        )
        internal let BoundFinallyBlocks[]KeyValuePair[FinallyClauseSyntax, BoundStatement]
        internal let FinallyEntryExternalCallableAliases[]KeyValuePair[
            FinallyClauseSyntax,
            ImmutableArray[VariableSymbol]
        ]
        internal let FinallyFlowSummaries[]KeyValuePair[BoundStatement, FinallyFlowSummary]
        internal let ActiveFinallyClauses[]FinallyClauseSyntax
        internal let ActiveCleanupStatements[]BoundStatement
        internal let ActiveCleanupRegions[]GotoCleanupRegion
        internal let CurrentStatementListFallsThrough bool
        internal let SyntheticLocalCounter int32
        internal let DeferredReturns LambdaBinder.DeferredReturnState?
        internal let DeferredReturnCollections LambdaBinder.DeferredReturnSnapshot?

        init(
            diagnosticCount int32,
            narrowingFrames[]Dictionary[AccessPath, TypeSymbol],
            pendingEarlyExitFrames[]KeyValuePair[BoundIfStatement, Dictionary[AccessPath, TypeSymbol]],
            pendingSwitchExitFrames[]KeyValuePair[BoundPatternSwitchStatement, Dictionary[AccessPath, TypeSymbol]],
            definedUserLabels[]string,
            pendingGotoAssignmentStarts[]KeyValuePair[string, int32],
            externalCallableAliases[]VariableSymbol,
            assignmentNarrowingGenerations[]KeyValuePair[VariableSymbol, int32],
            assignmentNarrowingGeneration int32,
            pendingGotoNarrowingSnapshots Dictionary[string, List[GotoNarrowingSnapshot]],
            backwardGotoNarrowingStates Dictionary[string, BackwardGotoNarrowingState],
            reachableUserLabels[]string,
            deferredUnreachableGotoEdges[](SourceLabel string?, TargetLabel string, Snapshot GotoNarrowingSnapshot),
            potentialReachabilityLabel string?,
            userLabels[]KeyValuePair[string, BoundLabel],
            unresolvedGotoLabels[]KeyValuePair[string, TextLocation],
            userLabelHandlerRegions[]KeyValuePair[string, ImmutableArray[SyntaxNode]],
            userGotoHandlerRegions[](LabelName string, Location TextLocation, SourceRegions ImmutableArray[SyntaxNode]),
            boundFinallyBlocks[]KeyValuePair[FinallyClauseSyntax, BoundStatement],
            finallyEntryExternalCallableAliases[]KeyValuePair[FinallyClauseSyntax, ImmutableArray[VariableSymbol]],
            finallyFlowSummaries[]KeyValuePair[BoundStatement, FinallyFlowSummary],
            activeFinallyClauses[]FinallyClauseSyntax,
            activeCleanupStatements[]BoundStatement,
            activeCleanupRegions[]GotoCleanupRegion,
            currentStatementListFallsThrough bool,
            syntheticLocalCounter int32,
            deferredReturns LambdaBinder.DeferredReturnState?
        ) {
            DiagnosticCount = diagnosticCount
            NarrowingFrames = narrowingFrames
            PendingEarlyExitFrames = pendingEarlyExitFrames
            PendingSwitchExitFrames = pendingSwitchExitFrames
            DefinedUserLabels = definedUserLabels
            PendingGotoAssignmentStarts = pendingGotoAssignmentStarts
            ExternalCallableAliases = externalCallableAliases
            AssignmentNarrowingGenerations = assignmentNarrowingGenerations
            AssignmentNarrowingGeneration = assignmentNarrowingGeneration
            PendingGotoNarrowingSnapshots = pendingGotoNarrowingSnapshots
            BackwardGotoNarrowingStates = backwardGotoNarrowingStates
            ReachableUserLabels = reachableUserLabels
            DeferredUnreachableGotoEdges = deferredUnreachableGotoEdges
            PotentialReachabilityLabel = potentialReachabilityLabel
            UserLabels = userLabels
            UnresolvedGotoLabels = unresolvedGotoLabels
            UserLabelHandlerRegions = userLabelHandlerRegions
            UserGotoHandlerRegions = userGotoHandlerRegions
            BoundFinallyBlocks = boundFinallyBlocks
            FinallyEntryExternalCallableAliases = finallyEntryExternalCallableAliases
            FinallyFlowSummaries = finallyFlowSummaries
            ActiveFinallyClauses = activeFinallyClauses
            ActiveCleanupStatements = activeCleanupStatements
            ActiveCleanupRegions = activeCleanupRegions
            CurrentStatementListFallsThrough = currentStatementListFallsThrough
            SyntheticLocalCounter = syntheticLocalCounter
            DeferredReturns = deferredReturns
            DeferredReturnCollections = deferredReturns?.Capture()
        }
    }

    /// Captures the binder state that (cref:RestoreSpeculativeBindState) puts back. Narrowing frames keep
    /// their identity; only their contents are copied.
    /// @returns The captured state.
    private func CaptureSpeculativeBindState() SpeculativeBindState -> SpeculativeBindState(
        Diagnostics.Count,
        binderCtx
            .NarrowedVariables
            .Select((frame NarrowingFrame) -> Dictionary[AccessPath, TypeSymbol](frame))
            .ToArray(),
        binderCtx.PendingEarlyExitFrames.ToArray(),
        binderCtx.PendingSwitchExitFrames.ToArray(),
        binderCtx.DefinedUserLabels.ToArray(),
        binderCtx.PendingGotoAssignmentStarts.ToArray(),
        externalCallableAliases.ToArray(),
        binderCtx.AssignmentNarrowingGenerations.ToArray(),
        binderCtx.AssignmentNarrowingGeneration,
        binderCtx.PendingGotoNarrowingSnapshots.ToDictionary(
            (entry KeyValuePair[string, List[GotoNarrowingSnapshot]]) -> entry.Key,
            (entry KeyValuePair[string, List[GotoNarrowingSnapshot]]) -> entry
                .Value
                .Select((snapshot GotoNarrowingSnapshot) -> snapshot.Clone())
                .ToList()
        ),
        binderCtx.BackwardGotoNarrowingStates.ToDictionary(
            (entry KeyValuePair[string, BackwardGotoNarrowingState]) -> entry.Key,
            (entry KeyValuePair[string, BackwardGotoNarrowingState]) -> entry.Value.Clone()
        ),
        binderCtx.ReachableUserLabels.ToArray(),
        binderCtx.DeferredUnreachableGotoEdges.ToArray(),
        binderCtx.PotentialReachabilityLabel,
        binderCtx.UserLabels.ToArray(),
        binderCtx.UnresolvedGotoLabels.ToArray(),
        userLabelHandlerRegions.ToArray(),
        userGotoHandlerRegions.ToArray(),
        boundFinallyBlocks.ToArray(),
        finallyEntryExternalCallableAliases.ToArray(),
        finallyFlowSummaries.ToArray(),
        activeFinallyClauses.ToArray(),
        activeCleanupStatements.ToArray(),
        activeCleanupRegions.ToArray(),
        currentStatementListFallsThrough,
        binderCtx.SyntheticLocalCounter,
        function?.DeferredReturns
    )

    /// Puts back the state that (cref:CaptureSpeculativeBindState) captured, and removes the diagnostics
    /// reported after it. The narrowing frames must be the frames of the capture.
    /// @param state The captured state.
    private func RestoreSpeculativeBindState(state SpeculativeBindState) {
        Diagnostics.TruncateTo(state.DiagnosticCount)
        for var i = 0; i < state.NarrowingFrames.Length; i++ {
            let frame = binderCtx.NarrowedVariables[i]
            frame.Clear()
            for entry in state.NarrowingFrames[i] {
                frame.Add(entry.Key, entry.Value)
            }
        }
        RestoreEntries(binderCtx.PendingEarlyExitFrames, state.PendingEarlyExitFrames)
        RestoreEntries(binderCtx.PendingSwitchExitFrames, state.PendingSwitchExitFrames)
        RestoreItems(binderCtx.DefinedUserLabels, state.DefinedUserLabels)
        RestoreEntries(binderCtx.PendingGotoAssignmentStarts, state.PendingGotoAssignmentStarts)
        RestoreItems(externalCallableAliases, state.ExternalCallableAliases)
        RestoreEntries(binderCtx.AssignmentNarrowingGenerations, state.AssignmentNarrowingGenerations)
        this.binderCtx.AssignmentNarrowingGeneration = state.AssignmentNarrowingGeneration
        binderCtx.PendingGotoNarrowingSnapshots.Clear()
        for entry in state.PendingGotoNarrowingSnapshots {
            binderCtx.PendingGotoNarrowingSnapshots.Add(
                entry.Key,
                entry.Value.Select((snapshot GotoNarrowingSnapshot) -> snapshot.Clone()).ToList()
            )
        }
        binderCtx.BackwardGotoNarrowingStates.Clear()
        for entry in state.BackwardGotoNarrowingStates {
            binderCtx.BackwardGotoNarrowingStates.Add(entry.Key, entry.Value.Clone())
        }
        RestoreItems(binderCtx.ReachableUserLabels, state.ReachableUserLabels)
        binderCtx.DeferredUnreachableGotoEdges.Clear()
        binderCtx.DeferredUnreachableGotoEdges.AddRange(state.DeferredUnreachableGotoEdges)
        this.binderCtx.PotentialReachabilityLabel = state.PotentialReachabilityLabel
        RestoreEntries(binderCtx.UserLabels, state.UserLabels)
        RestoreEntries(binderCtx.UnresolvedGotoLabels, state.UnresolvedGotoLabels)
        RestoreEntries(userLabelHandlerRegions, state.UserLabelHandlerRegions)
        userGotoHandlerRegions.Clear()
        for region in state.UserGotoHandlerRegions {
            userGotoHandlerRegions.Add(region)
        }
        RestoreEntries(boundFinallyBlocks, state.BoundFinallyBlocks)
        RestoreEntries(finallyEntryExternalCallableAliases, state.FinallyEntryExternalCallableAliases)
        RestoreEntries(finallyFlowSummaries, state.FinallyFlowSummaries)
        RestoreStack(activeFinallyClauses, state.ActiveFinallyClauses)
        RestoreStack(activeCleanupStatements, state.ActiveCleanupStatements)
        RestoreStack(activeCleanupRegions, state.ActiveCleanupRegions)
        currentStatementListFallsThrough = state.CurrentStatementListFallsThrough
        this.binderCtx.SyntheticLocalCounter = state.SyntheticLocalCounter
        // Issue #5569: the held values, conversions and narrowing uses of a speculative lambda body.
        let deferredReturnCollections = state.DeferredReturnCollections
        if deferredReturnCollections != nil {
            Invariant.Required(
                state.DeferredReturns,
                "captured collections have a state",
                expression: "state.DeferredReturns"
            )
                .Restore(deferredReturnCollections)
        }
    }

    private func RestoreEntries[TKey, TValue](
        destination Dictionary[TKey, TValue],
        snapshot[]KeyValuePair[TKey, TValue]
    ) {
        destination.Clear()
        for entry in snapshot {
            destination.Add(entry.Key, entry.Value)
        }
    }

    private func RestoreItems[T](destination HashSet[T], snapshot[]T) {
        destination.Clear()
        for item in snapshot {
            destination.Add(item)
        }
    }

    // A stack copies to an array top first, so the pushes run from the bottom.
    private func RestoreStack[T](destination Stack[T], snapshot[]T) {
        destination.Clear()
        for var i = snapshot.Length - 1; i >= 0; i-- {
            destination.Push(snapshot[i])
        }
    }

    private func BindBreakStatement(syntax BreakStatementSyntax) BoundStatement {
        if binderCtx.LoopStack.Count == 0 {
            Diagnostics.ReportInvalidBreakOrContinue(syntax.Keyword.Location, syntax.Keyword.Text)
            return BindErrorStatement()
        }
        var breakLabel BoundLabel
        if syntax.LabelIdentifier != nil {
            let name = syntax.LabelIdentifier.ValueText
            for frame in binderCtx.LoopStack {
                if frame.LabelName == name {
                    breakLabel = frame.BreakLabel
                    if currentStatementListFallsThrough {
                        internallyReachableLoopExits.Add(breakLabel)
                    }
                    return BoundGotoStatement(syntax, breakLabel)
                }
            }
            Diagnostics.ReportUnknownLoopLabel(syntax.LabelIdentifier!!.Location, syntax.Keyword.Text, name)
            return BindErrorStatement()
        }
        // Issue #3501 A3: the top frame may be a switch (C#/Go alignment —
        // an unlabeled `break` in a switch arm exits the switch, not the
        // enclosing loop). Record the target so the switch appends its
        // break-label statement only when actually jumped to.
        breakLabel = binderCtx.LoopStack.Peek().BreakLabel
        binderCtx.UsedBreakLabels.Add(breakLabel)
        if currentStatementListFallsThrough {
            internallyReachableLoopExits.Add(breakLabel)
        }
        return BoundGotoStatement(syntax, breakLabel)
    }

    /// Issue #3501 A3: binds a `fallthrough` statement (Go semantics).
    /// Legal only as the LAST statement of a non-final switch arm's body —
    /// `BindSwitchStatement` arms the anchor/target context per arm —
    /// and lowers to a goto targeting the next arm's body-entry label,
    /// skipping that arm's pattern test and guard.
    private func BindFallthroughStatement(syntax FallthroughStatementSyntax) BoundStatement {
        if !object.ReferenceEquals(syntax, binderCtx.CurrentFallthroughAnchor) {
            Diagnostics.ReportFallthroughNotSupported(syntax.Keyword.Location)
            return BindErrorStatement()
        }
        if binderCtx.CurrentFallthroughTarget is not{} target {
            // Well-placed, but this is the switch's final arm — there is no
            // next body to fall into.
            Diagnostics.ReportFallthroughInFinalArm(syntax.Keyword.Location)
            return BindErrorStatement()
        }
        if currentStatementListFallsThrough {
            internallyReachableLoopBacks.Add(target)
        }
        return BoundGotoStatement(syntax, target)
    }

    private func BindContinueStatement(syntax ContinueStatementSyntax) BoundStatement {
        if binderCtx.LoopStack.Count == 0 {
            Diagnostics.ReportInvalidBreakOrContinue(syntax.Keyword.Location, syntax.Keyword.Text)
            return BindErrorStatement()
        }
        if syntax.LabelIdentifier != nil {
            let name = syntax.LabelIdentifier.ValueText
            for frame in binderCtx.LoopStack {
                if frame.LabelName == name && frame.ContinueLabel is {} labeledContinue {
                    if currentStatementListFallsThrough {
                        internallyReachableLoopBacks.Add(labeledContinue)
                    }
                    return BoundGotoStatement(syntax, labeledContinue)
                }
            }
            Diagnostics.ReportUnknownLoopLabel(syntax.LabelIdentifier!!.Location, syntax.Keyword.Text, name)
            return BindErrorStatement()
        }
        // Issue #3501 A3: skip switch frames (null ContinueLabel) — `continue`
        // inside a switch arm still targets the enclosing loop, as in C#/Go.
        for frame in binderCtx.LoopStack {
            if frame.ContinueLabel is {} continueLabel {
                if currentStatementListFallsThrough {
                    internallyReachableLoopBacks.Add(continueLabel)
                }
                return BoundGotoStatement(syntax, continueLabel)
            }
        }
        Diagnostics.ReportInvalidBreakOrContinue(syntax.Keyword.Location, syntax.Keyword.Text)
        return BindErrorStatement()
    }

    /// Issue #5569: binds a target-typed return value of a speculative lambda body in two passes: with the
    /// target type, then with its natural type from the binder state before the value (see
    /// (cref:CaptureSpeculativeBindState)). The body keeps the natural value. The target-typed value and the
    /// diagnostics of both passes wait in [`deferredReturns`](paramref) for the lambda binder's decision, so
    /// another return that fails the target can still use this value's natural type. When the natural pass
    /// fails, the target-typed value stays with its diagnostics. The binder keeps the state of the target pass
    /// when that pass succeeds, and of the natural pass otherwise. The caller passes only values without a
    /// function literal, and a return nested in the value binds in the pass of the value without its own
    /// passes, so each value binds twice and nested values do not multiply the work. Each pass has its own
    /// scope, so a variable that the value declares is not declared twice. A user label keeps one object in both
    /// passes, so a `goto` after the value refers to the label of whichever value the lambda binder selects.
    /// @param syntax The return statement.
    /// @param value The return value.
    /// @param targetType The lambda's target return type.
    /// @param deferredReturns The state of the lambda body.
    /// @param bindTarget Binds the target pass, when it is not the value bound with the target type.
    /// @returns The bound value for the body: the natural one, or the target-typed one when the natural pass fails.
    private func BindDeferredTargetTypedReturn(
        syntax ReturnStatementSyntax,
        value ExpressionSyntax,
        targetType TypeSymbol,
        deferredReturns LambdaBinder.DeferredReturnState,
        bindTarget(() -> BoundExpression)? = nil
    ) BoundExpression {
        let beforeValue = CaptureSpeculativeBindState()
        let targetTyped = BindReturnValuePass(
            deferredReturns,
            true,
            bindTarget ?? (() -> bindExpressionWithTargetType(value, targetType))
        )
        HoldDeferredReturnConversion(deferredReturns, value.Location, targetTyped, targetType)
        let targetDiagnostics = Diagnostics.Skip(beforeValue.DiagnosticCount).ToImmutableArray()
        let afterTarget = CaptureSpeculativeBindState()
        let targetPassLabels = Dictionary[string, BoundLabel](binderCtx.UserLabels)
        RestoreSpeculativeBindState(beforeValue)
        // Synthetic local names stay unique across both passes.
        this.binderCtx.SyntheticLocalCounter = afterTarget.SyntheticLocalCounter
        // Each user label keeps one object in both passes, so the kept state and either bound value agree.
        let outerRetriedLabels = retriedValueUserLabels
        retriedValueUserLabels = targetPassLabels
        var natural BoundExpression
        try {
            natural = BindReturnValuePass(deferredReturns, false, () -> bindExpression(value, false))
        } finally {
            retriedValueUserLabels = outerRetriedLabels
        }
        let naturalDiagnostics = Diagnostics.Skip(beforeValue.DiagnosticCount).ToImmutableArray()
        let naturalCounter = binderCtx.SyntheticLocalCounter
        let naturalFailed = naturalDiagnostics.Any((diagnostic Diagnostic) -> diagnostic.IsError)
        Diagnostics.TruncateTo(beforeValue.DiagnosticCount)
        if naturalFailed || !targetDiagnostics.Any((diagnostic Diagnostic) -> diagnostic.IsError) {
            RestoreSpeculativeBindState(afterTarget)
            this.binderCtx.SyntheticLocalCounter = naturalCounter
        }
        if naturalFailed {
            Diagnostics.AddRange(targetDiagnostics)
            return targetTyped
        }
        deferredReturns.Hold(syntax, targetTyped, targetDiagnostics, naturalDiagnostics)
        return natural
    }

    // Issue #5569: converts a return value of a speculative lambda body to the target where the value binds, as an
    // eager bind does, so the conversion's narrowing checks (backward `goto` uses) apply. The result, its
    // diagnostics and the narrowing uses that only this conversion records wait in the body's state for the lambda
    // binder's decision.
    private func HoldDeferredReturnConversion(
        deferredReturns LambdaBinder.DeferredReturnState,
        location TextLocation,
        value BoundExpression,
        targetType TypeSymbol
    ) {
        let mark = Diagnostics.Count
        let outerOwner = binderCtx.DeferredReturnNarrowingOwner
        this.binderCtx.DeferredReturnNarrowingOwner = deferredReturns
        var converted BoundExpression
        try {
            converted = conversions.BindConversion(location, value, targetType)
        } finally {
            this.binderCtx.DeferredReturnNarrowingOwner = outerOwner
        }
        deferredReturns.HoldConversion(value, converted, Diagnostics.Skip(mark).ToImmutableArray())
        Diagnostics.TruncateTo(mark)
    }

    // Binds one pass of a speculative return value in its own scope, with the pass recorded for nested returns.
    private func BindReturnValuePass(
        deferredReturns LambdaBinder.DeferredReturnState,
        targetPass bool,
        bind() -> BoundExpression
    ) BoundExpression {
        $scope = BoundScope($scope)
        if targetPass {
            deferredReturns.InTargetPass = true
        } else {
            deferredReturns.InNaturalPass = true
        }
        try {
            return bind()
        } finally {
            deferredReturns.InTargetPass = false
            deferredReturns.InNaturalPass = false
            $scope = $scope.Pop()
        }
    }

    private func BindReturnStatement(syntax ReturnStatementSyntax) BoundStatement {
        // ADR-0055 Tier 4: returning an interpolated string where the function's
        // declared type is IFormattable/FormattableString lowers to
        // FormattableStringFactory.Create instead of an eager string.
        if syntax.Expression is InterpolatedStringExpressionSyntax interpolatedReturn &&
            function != nil &&
            function!!.Type != TypeSymbol.Void &&
            isFormattableStringTargetType(function!!.Type) {
            let formattableType = function!!.Type
            let deferredReturns = function!!.DeferredReturns
            // Issue #5569: in a speculative lambda body the formattable value is the target pass of a retried value,
            // so the literal can still take its natural type (a string). A return nested in a value's natural pass
            // binds as a string, below. A hole with a function literal keeps the formattable bind.
            if deferredReturns != nil &&
                !deferredReturns.InTargetPass &&
                !deferredReturns.InNaturalPass &&
                !interpolatedReturn
                .DescendantNodesAndSelf().Any(
                (node SyntaxNode) -> node is LambdaExpressionSyntax or FunctionLiteralExpressionSyntax
            ) {
                return BoundReturnStatement(
                    syntax,
                    BindDeferredTargetTypedReturn(
                        syntax,
                        interpolatedReturn,
                        formattableType,
                        deferredReturns,
                        () -> bindInterpolatedStringAsFormattable(interpolatedReturn, formattableType)
                    )
                )
            }
            if deferredReturns?.InNaturalPass != true {
                return BoundReturnStatement(
                    syntax,
                    bindInterpolatedStringAsFormattable(interpolatedReturn, formattableType)
                )
            }
        }
        // ADR-0100 / issue #795: a bare `return default` takes its type
        // from the enclosing function's declared return type. We special-
        // case it here so the kind dispatcher does not see a bare default
        // without a target and report GS0362. Inferred-return lambdas
        // (function.IsReturnTypeInferred) cannot resolve a target yet, so
        // GS0362 still fires there — the user must write the explicit
        // `default(T)` form when the lambda's return type is being
        // inferred.
        var expression BoundExpression?
        if syntax.Expression is DefaultExpressionSyntax bareReturnDefault &&
            bareReturnDefault.TypeClause == nil &&
            function != nil &&
            !function!!.IsReturnTypeInferred &&
            function!!.Type != TypeSymbol.Void {
            expression = BoundDefaultExpression(bareReturnDefault, function!!.Type)
        } else {
            // Issue #1112 / #1158: a `return switch { … }`, `return if … `, or
            // `return cond ? … : …` honors the function's declared return type
            // as the target type so the result type can unify to the return type
            // (C#-style target-typing) before the conversion below.
            var returnExpression = syntax.Expression
            while returnExpression is ParenthesizedExpressionSyntax parenthesized {
                returnExpression = parenthesized.Expression
            }
            let targetTypesLambdaReturn = returnExpression is LambdaExpressionSyntax lambdaReturn &&
                (
                function == nil || !MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(function!!.Type, out _) ||
                    OverloadResolver.ContainsTargetDependentLambda(lambdaReturn)
            )
            if (
                targetTypesLambdaReturn ||
                    returnExpression is SwitchExpressionSyntax ||
                    returnExpression is IfExpressionSyntax ||
                    returnExpression is IfLetExpressionSyntax ||
                    returnExpression is ConditionalExpressionSyntax ||
                    returnExpression is BlockExpressionSyntax ||
                    IsNullCoalescingExpression(returnExpression)
            ) &&
                function != nil &&
                !function!!.IsReturnTypeInferred &&
                function!!.Type != TypeSymbol.Void &&
                function!!.Type != TypeSymbol
                .Error {
                let value = Invariant.Required(
                    syntax.Expression,
                    "a target-typed return has an expression",
                    expression: "syntax.Expression"
                )
                let deferredReturns = function!!.DeferredReturns
                expression = if deferredReturns?.InNaturalPass == true {
                    // Issue #5569: a return nested in a value that binds with its natural type does the same.
                    bindExpression(value, false)
                } else if deferredReturns != nil &&
                    !deferredReturns.InTargetPass &&
                    !targetTypesLambdaReturn &&
                    !value
                    .DescendantNodesAndSelf().Any(
                    (node SyntaxNode) -> node is LambdaExpressionSyntax or FunctionLiteralExpressionSyntax
                ) {
                    BindDeferredTargetTypedReturn(syntax, value, function!!.Type, deferredReturns)
                } else {
                    bindExpressionWithTargetType(value, function!!.Type)
                }
            } else {
                expression = if syntax.Expression == nil {
                    default(BoundExpression?)
                } else {
                    bindExpression(syntax.Expression, false)
                }
            }
        }
        // Issue #490 (ADR-0060 follow-up): validate the `return ref` / `return` form
        // against the function's declared return ref-kind. Then, for ref returns, wrap
        // the operand in a BoundAddressOfExpression and run lvalue + escape-scope checks.
        var isRefReturn = false
        if function != nil && !function!!.IsExpressionInitializer {
            let fnIsRefReturning = function!!.ReturnRefKind != RefKind.None
            if syntax.IsRefReturn && !fnIsRefReturning {
                Diagnostics.ReportRefReturnInNonRefReturningFunction(
                    Invariant.Required(
                        syntax.RefKeyword,
                        "a ref return has a ref keyword",
                        expression: "syntax.RefKeyword"
                    )
                        .Location,
                    function!!.Name
                )
            } else if !syntax.IsRefReturn && fnIsRefReturning && syntax.Expression != nil {
                // The function is ref-returning but the statement omits `ref`.
                Diagnostics.ReportRefReturnRequiredOnRefReturningFunction(
                    syntax.ReturnKeyword.Location,
                    function!!.Name
                )
            } else if syntax.IsRefReturn && fnIsRefReturning {
                isRefReturn = true
            }
        }
        if function?.IsExpressionInitializer == true {
            if syntax.Expression == nil {
                Diagnostics.ReportInvalidReturn(syntax.ReturnKeyword.Location)
            } else {
                Diagnostics.ReportInvalidReturnExpression(syntax.Expression.Location, function!!.Name)
            }
        } else if function == nil {
            Diagnostics.ReportInvalidReturn(syntax.ReturnKeyword.Location)
        } else if function!!.DefersReturnConversion {
            // Issue #5569: the lambda binder decides the conversion, and reports a missing value, after the body.
            // A value that has no held target-typed value converts to the target now, in the eager bind's state.
            let deferredReturns = Invariant.Required(
                function!!.DeferredReturns,
                "a deferred return conversion has a state",
                expression: "function.DeferredReturns"
            )
            if expression != nil && !deferredReturns.Holds(syntax) && !deferredReturns.HasConversion(expression) {
                HoldDeferredReturnConversion(
                    deferredReturns,
                    Invariant.Required(
                        syntax.Expression,
                        "a return expression is present",
                        expression: "syntax.Expression"
                    )
                        .Location,
                    expression,
                    function!!.Type
                )
            }
        } else if function!!.IsReturnTypeInferred {
            // ADR-0076 / issue #716: arrow-lambda binding deferred return-type
            // resolution to a post-bind pass. The expression has been bound,
            // but we deliberately skip the void / declared-return-type check
            // and the eager conversion; the lambda binder collects the bound
            // expressions, computes the inferred return type (common-type
            // across all return paths and the trailing block expression, if
            // any), and applies a single conversion pass to each return-
            // statement expression once the return type is known.

        } else {
            if function!!.Type == TypeSymbol.Void {
                if expression != nil {
                    Diagnostics.ReportInvalidReturnExpression(
                        Invariant.Required(
                            syntax.Expression,
                            "a return expression is present",
                            expression: "syntax.Expression"
                        )
                            .Location,
                        function!!.Name
                    )
                }
            } else {
                if expression == nil {
                    Diagnostics.ReportMissingReturnExpression(syntax.ReturnKeyword.Location, function!!.Type)
                } else {
                    expression = conversions.BindConversion(
                        Invariant.Required(
                            syntax.Expression,
                            "a return expression is present",
                            expression: "syntax.Expression"
                        )
                            .Location,
                        expression,
                        function!!.Type
                    )
                }
            }
        }
        if expression != nil {
            if ManagedReferenceOrigins.IsScopedHandle(expression) {
                Diagnostics.ReportManagedReference(
                    syntax.Location,
                    "a scoped managed-reference value cannot escape its function"
                )
            }
            // ADR-0039 §4 / ADR-0058: a managed-pointer (*T) value cannot be returned from
            // a function — the callee's stack frame (containing the pointed-to variable) is
            // invalid after the function returns. Diagnose with GS9004.
            // Exception (issue #490): a ref-returning function legitimately yields T&; the
            // managed-pointer wrap happens via the synthesized BoundAddressOfExpression below.
            if expression.Type is ByRefTypeSymbol && !isRefReturn {
                Diagnostics.ReportByRefCannotEscape(
                    Invariant.Required(
                        syntax.Expression,
                        "a by-ref return expression is present",
                        expression: "syntax.Expression"
                    )
                        .Location,
                    "a managed pointer (*T) cannot be returned from a function; managed references must not outlive their declaring scope"
                )
            }
            // ADR-0058 / issue #376: a ref struct value with function-local escape scope
            // cannot be returned. This covers:
            // - direct reference to a `scoped` parameter or local
            // - value derived from a scoped source through constructor, member access, etc.
            if !isRefReturn && TypeSymbol.IsByRefLike(expression.Type) && HasFunctionLocalEscapeScope(expression) {
                Diagnostics.ReportByRefLikeEscape(
                    Invariant.Required(
                        syntax.Expression,
                        "a by-ref-like return expression is present",
                        expression: "syntax.Expression"
                    )
                        .Location,
                    expression.Type,
                    "be returned from a function (value has function-local safe-to-escape scope due to a `scoped` source)"
                )
            }
        }
        // Issue #490: convert a `return ref <lvalue>` into a BoundAddressOfExpression so the
        // emitter knows to take the address (ldloca / ldarga / ldflda / ldelema) and the
        // method signature returns T&. Validate lvalue-ness and ref-safe-to-escape scope.
        if isRefReturn && expression != nil && expression.Type != TypeSymbol.Error {
            if !IsLvalueForRefReturn(expression) ||
                (function?.ReturnRefKind == RefKind.Ref && RefCapabilities.IsReadOnlyStorage(expression)) {
                Diagnostics.ReportRefReturnRequiresLvalue(
                    Invariant.Required(
                        syntax.Expression,
                        "a ref return expression is present",
                        expression: "syntax.Expression"
                    )
                        .Location
                )
            } else if HasFunctionLocalRefScope(expression) {
                // ADR-0184 (the CS8170 analogue): when the reference is rooted at
                // the enclosing struct member's own receiver, generic GS0254
                // does not name the actionable receiver contract — the storage
                // belongs to the CALLER, and the member has not opted out of
                // the implicit `scoped` on `this`. Name the remedy instead.
                let location = Invariant.Required(
                    syntax.Expression,
                    "a ref return expression is present",
                    expression: "syntax.Expression"
                )
                    .Location
                // GS0589 stays first: the two conditions are provably disjoint
                // (IsRootedAtReceiver requires a `this` root, and a struct
                // `this` is never a read-only reference), but the existing
                // ordering is what the current tests pin.
                if IsRootedAtCapturedReceiver(expression, function) {
                    // Issue #4580: a function literal's `this` is the enclosing
                    // struct member's receiver CAPTURED BY VALUE into the
                    // closure, so a reference into it aliases the closure's
                    // private copy, never the caller's storage — even when the
                    // enclosing member is `@UnscopedRef` (HasFunctionLocalRefScope
                    // makes that call). Marking anything `@UnscopedRef` cannot
                    // make that copy the caller's storage, so GS0589's remedy
                    // would mislead; report the generic escaping-storage error.
                    Diagnostics.ReportRefReturnEscapesLocalScope(location)
                } else if IsRootedAtReceiver(expression) {
                    Diagnostics.ReportUnscopedRefRequiredForInstanceState(location)
                } else if IsDefensivelyCopiedReceiverForwarding(expression) {
                    // ADR-0184 amendment: the defensive copy is invisible in
                    // the user's source, so generic GS0254 would not identify
                    // the hidden copy. GS0591 names the copy and remedy.
                    Diagnostics.ReportRefReturnThroughDefensivelyCopiedReceiver(location)
                } else {
                    Diagnostics.ReportRefReturnEscapesLocalScope(location)
                }
            }
            expression = if expression is BoundBlockExpression block {
                cast[BoundExpression](
                    BoundBlockExpression(
                        syntax.Expression,
                        block.Statements,
                        BoundAddressOfExpression(
                            syntax.Expression,
                            block.Expression,
                            unmanaged: false,
                            isReadOnly: function?.ReturnRefKind == RefKind.RefReadOnly
                        )
                    )
                )
            } else {
                cast[BoundExpression](
                    BoundAddressOfExpression(
                        syntax.Expression,
                        expression,
                        unmanaged: false,
                        isReadOnly: function?.ReturnRefKind == RefKind.RefReadOnly
                    )
                )
            }
        }
        return BoundReturnStatement(syntax, expression, isRefReturn)
    }

    /// Issue #490: returns true when [`expr`](paramref)'s ref-safe-to-escape scope is
    /// function-local — i.e. the underlying storage dies at function exit and cannot be
    /// returned as a managed pointer. ADR-0058 conservative single-pass propagation:
    /// returning a local variable, a `scoped` parameter, a field of a local, or any
    /// expression rooted in those is rejected. Returning a parameter (non-`scoped`) or
    /// a field/element of one is permitted (the caller's slot outlives the callee).
    private func HasFunctionLocalRefScope(expr BoundExpression) bool {
        switch expr {
            case v is BoundVariableExpression {
                // Plain locals die with the frame; non-scoped parameters / globals survive.
                // NOTE: this also covers a by-value byref-like (ref struct, e.g. Span<T>)
                // parameter's OWN storage — its fields are a function-local copy exactly
                // like any other by-value struct. Only the REFERENT such a value
                // encapsulates (Span<T>'s backing pointer) gets caller scope; see
                // HasFunctionLocalReferentScope below (issue #4265) for that narrower case.
                if v.Variable is ParameterSymbol p {
                    // ADR-0184 / issue #376: an `@UnscopedRef` struct member's
                    // receiver is the one RefKind.None parameter whose storage
                    // is NOT a function-local by-value slot — the CLR passes a
                    // struct's `this` as `ref S`, so its ref-safe-context is the
                    // caller's once the member opts out of the implicit `scoped`.
                    //
                    // Issue #4580: that holds only for the CURRENT function's own
                    // receiver. Inside a function literal, the enclosing struct
                    // member's `this` is CAPTURED BY VALUE into the closure, so
                    // its storage is the closure's private copy, never the
                    // caller's, whatever the member's opt-out says. Deciding it
                    // here (rather than at each return shape) makes every walk
                    // that reaches the receiver agree: a direct `this.n`, a
                    // forwarding call `this.Slot()` / `Forward(ref this.n)`, and
                    // a ref local initialised from one.
                    return p.GetEffectiveRefScope() == ParameterRefScope.FunctionLocal ||
                        (
                        p.RefKind == RefKind.None &&
                            !(p.IsUnscopedRefReceiver && object.ReferenceEquals(p, function?.ThisParameter))
                    )
                }
                if v.Variable is GlobalVariableSymbol {
                    return false
                }
                // Any other LocalVariableSymbol (let/var inside the function body) is local-scope.
                return v.Variable is LocalVariableSymbol local && (local.RefKind == RefKind.None || local.IsScoped)
            }
            case fa is BoundFieldAccessExpression {
                // Reference type fields live in a heap object — safe regardless of receiver scope.
                if fa.Receiver is {Type: StructSymbol s} && s.IsClass {
                    return false
                }
                // Static field: lives on the type, safe.
                if fa.Receiver == nil {
                    return false
                }
                // Value-type field: inherits the receiver's storage scope.
                return HasFunctionLocalRefScope(fa.Receiver)
            }
            case idx is BoundIndexExpression {
                // Array / slice elements live on the heap (System.Array / underlying buffer);
                // the element's storage outlives the function frame regardless of the local
                // alias used to reach it.
                return false
            }
            case BoundClrPropertyAccessExpression{Member: FieldInfo} field {
                return field.Receiver != nil && !Binder.IsReferenceTypeForConstraint(field.Receiver.Type) &&
                    HasFunctionLocalRefScope(field.Receiver)
            }
            case clrIndex is BoundClrIndexExpression {
                if NativeSliceTypes.TryGetElement(clrIndex.Target.Type, out _, out _) {
                    return false
                }
                // ADR-0184 amendment (hook A): an [UnscopedRef] CLR indexer
                // reached through a READ-ONLY reference is copied before the
                // call exactly like a native member would be, so its result
                // aliases the copy. The Span-shaped branch below is unaffected
                // — IsDefensivelyCopiedReceiverForwarding excludes it.
                if IsDefensivelyCopiedReceiverForwarding(clrIndex) {
                    return true
                }
                return if TypeSymbol.IsByRefLike(clrIndex.Target.Type) && !RefCapabilities.IsUnscopedRefIndexerGetter(
                    clrIndex.Indexer
                ) {
                    HasFunctionLocalReferentScope(clrIndex.Target)
                } else {
                    !Binder.IsReferenceTypeForConstraint(clrIndex.Target.Type) &&
                        HasFunctionLocalRefScope(clrIndex.Target)
                }
            }
            case call is BoundImportedInstanceCallExpression when ManagedReferenceOrigins.IsHandleBorrow(call) {
                return ManagedReferenceOrigins.IsScopedHandle(call.Receiver)
            }
            case deref is BoundDereferenceExpression {
                // A pointer parameter's referent is not its by-value parameter slot.
                // Local pointers conservatively retain function-local scope.
                return if deref.Operand is BoundVariableExpression{Variable: ParameterSymbol pointerParameter} {
                    pointerParameter.IsScoped
                } else {
                    HasFunctionLocalRefScope(deref.Operand)
                }
            }
            case block is BoundBlockExpression {
                return HasFunctionLocalRefScope(block.Expression)
            }
            case condAddr is BoundConditionalAddressExpression {
                return HasFunctionLocalRefScope(condAddr.WhenTrueOperand) ||
                    HasFunctionLocalRefScope(condAddr.WhenFalseOperand)
            }
            default {
                if RefCapabilities.TryGetRefReturnEscapeSources(
                    expr,
                    out var callReceiver,
                    out var byRefArguments,
                    out var byValueByRefLikeArguments
                ) {
                    // ADR-0184 amendment (hook B): checked BEFORE the receiver's
                    // own storage scope, because a defensively copied receiver
                    // is function-local even when the storage it was copied
                    // FROM is the caller's — and, per C#'s narrowest-of rule,
                    // even when the reference ultimately comes from one of the
                    // ref arguments below rather than from the receiver.
                    if IsDefensivelyCopiedReceiverForwarding(expr) {
                        return true
                    }
                    // ADR-0187 / issue #4350: a non-@UnscopedRef member of a
                    // concrete struct receives `this` as `scoped ref`, so its
                    // receiver's storage cannot be the returned reference's
                    // source (C#'s rule). A byref-like receiver's VALUE can
                    // still carry the referent out, exactly like a by-value
                    // byref-like argument.
                    if callReceiver != nil && !Binder.IsReferenceTypeForConstraint(callReceiver.Type) {
                        if RefCapabilities.ReceiverContributesRefScope(expr, callReceiver) {
                            if HasFunctionLocalRefScope(callReceiver) {
                                return true
                            }
                        } else if TypeSymbol.IsByRefLike(callReceiver.Type) &&
                            HasFunctionLocalReferentScope(callReceiver) {
                            return true
                        }
                    }
                    for argument in byRefArguments {
                        if HasFunctionLocalRefScope(argument) {
                            return true
                        }
                    }
                    // Issue #4265: a by-value byref-like argument is checked against
                    // its REFERENT's scope, not its own storage's scope — see
                    // HasFunctionLocalReferentScope. Using HasFunctionLocalRefScope
                    // here instead (like the ref/in/out arguments above) would be
                    // WRONG in the other direction: it would reject every such
                    // forwarding chain outright, since a plain by-value parameter is
                    // always function-local by that check's own (correct, for a
                    // field access) rule.
                    for argument in byValueByRefLikeArguments {
                        if HasFunctionLocalReferentScope(argument) {
                            return true
                        }
                    }
                    return false
                }
                return true
            }
        }
    }

    /// Issue #4265: the ref-safe-to-escape scope of the REFERENT a by-value
    /// byref-like (ref struct, e.g. `Span[T]`) value encapsulates — as
    /// opposed to (cref:HasFunctionLocalRefScope), which answers for
    /// the value's OWN storage (its fields; see that method's
    /// `BoundFieldAccessExpression` case, which this does not change).
    /// A UTF-8 literal's referent is immutable static RVA storage, not its local span descriptor.
    /// Mirrors the `BoundDereferenceExpression` pointer-parameter case
    /// in (cref:HasFunctionLocalRefScope) exactly: a non-scoped
    /// by-value parameter's encapsulated reference is caller-supplied (the
    /// caller already guaranteed its lifetime by constructing/passing the
    /// value), so only a directly-named non-scoped parameter is
    /// caller-scoped here; any other shape (a local, a nested call result,
    /// ...) conservatively falls back to the function-local-by-default walk,
    /// since this compiler does not yet track how a ref-struct LOCAL's own
    /// encapsulated reference was constructed (e.g. `stackalloc` vs.
    /// wrapping a heap array) with C#'s full precision.
    private func HasFunctionLocalReferentScope(expr BoundExpression) bool {
        // This is the by-ref-like value's encapsulated referent scope, not
        // the parameter reference's effective ref scope.
        return if expr is BoundUtf8StringExpression {
            false
        } else if expr is BoundVariableExpression{Variable: ParameterSymbol p} {
            p.GetEffectiveValueScope() == ParameterValueScope.FunctionLocal
        } else {
            HasFunctionLocalRefScope(expr)
        }
    }

    private func BindExpressionStatement(syntax ExpressionStatementSyntax) BoundStatement {
        // ADR-0072 / issue #4967: a `??=` statement discards its value, so it
        // keeps the statement lowering (`if read == nil { write }`) instead
        // of the value-producing one; both share one operand binder.
        if syntax.Expression is NullCoalescingAssignmentExpressionSyntax coalescing &&
            bindNullCoalescingAssignmentStatement is {} bindCoalescingStatement {
            return bindCoalescingStatement(syntax, coalescing)
        }
        let expression = bindExpression(syntax.Expression, true)
        return BoundExpressionStatement(syntax, expression)
    }

    shared {
        private func NarrowingProofDependsOn(
            source GotoNarrowingSnapshot,
            target GotoNarrowingSnapshot,
            path AccessPath
        ) bool -> source
            .NarrowedVariables
            .ContainsKey(path) && source.NarrowingFrameIndices.TryGetValue(path, out var sourceFrame) &&
            target
            .NarrowingFrameIndices
            .TryGetValue(path, out var targetFrame) &&
            sourceFrame == targetFrame &&
            source
            .NarrowingProofGenerations
            .TryGetValue(path, out var sourceProof) && target.NarrowingProofGenerations.TryGetValue(
            path,
            out var targetProof
        ) &&
            sourceProof == targetProof &&
            (
            path.HasMembers || !source.AssignmentGenerations.TryGetValue(path.Root, out var sourceGeneration) ||
                (
                target.AssignmentGenerations.TryGetValue(path.Root, out var targetGeneration) &&
                    sourceGeneration <= targetGeneration
            )
        )

        /// Issue #4285: syntactic (pre-binding) check for whether
        /// [`node`](paramref) — a function/lambda/local-function BODY, or
        /// any subtree of one — contains any user-written `goto` statement
        /// or non-loop `label:` declaration, i.e. any construct that
        /// participates in this function's own goto/label namespace (see
        /// (cref:DefineUserLabel) / (cref:GetOrCreateUserLabelForGoto)).
        /// A `label:` on a loop (ADR-0070, (cref:IsLabelableLoop)) is
        /// excluded: it only names the loop for `break`/`continue` and
        /// is never a valid `goto` target — only (cref:DefineUserLabel)
        /// populates (cref:BinderContext.UserLabels), and
        /// `BindLabeledStatement` never calls it for a loop label — so a
        /// loop label alone cannot create the reachability hazard this check
        /// guards against.
        ///
        /// Does not descend into a nested function-literal or arrow-lambda body
        /// ((cref:FunctionLiteralExpressionSyntax),
        /// (cref:LambdaExpressionSyntax)): those get their own fresh
        /// goto/label namespace and their own fresh
        /// (cref:BinderContext.FunctionContainsUserGotoOrLabel), computed
        /// separately by `LambdaBinder.EnterNestedFrame` when THEIR body is
        /// bound, matching ADR-0070's "label namespace is local to the enclosing
        /// function" rule.
        ///
        /// Likewise does not descend into a (cref:FunctionDeclarationSyntax)
        /// or (cref:EventDeclarationSyntax) (ADR-0146 "rich" anonymous
        /// object literal method/event members, still present as raw syntax
        /// inline in the enclosing expression even though
        /// `Binder.IsRichAnonymousObject` binds them via a synthesized
        /// struct declaration): those members are bound as their own,
        /// independent functions through the ordinary struct-method bind path
        /// (one of the `Binder.cs` call sites that already computes its own
        /// (cref:BinderContext.FunctionContainsUserGotoOrLabel)), so a
        /// `goto`/label inside one must not mark the syntactically
        /// enclosing OUTER function as goto-bearing too — that would
        /// incorrectly over-suppress the outer function's own, otherwise-valid
        /// narrowing lifts.
        ///
        /// Used to populate (cref:BinderContext.FunctionContainsUserGotoOrLabel)
        /// once per function-equivalent binding session, which
        /// (cref:ApplyEarlyExitNarrowings) consults to conservatively
        /// suppress the early-exit / post-switch narrowing lift for the WHOLE
        /// body whenever the function contains any goto/label at all, rather
        /// than pinpointing which SPECIFIC lift site a given `goto` can
        /// actually reach. See the comment on
        /// (cref:ApplyEarlyExitNarrowings) for why a more precise
        /// CFG-based reachability check is a valid future refinement, not
        /// required for this fix.
        internal func ContainsUserGotoOrLabel(node SyntaxNode?) bool {
            switch node {
                case nil {
                    return false
                }
                case GotoStatementSyntax {
                    return true
                }
                case labeled is LabeledStatementSyntax when !IsLabelableLoop(labeled.Statement) {
                    return true
                }
                case FunctionLiteralExpressionSyntax,
                LambdaExpressionSyntax,
                FunctionDeclarationSyntax,
                EventDeclarationSyntax {
                    return false
                }
            }
            for child in node!!.GetChildren() {
                if ContainsUserGotoOrLabel(child) {
                    return true
                }
            }
            return false
        }

        private func ContainsUserLabel(node SyntaxNode?) bool {
            switch node {
                case nil {
                    return false
                }
                case labeled is LabeledStatementSyntax when !IsLabelableLoop(labeled.Statement) {
                    return true
                }
                case FunctionLiteralExpressionSyntax,
                LambdaExpressionSyntax,
                FunctionDeclarationSyntax,
                EventDeclarationSyntax {
                    return false
                }
            }
            return node!!.GetChildren().Any(ContainsUserLabel)
        }

        private func IsHandlerRegionPrefix(
            targetRegions ImmutableArray[SyntaxNode],
            sourceRegions ImmutableArray[SyntaxNode]
        ) bool {
            if targetRegions.Length > sourceRegions.Length {
                return false
            }
            for var i = 0; i < targetRegions.Length; i++ {
                if !object.ReferenceEquals(targetRegions[i], sourceRegions[i]) {
                    return false
                }
            }
            return true
        }

        /// Issue #490: returns true when [`expr`](paramref) denotes a stable lvalue whose
        /// address can be safely taken for a `return ref`.
        private func IsLvalueForRefReturn(expr BoundExpression) bool {
            switch expr {
                case BoundVariableExpression {
                    return true
                }
                case BoundFieldAccessExpression {
                    return ExpressionBinder.IsLvalue(expr)
                }
                case boundClrPropertyAccessExpression is BoundClrPropertyAccessExpression when boundClrPropertyAccessExpression.Member is FieldInfo {
                    return ExpressionBinder.IsLvalue(expr)
                }
                case BoundIndexExpression {
                    return ExpressionBinder.IsLvalue(expr)
                }
                case BoundDereferenceExpression {
                    return true
                }
                case block is BoundBlockExpression {
                    return IsLvalueForRefReturn(block.Expression)
                }
                case BoundCallExpression,
                BoundUserInstanceCallExpression,
                BoundPropertyAccessExpression,
                BoundConstrainedStaticCallExpression {
                    return ExpressionBinder.IsLvalue(expr)
                }
                default {
                    return false
                }
            }
        }

        /// ADR-0184: returns true when [`expr`](paramref) ultimately reads the
        /// enclosing member's own receiver — `this.<field>`, a nested
        /// `this.a.b` chain, or the bare-name spelling that lowers to one — as
        /// opposed to a local, a parameter, or heap storage. Distinguishes the
        /// `@UnscopedRef`-shaped rejection (GS0589) from the generic
        /// escaping-local rejection (GS0254); the walk mirrors
        /// (cref:HasFunctionLocalRefScope)'s own value-type receiver
        /// recursion, so the two agree on which root a reference came from.
        /// @param expr The bound `return ref` operand.
        /// @returns `true` when the reference is rooted at the receiver.
        private func IsRootedAtReceiver(expr BoundExpression) bool -> IsRootedAtReceiverWhere(
            expr,
            capturedOnly: false,
            ownReceiver: nil
        )

        /// Issue #4580: true when [`expr`](paramref) is rooted (per
        /// (cref:IsRootedAtReceiver)'s walk) at a VALUE-TYPE receiver that
        /// is not [`function`](paramref)'s own — i.e. a function literal's
        /// reference into the enclosing struct member's `this`, which the
        /// closure holds as a by-value copy. Such a reference can never alias the
        /// caller's storage, whatever the enclosing member's `@UnscopedRef`
        /// opt-out says about its own receiver.
        /// @param expr The bound `return ref` operand.
        /// @param function The function whose `return ref` is being bound.
        /// @returns `true` when the reference is rooted at a captured receiver.
        private func IsRootedAtCapturedReceiver(
            expr BoundExpression,
            function FunctionSymbol?
        ) bool -> IsRootedAtReceiverWhere(expr, capturedOnly: true, ownReceiver: function?.ThisParameter)

        private func IsRootedAtReceiverWhere(
            expr BoundExpression,
            capturedOnly bool,
            ownReceiver ParameterSymbol?
        ) bool -> switch expr {
            case BoundVariableExpression{
                Variable: ParameterSymbol{IsReceiverParameter: true} receiver
            }: !capturedOnly ||
                !object.ReferenceEquals(receiver, ownReceiver)
            case BoundFieldAccessExpression{Receiver: {} fieldReceiver}: !Binder.IsReferenceTypeForConstraint(
                fieldReceiver.Type
            ) &&
                IsRootedAtReceiverWhere(fieldReceiver, capturedOnly, ownReceiver)
            case BoundClrPropertyAccessExpression{
                Member: FieldInfo,
                Receiver: {} clrReceiver
            }: !Binder.IsReferenceTypeForConstraint(clrReceiver.Type) &&
                IsRootedAtReceiverWhere(clrReceiver, capturedOnly, ownReceiver)
            case block is BoundBlockExpression: IsRootedAtReceiverWhere(block.Expression, capturedOnly, ownReceiver)
            case conditional is BoundConditionalAddressExpression: IsRootedAtReceiverWhere(
                conditional.WhenTrueOperand,
                capturedOnly,
                ownReceiver
            ) ||
                IsRootedAtReceiverWhere(conditional.WhenFalseOperand, capturedOnly, ownReceiver)
            default: false
        }

        /// ADR-0184 amendment (caller side): true when [`expr`](paramref)
        /// forwards a reference out of a ref-returning member whose VALUE-TYPE
        /// receiver the emitter replaces with a defensive COPY in a function-local
        /// temp — see (cref:RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy),
        /// the single rule this and the three emitter copy sites now share. The
        /// member's own `return ref` was validated against ITS receiver, which
        /// the caller then substitutes; any reference into the receiver's own
        /// storage therefore points at a temp that dies at function exit. Real csc
        /// rejects the C# analogue (CS8156).
        ///
        /// Deliberately EXCLUDES the Span-shaped CLR indexer branch: that result
        /// points into the ENCAPSULATED BUFFER the receiver merely wraps, not into
        /// the receiver's own storage, so copying the receiver (its pointer and
        /// length) does not disturb the referent at all — issue #4265's premise,
        /// still correct. The exclusion lapses exactly when the CLR author marked
        /// the indexer `[UnscopedRef]`, which declares the opposite.
        ///
        /// The `BoundDereferenceExpression` arm is load bearing for DIAGNOSTIC
        /// SELECTION only, never for soundness: `ConversionClassifier.AutoDereferenceRefReturn`
        /// wraps every imported/CLR ref-returning member read in one, so without it
        /// the CLR-indexer case below is still correctly REJECTED (hook A sees the
        /// unwrapped node through (cref:HasFunctionLocalRefScope)'s own
        /// dereference recursion) but is reported as the generic GS0254 instead of
        /// GS0591. Adding it cannot over-reject: this predicate is consulted only
        /// after (cref:HasFunctionLocalRefScope) has already said no.
        /// @param expr The bound `return ref` operand.
        /// @returns `true` when the forward crosses a defensively copied receiver.
        private func IsDefensivelyCopiedReceiverForwarding(expr BoundExpression) bool {
            switch expr {
                case block is BoundBlockExpression {
                    return IsDefensivelyCopiedReceiverForwarding(block.Expression)
                }
                case dereference is BoundDereferenceExpression {
                    return IsDefensivelyCopiedReceiverForwarding(dereference.Operand)
                }
                case conditional is BoundConditionalAddressExpression {
                    return IsDefensivelyCopiedReceiverForwarding(conditional.WhenTrueOperand) ||
                        IsDefensivelyCopiedReceiverForwarding(conditional.WhenFalseOperand)
                }
                case clrIndex is BoundClrIndexExpression when !TypeSymbol.IsByRefLike(clrIndex.Target.Type) ||
                    RefCapabilities
                    .IsUnscopedRefIndexerGetter(clrIndex.Indexer) {
                    return !Binder.IsReferenceTypeForConstraint(clrIndex.Target.Type) &&
                        RefCapabilities
                        .RequiresReadOnlyReceiverDefensiveCopy(
                        clrIndex.Target,
                        clrIndex.Indexer.GetMethod is {} getter && RefCapabilities.IsReadOnlyMethod(getter)
                    )
                }
                default {
                    // isReadOnlyMember is omitted (defaults false): G# has no
                    // `readonly func`, so a NATIVE ref-returning member is never
                    // exempt from the copy. A future `readonly` member feature MUST
                    // thread it through here.
                    // ADR-0187: a copy matters only when the member may return a
                    // reference into its receiver at all (@UnscopedRef, or a
                    // receiver shape that cannot prove it does not).
                    return RefCapabilities.TryGetRefReturnEscapeSources(expr, out var receiver, out _, out _) &&
                        receiver != nil &&
                        !Binder.IsReferenceTypeForConstraint(receiver.Type) &&
                        RefCapabilities.ReceiverContributesRefScope(expr, receiver) &&
                        RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy(receiver)
                }
            }
        }

        // ADR-0058 / issue #376: determines whether a bound expression has function-local
        // safe-to-escape scope. Used by the return-statement check and by STE propagation
        // through initializers to detect when a ref struct value is rooted in a scoped source.
        private func HasFunctionLocalEscapeScope(expression BoundExpression) bool {
            switch expression {
                case varExpr is BoundVariableExpression {
                    return switch varExpr.Variable {
                        case parameterSymbol is ParameterSymbol when parameterSymbol.IsReceiverParameter == true: false
                        case parameter is ParameterSymbol: parameter.GetEffectiveValueScope() == ParameterValueScope.FunctionLocal
                        case local is LocalVariableSymbol: local.IsScoped
                        default: false
                    }
                }
                case conv is BoundConversionExpression {
                    return HasFunctionLocalEscapeScope(conv.Expression)
                }
                case ctor is BoundConstructorCallExpression {
                    for arg in ctor.Arguments {
                        if TypeSymbol.IsByRefLike(arg.Type) && HasFunctionLocalEscapeScope(arg) {
                            return true
                        }
                    }
                    return false
                }
                case clrCtor is BoundClrConstructorCallExpression {
                    for arg in clrCtor.Arguments {
                        if TypeSymbol.IsByRefLike(arg.Type) && HasFunctionLocalEscapeScope(arg) {
                            return true
                        }
                    }
                    return false
                }
                case fieldAccess is BoundFieldAccessExpression {
                    if fieldAccess.Receiver != nil && TypeSymbol.IsByRefLike(fieldAccess.Receiver.Type) {
                        return HasFunctionLocalEscapeScope(fieldAccess.Receiver)
                    }
                    return false
                }
                case userCall is BoundUserInstanceCallExpression {
                    if userCall.Receiver != nil && TypeSymbol.IsByRefLike(userCall.Receiver.Type) &&
                        HasFunctionLocalEscapeScope(userCall.Receiver) {
                        return true
                    }
                    for arg in userCall.Arguments {
                        if TypeSymbol.IsByRefLike(arg.Type) && HasFunctionLocalEscapeScope(arg) {
                            return true
                        }
                    }
                    return false
                }
                case importedCall is BoundImportedInstanceCallExpression {
                    if importedCall.Receiver != nil && TypeSymbol.IsByRefLike(importedCall.Receiver.Type) &&
                        HasFunctionLocalEscapeScope(importedCall.Receiver) {
                        return true
                    }
                    for arg in importedCall.Arguments {
                        if TypeSymbol.IsByRefLike(arg.Type) && HasFunctionLocalEscapeScope(arg) {
                            return true
                        }
                    }
                    return false
                }
                case call is BoundCallExpression {
                    for arg in call.Arguments {
                        if TypeSymbol.IsByRefLike(arg.Type) && HasFunctionLocalEscapeScope(arg) {
                            return true
                        }
                    }
                    return false
                }
                case importedStatic is BoundImportedCallExpression {
                    for arg in importedStatic.Arguments {
                        if TypeSymbol.IsByRefLike(arg.Type) && HasFunctionLocalEscapeScope(arg) {
                            return true
                        }
                    }
                    return false
                }
                default {
                    return false
                }
            }
        }
    }
}
