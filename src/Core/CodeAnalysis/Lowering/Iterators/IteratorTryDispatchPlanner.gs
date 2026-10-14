// <copyright file="IteratorTryDispatchPlanner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Iterators

import GSharp.Core.CodeAnalysis.Binding
import System.Collections.Generic
import System.Collections.Immutable

/// Pre-pass walker that builds a (cref:IteratorTryDispatchPlan) from
/// the user iterator body by locating each `yield` within the lexical
/// nesting of user `try` statements.
/// @remarks The CLR forbids branching `br`/`brtrue`/`brfalse`
/// into a protected (try) region from outside. The outer `MoveNext`
/// state dispatch therefore cannot jump directly to a resume label that lies
/// inside a user try. Instead, a synthesized <i>entry label</i> is placed
/// immediately before each user try with yields, and the outer dispatch
/// routes there. Inside that try a second dispatch then either routes
/// further (to a nested try's entry label) or to a resume label for a
/// yield directly in that try.
///
/// The plan also captures, for each user `try` that has a
/// `finally` block and contains yields, the set of yield states inside
/// it (innermost-first). The Dispose synthesizer uses the per-try yield-state
/// sets to emit a finally walk that runs each pending `finally` when an
/// in-progress enumerator is disposed.
internal shared class IteratorTryDispatchPlanner {
    private class Walker : BoundTreeWalker {
        private let yieldStates IReadOnlyDictionary[BoundYieldStatement, int32]
        private let tryStack Stack[BoundTryStatement] = Stack[BoundTryStatement]()
        private let entryLabels Dictionary[BoundTryStatement, BoundLabel] = Dictionary[BoundTryStatement, BoundLabel]()
        private let outerDispatch Dictionary[int32, BoundLabel] = Dictionary[int32, BoundLabel]()
        private let internalDispatch Dictionary[BoundTryStatement, List[IteratorTryDispatchEntry]] = Dictionary[
            BoundTryStatement,
            List[IteratorTryDispatchEntry]
        ]()
        private let tryYieldStates Dictionary[BoundTryStatement, List[int32]] = Dictionary[
            BoundTryStatement,
            List[int32]
        ]()
        private let finallyTrysInnermostFirst List[BoundTryStatement] = List[BoundTryStatement]()
        private let resumeLabels Dictionary[int32, BoundLabel] = Dictionary[int32, BoundLabel]()
        private var entryOrdinal int32

        init(yieldStates IReadOnlyDictionary[BoundYieldStatement, int32]) {
            this.yieldStates = yieldStates
        }

        func Build() IteratorTryDispatchPlan {
            return IteratorTryDispatchPlan(
                outerDispatch.ToImmutableDictionary(),
                entryLabels.ToImmutableDictionary(),
                resumeLabels.ToImmutableDictionary(),
                internalDispatch.ToImmutableDictionary(
                    (kv KeyValuePair[BoundTryStatement, List[IteratorTryDispatchEntry]]) -> kv.Key,
                    (kv KeyValuePair[BoundTryStatement, List[IteratorTryDispatchEntry]]) -> kv.Value.ToImmutableArray()
                ),
                tryYieldStates.ToImmutableDictionary(
                    (kv KeyValuePair[BoundTryStatement, List[int32]]) -> kv.Key,
                    (kv KeyValuePair[BoundTryStatement, List[int32]]) -> kv.Value.ToImmutableArray()
                ),
                finallyTrysInnermostFirst.ToImmutableArray()
            )
        }

        protected override func VisitYieldStatement(node BoundYieldStatement) {
            if yieldStates.TryGetValue(node, out var state) {
                RecordYield(state)
            }
        }

        protected override func VisitTryStatement(node BoundTryStatement) {
            tryStack.Push(node)
            try {
                VisitStatement(node.TryBlock)
                // Catches and finallies should not themselves contain yields
                // for the purpose of state routing (binder rejects yield in
                // catch/finally). Still walk for completeness — yields found
                // here are simply ignored by RecordYield (state will route
                // them via the outer dispatch as if outside the try, which
                // is incorrect but cannot occur in well-formed programs).
                for c in node.CatchClauses {
                    VisitStatement(c.Body)
                }
                if node.FinallyBlock != nil {
                    VisitStatement(node.FinallyBlock)
                }
            } finally {
                tryStack.Pop()
            }
            // If this try had a finally and any yields, remember it so
            // Dispose can run the finally on premature disposal.
            if node.FinallyBlock != nil && tryYieldStates.TryGetValue(node, out var inside) && inside.Count > 0 {
                finallyTrysInnermostFirst.Add(node)
            }
        }

        private func RecordYield(state int32) {
            // Always create a resume label for this state.
            let resumeLabel = GetOrCreateResumeLabel(state)
            if tryStack.Count == 0 {
                return
            }
            // The outer dispatch routes to the OUTERMOST containing try's entry.
            let stackArr = tryStack.ToArray() // top-of-stack first → innermost first
            let outermost = stackArr[stackArr.Length - 1]
            outerDispatch[state] = GetOrCreateEntryLabel(outermost)
            // Each enclosing try (from outermost inward) gets an internal
            // dispatch entry. For the try at index idx, the target is either
            // the entry label of the next-deeper try (idx-1), or the resume
            // label itself when this try is the innermost containing one.
            for var idx = stackArr.Length - 1; idx >= 0; idx-- {
                let tryAtLevel = stackArr[idx]
                let target = if idx == 0 {
                    resumeLabel
                } else {
                    GetOrCreateEntryLabel(stackArr[idx - 1])
                }
                if !internalDispatch.TryGetValue(tryAtLevel, out var list) {
                    list = List[IteratorTryDispatchEntry]()
                    internalDispatch[tryAtLevel] = list
                }
                list.Add(IteratorTryDispatchEntry(state, target))
                if !tryYieldStates.TryGetValue(tryAtLevel, out var yieldList) {
                    yieldList = List[int32]()
                    tryYieldStates[tryAtLevel] = yieldList
                }
                yieldList.Add(state)
            }
        }

        private func GetOrCreateEntryLabel(tryStmt BoundTryStatement) BoundLabel {
            if !entryLabels.TryGetValue(tryStmt, out var lbl) {
                lbl = BoundLabel("$$iter_try_entry_" + entryOrdinal.ToString())
                entryOrdinal++
                entryLabels[tryStmt] = lbl
            }
            return lbl
        }

        private func GetOrCreateResumeLabel(state int32) BoundLabel {
            if !resumeLabels.TryGetValue(state, out var lbl) {
                lbl = BoundLabel("$$iterResume_" + state.ToString())
                resumeLabels[state] = lbl
            }
            return lbl
        }
    }

    /// Builds a dispatch plan for the given iterator body.
    /// @param body The user iterator body to scan.
    /// @param yieldStates The yield-statement to state map produced by (cref:IteratorRewriter).
    /// @returns A plan describing how to route the outer and per-try dispatches and what finallies Dispose
    /// must run.
    func Plan(
        body BoundStatement,
        yieldStates IReadOnlyDictionary[BoundYieldStatement, int32]
    ) IteratorTryDispatchPlan {
        let walker = IteratorTryDispatchPlanner.Walker(yieldStates)
        walker.Visit(body)
        return walker.Build()
    }
}

