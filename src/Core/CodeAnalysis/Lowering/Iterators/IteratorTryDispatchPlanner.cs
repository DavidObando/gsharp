// <copyright file="IteratorTryDispatchPlanner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1201 // Elements should appear in the correct order

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;

namespace GSharp.Core.CodeAnalysis.Lowering.Iterators;

/// <summary>
/// Pre-pass walker that builds a <see cref="IteratorTryDispatchPlan"/> from
/// the user iterator body by locating each <c>yield</c> within the lexical
/// nesting of user <c>try</c> statements.
/// </summary>
/// <remarks>
/// <para>The CLR forbids branching <c>br</c>/<c>brtrue</c>/<c>brfalse</c>
/// into a protected (try) region from outside. The outer <c>MoveNext</c>
/// state dispatch therefore cannot jump directly to a resume label that lies
/// inside a user try. Instead, a synthesized <i>entry label</i> is placed
/// immediately before each user try with yields, and the outer dispatch
/// routes there. Inside that try a second dispatch then either routes
/// further (to a nested try's entry label) or to a resume label for a
/// yield directly in that try.</para>
///
/// <para>The plan also captures, for each user <c>try</c> that has a
/// <c>finally</c> block and contains yields, the set of yield states inside
/// it (innermost-first). The Dispose synthesizer uses the per-try yield-state
/// sets to emit a finally walk that runs each pending <c>finally</c> when an
/// in-progress enumerator is disposed.</para>
/// </remarks>
internal static class IteratorTryDispatchPlanner
{
    /// <summary>
    /// Builds a dispatch plan for the given iterator body.
    /// </summary>
    /// <param name="body">The user iterator body to scan.</param>
    /// <param name="yieldStates">The yield-statement to state map produced by <see cref="IteratorRewriter"/>.</param>
    /// <returns>A plan describing how to route the outer and per-try dispatches and what finallies Dispose must run.</returns>
    public static IteratorTryDispatchPlan Plan(
        BoundStatement body,
        IReadOnlyDictionary<BoundYieldStatement, int> yieldStates)
    {
        var walker = new Walker(yieldStates);
        walker.RewriteStatement(body);
        return walker.Build();
    }

    private sealed class Walker : BoundTreeRewriter
    {
        private readonly IReadOnlyDictionary<BoundYieldStatement, int> yieldStates;
        private readonly Stack<BoundTryStatement> tryStack = new Stack<BoundTryStatement>();
        private readonly Dictionary<BoundTryStatement, BoundLabel> entryLabels = new Dictionary<BoundTryStatement, BoundLabel>();
        private readonly Dictionary<int, BoundLabel> outerDispatch = new Dictionary<int, BoundLabel>();
        private readonly Dictionary<BoundTryStatement, List<IteratorTryDispatchEntry>> internalDispatch = new Dictionary<BoundTryStatement, List<IteratorTryDispatchEntry>>();
        private readonly Dictionary<BoundTryStatement, List<int>> tryYieldStates = new Dictionary<BoundTryStatement, List<int>>();
        private readonly List<BoundTryStatement> finallyTrysInnermostFirst = new List<BoundTryStatement>();
        private readonly Dictionary<int, BoundLabel> resumeLabels = new Dictionary<int, BoundLabel>();
        private int entryOrdinal;

        public Walker(IReadOnlyDictionary<BoundYieldStatement, int> yieldStates)
        {
            this.yieldStates = yieldStates;
        }

        public IteratorTryDispatchPlan Build()
        {
            return new IteratorTryDispatchPlan(
                outerDispatch.ToImmutableDictionary(),
                entryLabels.ToImmutableDictionary(),
                resumeLabels.ToImmutableDictionary(),
                internalDispatch.ToImmutableDictionary(
                    kv => kv.Key,
                    kv => kv.Value.ToImmutableArray()),
                tryYieldStates.ToImmutableDictionary(
                    kv => kv.Key,
                    kv => kv.Value.ToImmutableArray()),
                finallyTrysInnermostFirst.ToImmutableArray());
        }

        protected override BoundStatement RewriteYieldStatement(BoundYieldStatement node)
        {
            if (yieldStates.TryGetValue(node, out var state))
            {
                RecordYield(state);
            }

            return node;
        }

