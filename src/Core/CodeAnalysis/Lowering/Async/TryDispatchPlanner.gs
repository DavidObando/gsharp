// <copyright file="TryDispatchPlanner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import System.Collections.Generic
import System.Collections.Immutable

/// Pre-pass walker that builds a (cref:TryDispatchPlan) from the
/// lowered async body by locating each await within the lexical nesting
/// of user try statements.
/// @remarks The CLR forbids branching `br`/`brtrue`/`brfalse`
/// into a protected (try) region from outside. The outer MoveNext state
/// dispatch therefore cannot jump directly to a resume label that lies
/// inside a user try. Instead, a synthesized <i>entry label</i> is placed
/// immediately before each user try with awaits, and the outer dispatch
/// routes there. Inside that try a second dispatch then either routes
/// further (to a nested try's entry label) or to a resume label for an
/// await directly in that try.
///
/// For nested user trys, dispatch chains through each level: outer
/// dispatch → outermost try's entry → outermost try's internal dispatch →
/// next-deeper try's entry → ... → resume label.
///
/// Implementation note (6.3): the traversal subclasses
/// (cref:BoundTreeWalker) instead of using a bespoke switch.
/// The walker's recurse-by-default behavior means every node kind —
/// including kinds added in the future — is automatically traversed.
/// Only (cref:BoundAwaitExpression) and (cref:BoundTryStatement)
/// need custom handling; everything else inherits the walker's depth-first
/// walk. This eliminates the silent-default-drops-unknown-nodes bug class.
internal shared class TryDispatchPlanner {
    /// (cref:BoundTreeWalker) subclass that records await-to-try
    /// nesting during a depth-first walk. All node kinds not overridden
    /// here are traversed automatically by the walker's base implementation.
    private class WalkVisitor : BoundTreeWalker {
        private let awaitResumeMap IReadOnlyDictionary[BoundAwaitExpression, AwaitResumePoint]
        private let tryStack Stack[BoundTryStatement] = Stack[BoundTryStatement]()
        private let entryLabels Dictionary[BoundTryStatement, BoundLabel] = Dictionary[BoundTryStatement, BoundLabel]()
        private let outerDispatch Dictionary[int32, BoundLabel] = Dictionary[int32, BoundLabel]()
        private let internalDispatch Dictionary[BoundTryStatement, List[TryDispatchEntry]] = Dictionary[
            BoundTryStatement,
            List[TryDispatchEntry]
        ]()
        private var entryOrdinal int32

        init(awaitResumeMap IReadOnlyDictionary[BoundAwaitExpression, AwaitResumePoint]) {
            this.awaitResumeMap = awaitResumeMap
        }

        func Build() TryDispatchPlan {
            return TryDispatchPlan(
                outerDispatch.ToImmutableDictionary(),
                entryLabels.ToImmutableDictionary(),
                internalDispatch.ToImmutableDictionary(
                    (kv KeyValuePair[BoundTryStatement, List[TryDispatchEntry]]) -> kv.Key,
                    (kv KeyValuePair[BoundTryStatement, List[TryDispatchEntry]]) -> kv.Value.ToImmutableArray()
                )
            )
        }

        protected override func VisitAwaitExpression(node BoundAwaitExpression) {
            if awaitResumeMap.TryGetValue(node, out var rp) {
                RecordAwait(rp)
            }
            // Recurse into the awaited expression (e.g. a nested await).
            base.VisitAwaitExpression(node)
        }

        protected override func VisitTryStatement(node BoundTryStatement) {
            tryStack.Push(node)
            VisitStatement(node.TryBlock)
            for c in node.CatchClauses {
                // Catches and finallies should not contain awaits at
                // this point (AsyncExceptionHandlerRewriter lifts them
                // out). Walk for safety but do not record those awaits
                // as needing entry routing for this try.
                VisitStatement(c.Body)
            }
            if node.FinallyBlock != nil {
                VisitStatement(node.FinallyBlock)
            }
            tryStack.Pop()
        }

        private func RecordAwait(rp AwaitResumePoint) {
            if tryStack.Count == 0 {
                return
            }
            // The outer dispatch routes to the OUTERMOST containing try's entry.
            let stackArr = tryStack.ToArray() // top-of-stack first → innermost first
            let outermost = stackArr[stackArr.Length - 1]
            outerDispatch[rp.State] = GetOrCreateEntryLabel(outermost)
            // Each enclosing try (from outermost inward) gets an internal
            // dispatch entry. For the try at index idx, the target is either
            // the entry label of the next-deeper try (idx-1), or the resume
            // label itself when this try is the innermost containing one.
            for var idx = stackArr.Length - 1; idx >= 0; idx-- {
                let tryAtLevel = stackArr[idx]
                let target = if idx == 0 {
                    rp.ResumeLabel
                } else {
                    GetOrCreateEntryLabel(stackArr[idx - 1])
                }
                if !internalDispatch.TryGetValue(tryAtLevel, out var list) {
                    list = List[TryDispatchEntry]()
                    internalDispatch[tryAtLevel] = list
                }
                list.Add(TryDispatchEntry(rp.State, target))
            }
        }

        private func GetOrCreateEntryLabel(tryStmt BoundTryStatement) BoundLabel {
            if !entryLabels.TryGetValue(tryStmt, out var lbl) {
                lbl = BoundLabel("<>sm_user_try_entry_" + entryOrdinal.ToString())
                entryOrdinal++
                entryLabels[tryStmt] = lbl
            }
            return lbl
        }
    }

    /// Builds a dispatch plan for the given async body.
    /// @param body The lowered async body to scan.
    /// @param awaitResumeMap The await-expression to resume-point map produced by
    /// (cref:MoveNextBodyBuilder).
    /// @returns A plan describing how to route the outer and per-try dispatches.
    func Plan(
        body BoundStatement,
        awaitResumeMap IReadOnlyDictionary[BoundAwaitExpression, AwaitResumePoint]
    ) TryDispatchPlan {
        let visitor = WalkVisitor(awaitResumeMap)
        visitor.Visit(body)
        return visitor.Build()
    }
}