/// One entry in a user try's internal state dispatch (iterator).
internal struct IteratorTryDispatchEntry {
    /// Initializes a new instance of the (cref:IteratorTryDispatchEntry) struct.
    /// @param state The yield state number.
    /// @param target The dispatch target label.
    init(state int32, target BoundLabel) {
        State = state
        Target = target
    }

    /// Gets the yield state number.
    prop State int32 {
        get;
    }

    /// Gets the dispatch target label.
    prop Target BoundLabel {
        get;
    }
}

/// Result of (cref:IteratorTryDispatchPlanner.Plan): per-state outer
/// dispatch routing, per-try entry labels, per-try internal dispatch entries,
/// per-try yield state sets, and the innermost-first list of try-finallies
/// that contain yields (which Dispose must walk).
internal class IteratorTryDispatchPlan {
    private let outerDispatchTargets ImmutableDictionary[int32, BoundLabel]
    private let entryLabels ImmutableDictionary[BoundTryStatement, BoundLabel]
    private let resumeLabels ImmutableDictionary[int32, BoundLabel]
    private let internalDispatch ImmutableDictionary[BoundTryStatement, ImmutableArray[IteratorTryDispatchEntry]]
    private let tryYieldStates ImmutableDictionary[BoundTryStatement, ImmutableArray[int32]]
    private let finallyTrysInnermostFirst ImmutableArray[BoundTryStatement]