        protected override BoundStatement RewriteTryStatement(BoundTryStatement node)
        {
            tryStack.Push(node);
            try
            {
                RewriteStatement(node.TryBlock);

                // Catches and finallies should not themselves contain yields
                // for the purpose of state routing (binder rejects yield in
                // catch/finally). Still walk for completeness — yields found
                // here are simply ignored by RecordYield (state will route
                // them via the outer dispatch as if outside the try, which
                // is incorrect but cannot occur in well-formed programs).
                foreach (var c in node.CatchClauses)
                {
                    RewriteStatement(c.Body);
                }

                if (node.FinallyBlock != null)
                {
                    RewriteStatement(node.FinallyBlock);
                }
            }
            finally
            {
                tryStack.Pop();
            }

            // If this try had a finally and any yields, remember it so
            // Dispose can run the finally on premature disposal.
            if (node.FinallyBlock != null
                && tryYieldStates.TryGetValue(node, out var inside)
                && inside.Count > 0)
            {
                finallyTrysInnermostFirst.Add(node);
            }

            return node;
        }

        private void RecordYield(int state)
        {
            // Always create a resume label for this state.
            var resumeLabel = GetOrCreateResumeLabel(state);

            if (tryStack.Count == 0)
            {
                return;
            }

            // The outer dispatch routes to the OUTERMOST containing try's entry.
            var stackArr = tryStack.ToArray(); // top-of-stack first → innermost first
            var outermost = stackArr[stackArr.Length - 1];
            outerDispatch[state] = GetOrCreateEntryLabel(outermost);

            // Each enclosing try (from outermost inward) gets an internal
            // dispatch entry. For the try at index idx, the target is either
            // the entry label of the next-deeper try (idx-1), or the resume
            // label itself when this try is the innermost containing one.
            for (int idx = stackArr.Length - 1; idx >= 0; idx--)
            {
                var tryAtLevel = stackArr[idx];
                BoundLabel target = idx == 0 ? resumeLabel : GetOrCreateEntryLabel(stackArr[idx - 1]);

                if (!internalDispatch.TryGetValue(tryAtLevel, out var list))
                {
                    list = new List<IteratorTryDispatchEntry>();
                    internalDispatch[tryAtLevel] = list;
                }

                list.Add(new IteratorTryDispatchEntry(state, target));

                if (!tryYieldStates.TryGetValue(tryAtLevel, out var yieldList))
                {
                    yieldList = new List<int>();
                    tryYieldStates[tryAtLevel] = yieldList;
                }

                yieldList.Add(state);
            }
        }

        private BoundLabel GetOrCreateEntryLabel(BoundTryStatement tryStmt)
        {
            if (!entryLabels.TryGetValue(tryStmt, out var lbl))
            {
                lbl = new BoundLabel("$iter_try_entry_" + entryOrdinal++);
                entryLabels[tryStmt] = lbl;
            }

            return lbl;
        }

        private BoundLabel GetOrCreateResumeLabel(int state)
        {
            if (!resumeLabels.TryGetValue(state, out var lbl))
            {
                lbl = new BoundLabel("$iterResume_" + state);
                resumeLabels[state] = lbl;
            }

            return lbl;
        }
    }
}

/// <summary>One entry in a user try's internal state dispatch (iterator).</summary>
internal readonly struct IteratorTryDispatchEntry
{
    /// <summary>Initializes a new instance of the <see cref="IteratorTryDispatchEntry"/> struct.</summary>
    /// <param name="state">The yield state number.</param>
    /// <param name="target">The dispatch target label.</param>
    public IteratorTryDispatchEntry(int state, BoundLabel target)
    {
        State = state;
        Target = target;
    }

    /// <summary>Gets the yield state number.</summary>
    public int State { get; }

    /// <summary>Gets the dispatch target label.</summary>
    public BoundLabel Target { get; }
}

/// <summary>
/// Result of <see cref="IteratorTryDispatchPlanner.Plan"/>: per-state outer
/// dispatch routing, per-try entry labels, per-try internal dispatch entries,
/// per-try yield state sets, and the innermost-first list of try-finallies
/// that contain yields (which Dispose must walk).
/// </summary>
internal sealed class IteratorTryDispatchPlan
{
    private readonly ImmutableDictionary<int, BoundLabel> outerDispatchTargets;
    private readonly ImmutableDictionary<BoundTryStatement, BoundLabel> entryLabels;
    private readonly ImmutableDictionary<int, BoundLabel> resumeLabels;
    private readonly ImmutableDictionary<BoundTryStatement, ImmutableArray<IteratorTryDispatchEntry>> internalDispatch;
    private readonly ImmutableDictionary<BoundTryStatement, ImmutableArray<int>> tryYieldStates;
    private readonly ImmutableArray<BoundTryStatement> finallyTrysInnermostFirst;