/// Result of (cref:TryDispatchPlanner.Plan): per-state outer
/// dispatch routing, per-try entry labels, and per-try internal dispatch
/// entries.
internal class TryDispatchPlan {
    private let outerDispatchTargets ImmutableDictionary[int32, BoundLabel]
    private let entryLabels ImmutableDictionary[BoundTryStatement, BoundLabel]
    private let internalDispatch ImmutableDictionary[BoundTryStatement, ImmutableArray[TryDispatchEntry]]

    /// Initializes a new instance of the (cref:TryDispatchPlan) class.
    /// @param outerDispatchTargets Map from await state to outer-dispatch target label.
    /// @param entryLabels Map from user try statement to its synthesized entry label.
    /// @param internalDispatch Map from user try statement to its internal dispatch entries.
    init(
        outerDispatchTargets ImmutableDictionary[int32, BoundLabel],
        entryLabels ImmutableDictionary[BoundTryStatement, BoundLabel],
        internalDispatch ImmutableDictionary[BoundTryStatement, ImmutableArray[TryDispatchEntry]]
    ) {
        this.outerDispatchTargets = outerDispatchTargets
        this.entryLabels = entryLabels
        this.internalDispatch = internalDispatch
    }

    /// Gets the label the outer dispatch should branch to for the given
    /// await state, or `null` if the await is not inside
    /// any user try (in which case the caller should jump directly to the
    /// resume label).
    /// @param state The await suspension state number.
    /// @returns The entry-label target, or null.
    func GetOuterDispatchTarget(state int32) BoundLabel? {
        return if outerDispatchTargets.TryGetValue(state, out var lbl) {
            lbl
        } else {
            default(BoundLabel?)
        }
    }

    /// Gets the entry label placed immediately before the given user try,
    /// or `null` if the try contains no awaits and needs
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
    /// try's body. Each entry pairs an await state with the label control
    /// should jump to (either a resume label or a nested try's entry).
    /// @param tryStmt The user try statement (pre-rewrite identity).
    /// @returns The dispatch entries; empty if this try has no awaits inside.
    func GetInternalDispatchEntries(tryStmt BoundTryStatement) ImmutableArray[TryDispatchEntry] {
        return if internalDispatch.TryGetValue(tryStmt, out var entries) {
            entries
        } else {
            ImmutableArray[TryDispatchEntry].Empty
        }
    }
}