    /// Initializes a new instance of the (cref:IteratorTryDispatchPlan) class.
    /// @param outerDispatchTargets Map from yield state to outer-dispatch target label.
    /// @param entryLabels Map from user try statement to its synthesized entry label.
    /// @param resumeLabels Map from yield state to its canonical resume label.
    /// @param internalDispatch Map from user try statement to its internal dispatch entries.
    /// @param tryYieldStates Map from user try statement to the yield states it transitively contains.
    /// @param finallyTrysInnermostFirst Innermost-first list of user try-finally statements that contain
    /// yields.
    init(
        outerDispatchTargets ImmutableDictionary[int32, BoundLabel],
        entryLabels ImmutableDictionary[BoundTryStatement, BoundLabel],
        resumeLabels ImmutableDictionary[int32, BoundLabel],
        internalDispatch ImmutableDictionary[BoundTryStatement, ImmutableArray[IteratorTryDispatchEntry]],
        tryYieldStates ImmutableDictionary[BoundTryStatement, ImmutableArray[int32]],
        finallyTrysInnermostFirst ImmutableArray[BoundTryStatement]
    ) {
        this.outerDispatchTargets = outerDispatchTargets
        this.entryLabels = entryLabels
        this.resumeLabels = resumeLabels
        this.internalDispatch = internalDispatch
        this.tryYieldStates = tryYieldStates
        this.finallyTrysInnermostFirst = finallyTrysInnermostFirst
    }

    /// Gets the label the outer dispatch should branch to for the given
    /// yield state, or `null` if the yield is not inside
    /// any user try (in which case the caller should jump directly to the
    /// resume label).
    /// @param state The yield suspension state number.
    /// @returns The entry-label target, or null.
    func GetOuterDispatchTarget(state int32) BoundLabel? {
        return if outerDispatchTargets.TryGetValue(state, out var lbl) {
            lbl
        } else {
            default(BoundLabel?)
        }
    }

    /// Gets the entry label placed immediately before the given user try,
    /// or `null` if the try contains no yields and needs
    /// no entry routing.
    /// @param tryStmt The user try statement (pre-rewrite identity).
    /// @returns The synthesized entry label, or null.
    func GetEntryLabel(tryStmt BoundTryStatement) BoundLabel? {
        return if entryLabels.TryGetValue(tryStmt, out var lbl) {
            lbl
        } else {
            default(BoundLabel?)
        }
    }

    /// Gets the internal dispatch entries to prepend to the given user
    /// try's body. Each entry pairs a yield state with the label control
    /// should jump to (either a resume label or a nested try's entry).
    /// @param tryStmt The user try statement (pre-rewrite identity).
    /// @returns The dispatch entries; empty if this try has no yields inside.
    func GetInternalDispatchEntries(tryStmt BoundTryStatement) ImmutableArray[IteratorTryDispatchEntry] {
        return if internalDispatch.TryGetValue(tryStmt, out var entries) {
            entries
        } else {
            ImmutableArray[IteratorTryDispatchEntry].Empty
        }
    }

    /// Gets the yield states transitively inside the given user try.
    /// @param tryStmt The user try statement.
    /// @returns The yield states inside the try, or default if none.
    func GetYieldStatesInTry(tryStmt BoundTryStatement) ImmutableArray[int32] {
        return if tryYieldStates.TryGetValue(tryStmt, out var entries) {
            entries
        } else {
            default(ImmutableArray[int32])
        }
    }

    /// Gets the canonical resume label for the given yield state.
    /// @param state The yield state.
    /// @returns The resume label, or null if no yield with that state was recorded.
    func GetResumeLabel(state int32) BoundLabel? {
        return if resumeLabels.TryGetValue(state, out var lbl) {
            lbl
        } else {
            default(BoundLabel?)
        }
    }

    /// Gets the user try-finally statements that contain yields, in
    /// innermost-first order. Dispose must walk these in this order so
    /// nested finallies run before their enclosers, mirroring normal
    /// stack unwinding.
    prop FinallyTrysInnermostFirst ImmutableArray[BoundTryStatement] -> finallyTrysInnermostFirst
}