    /// <summary>Initializes a new instance of the <see cref="IteratorTryDispatchPlan"/> class.</summary>
    /// <param name="outerDispatchTargets">Map from yield state to outer-dispatch target label.</param>
    /// <param name="entryLabels">Map from user try statement to its synthesized entry label.</param>
    /// <param name="resumeLabels">Map from yield state to its canonical resume label.</param>
    /// <param name="internalDispatch">Map from user try statement to its internal dispatch entries.</param>
    /// <param name="tryYieldStates">Map from user try statement to the yield states it transitively contains.</param>
    /// <param name="finallyTrysInnermostFirst">Innermost-first list of user try-finally statements that contain yields.</param>
    public IteratorTryDispatchPlan(
        ImmutableDictionary<int, BoundLabel> outerDispatchTargets,
        ImmutableDictionary<BoundTryStatement, BoundLabel> entryLabels,
        ImmutableDictionary<int, BoundLabel> resumeLabels,
        ImmutableDictionary<BoundTryStatement, ImmutableArray<IteratorTryDispatchEntry>> internalDispatch,
        ImmutableDictionary<BoundTryStatement, ImmutableArray<int>> tryYieldStates,
        ImmutableArray<BoundTryStatement> finallyTrysInnermostFirst)
    {
        this.outerDispatchTargets = outerDispatchTargets;
        this.entryLabels = entryLabels;
        this.resumeLabels = resumeLabels;
        this.internalDispatch = internalDispatch;
        this.tryYieldStates = tryYieldStates;
        this.finallyTrysInnermostFirst = finallyTrysInnermostFirst;
    }

    /// <summary>
    /// Gets the label the outer dispatch should branch to for the given
    /// yield state, or <see langword="null"/> if the yield is not inside
    /// any user try (in which case the caller should jump directly to the
    /// resume label).
    /// </summary>
    /// <param name="state">The yield suspension state number.</param>
    /// <returns>The entry-label target, or null.</returns>
    public BoundLabel GetOuterDispatchTarget(int state)
    {
        return outerDispatchTargets.TryGetValue(state, out var lbl) ? lbl : null;
    }

    /// <summary>
    /// Gets the entry label placed immediately before the given user try,
    /// or <see langword="null"/> if the try contains no yields and needs
    /// no entry routing.
    /// </summary>
    /// <param name="tryStmt">The user try statement (pre-rewrite identity).</param>
    /// <returns>The synthesized entry label, or null.</returns>
    public BoundLabel GetEntryLabel(BoundTryStatement tryStmt)
    {
        return entryLabels.TryGetValue(tryStmt, out var lbl) ? lbl : null;
    }

    /// <summary>
    /// Gets the internal dispatch entries to prepend to the given user
    /// try's body. Each entry pairs a yield state with the label control
    /// should jump to (either a resume label or a nested try's entry).
    /// </summary>
    /// <param name="tryStmt">The user try statement (pre-rewrite identity).</param>
    /// <returns>The dispatch entries; empty if this try has no yields inside.</returns>
    public ImmutableArray<IteratorTryDispatchEntry> GetInternalDispatchEntries(BoundTryStatement tryStmt)
    {
        return internalDispatch.TryGetValue(tryStmt, out var entries) ? entries : default;
    }

    /// <summary>Gets the yield states transitively inside the given user try.</summary>
    /// <param name="tryStmt">The user try statement.</param>
    /// <returns>The yield states inside the try, or default if none.</returns>
    public ImmutableArray<int> GetYieldStatesInTry(BoundTryStatement tryStmt)
    {
        return tryYieldStates.TryGetValue(tryStmt, out var entries) ? entries : default;
    }

    /// <summary>Gets the canonical resume label for the given yield state.</summary>
    /// <param name="state">The yield state.</param>
    /// <returns>The resume label, or null if no yield with that state was recorded.</returns>
    public BoundLabel GetResumeLabel(int state)
    {
        return resumeLabels.TryGetValue(state, out var lbl) ? lbl : null;
    }

    /// <summary>
    /// Gets the user try-finally statements that contain yields, in
    /// innermost-first order. Dispose must walk these in this order so
    /// nested finallies run before their enclosers, mirroring normal
    /// stack unwinding.
    /// </summary>
    public ImmutableArray<BoundTryStatement> FinallyTrysInnermostFirst => finallyTrysInnermostFirst;
}
