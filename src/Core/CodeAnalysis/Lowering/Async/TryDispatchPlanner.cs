// <copyright file="TryDispatchPlanner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Pre-pass walker that builds a <see cref="TryDispatchPlan"/> from the
/// lowered async body by locating each await within the lexical nesting
/// of user try statements.
/// </summary>
/// <remarks>
/// <para>The CLR forbids branching <c>br</c>/<c>brtrue</c>/<c>brfalse</c>
/// into a protected (try) region from outside. The outer MoveNext state
/// dispatch therefore cannot jump directly to a resume label that lies
/// inside a user try. Instead, a synthesized <i>entry label</i> is placed
/// immediately before each user try with awaits, and the outer dispatch
/// routes there. Inside that try a second dispatch then either routes
/// further (to a nested try's entry label) or to a resume label for an
/// await directly in that try.</para>
///
/// <para>For nested user trys, dispatch chains through each level: outer
/// dispatch → outermost try's entry → outermost try's internal dispatch →
/// next-deeper try's entry → ... → resume label.</para>
/// </remarks>
internal static class TryDispatchPlanner
{
    /// <summary>
    /// Builds a dispatch plan for the given async body.
    /// </summary>
    /// <param name="body">The lowered async body to scan.</param>
    /// <param name="awaitResumeMap">The await-expression to resume-point map produced by <see cref="MoveNextBodyBuilder"/>.</param>
    /// <returns>A plan describing how to route the outer and per-try dispatches.</returns>
    public static TryDispatchPlan Plan(
        BoundStatement body,
        IReadOnlyDictionary<BoundAwaitExpression, AwaitResumePoint> awaitResumeMap)
    {
        var walker = new Walker(awaitResumeMap);
        walker.Walk(body);
        return walker.Build();
    }

    private sealed class Walker
    {
        private readonly IReadOnlyDictionary<BoundAwaitExpression, AwaitResumePoint> awaitResumeMap;
        private readonly Stack<BoundTryStatement> tryStack = new Stack<BoundTryStatement>();
        private readonly Dictionary<BoundTryStatement, BoundLabel> entryLabels = new Dictionary<BoundTryStatement, BoundLabel>();
        private readonly Dictionary<int, BoundLabel> outerDispatch = new Dictionary<int, BoundLabel>();
        private readonly Dictionary<BoundTryStatement, List<TryDispatchEntry>> internalDispatch = new Dictionary<BoundTryStatement, List<TryDispatchEntry>>();
        private int entryOrdinal;

        public Walker(IReadOnlyDictionary<BoundAwaitExpression, AwaitResumePoint> awaitResumeMap)
        {
            this.awaitResumeMap = awaitResumeMap;
        }

        public TryDispatchPlan Build()
        {
            return new TryDispatchPlan(
                outerDispatch.ToImmutableDictionary(),
                entryLabels.ToImmutableDictionary(),
                internalDispatch.ToImmutableDictionary(
                    kv => kv.Key,
                    kv => kv.Value.ToImmutableArray()));
        }

        public void Walk(BoundNode node)
        {
            switch (node)
            {
                case null:
                    return;
                case BoundAwaitExpression aw:
                    if (awaitResumeMap.TryGetValue(aw, out var rp))
                    {
                        RecordAwait(rp);
                    }

                    if (aw.Expression != null)
                    {
                        Walk(aw.Expression);
                    }

                    return;
                case BoundTryStatement t:
                    tryStack.Push(t);
                    Walk(t.TryBlock);
                    foreach (var c in t.CatchClauses)
                    {
                        // Catches and finallies should not contain awaits at
                        // this point (AsyncExceptionHandlerRewriter lifts them
                        // out). Walk for safety but do not record those awaits
                        // as needing entry routing for this try.
                        Walk(c.Body);
                    }

                    if (t.FinallyBlock != null)
                    {
                        Walk(t.FinallyBlock);
                    }

                    tryStack.Pop();
                    return;
                case BoundBlockStatement block:
                    foreach (var s in block.Statements)
                    {
                        Walk(s);
                    }

                    return;
                case BoundExpressionStatement es:
                    Walk(es.Expression);
                    return;
                case BoundVariableDeclaration vd:
                    Walk(vd.Initializer);
                    return;
                case BoundReturnStatement ret:
                    Walk(ret.Expression);
                    return;
                case BoundIfStatement ifs:
                    Walk(ifs.Condition);
                    Walk(ifs.ThenStatement);
                    Walk(ifs.ElseStatement);
                    return;
                case BoundConditionalGotoStatement cg:
                    Walk(cg.Condition);
                    return;
                case BoundThrowStatement th:
                    Walk(th.Expression);
                    return;
                case BoundScopeStatement sc:
                    Walk(sc.Body);
                    return;
                case BoundAssignmentExpression a:
                    Walk(a.Expression);
                    return;
                case BoundBinaryExpression b:
                    Walk(b.Left);
                    Walk(b.Right);
                    return;
                case BoundUnaryExpression u:
                    Walk(u.Operand);
                    return;
                case BoundConversionExpression cv:
                    Walk(cv.Expression);
                    return;
                case BoundCallExpression call:
                    foreach (var arg in call.Arguments)
                    {
                        Walk(arg);
                    }

                    return;
                case BoundImportedCallExpression ic:
                    foreach (var arg in ic.Arguments)
                    {
                        Walk(arg);
                    }

                    return;
                case BoundImportedInstanceCallExpression iic:
                    Walk(iic.Receiver);
                    foreach (var arg in iic.Arguments)
                    {
                        Walk(arg);
                    }

                    return;
                default:
                    return;
            }
        }

        private void RecordAwait(AwaitResumePoint rp)
        {
            if (tryStack.Count == 0)
            {
                return;
            }

            // The outer dispatch routes to the OUTERMOST containing try's entry.
            var stackArr = tryStack.ToArray(); // top-of-stack first → innermost first
            var outermost = stackArr[stackArr.Length - 1];
            outerDispatch[rp.State] = GetOrCreateEntryLabel(outermost);

            // Each enclosing try (from outermost inward) gets an internal
            // dispatch entry. For the try at index idx, the target is either
            // the entry label of the next-deeper try (idx-1), or the resume
            // label itself when this try is the innermost containing one.
            for (int idx = stackArr.Length - 1; idx >= 0; idx--)
            {
                var tryAtLevel = stackArr[idx];
                BoundLabel target = idx == 0 ? rp.ResumeLabel : GetOrCreateEntryLabel(stackArr[idx - 1]);

                if (!internalDispatch.TryGetValue(tryAtLevel, out var list))
                {
                    list = new List<TryDispatchEntry>();
                    internalDispatch[tryAtLevel] = list;
                }

                list.Add(new TryDispatchEntry(rp.State, target));
            }
        }

        private BoundLabel GetOrCreateEntryLabel(BoundTryStatement tryStmt)
        {
            if (!entryLabels.TryGetValue(tryStmt, out var lbl))
            {
                lbl = new BoundLabel("<>sm_user_try_entry_" + entryOrdinal++);
                entryLabels[tryStmt] = lbl;
            }

            return lbl;
        }
    }
}

/// <summary>
/// Result of <see cref="TryDispatchPlanner.Plan"/>: per-state outer
/// dispatch routing, per-try entry labels, and per-try internal dispatch
/// entries.
/// </summary>
internal sealed class TryDispatchPlan
{
    private readonly ImmutableDictionary<int, BoundLabel> outerDispatchTargets;
    private readonly ImmutableDictionary<BoundTryStatement, BoundLabel> entryLabels;
    private readonly ImmutableDictionary<BoundTryStatement, ImmutableArray<TryDispatchEntry>> internalDispatch;

    /// <summary>Initializes a new instance of the <see cref="TryDispatchPlan"/> class.</summary>
    /// <param name="outerDispatchTargets">Map from await state to outer-dispatch target label.</param>
    /// <param name="entryLabels">Map from user try statement to its synthesized entry label.</param>
    /// <param name="internalDispatch">Map from user try statement to its internal dispatch entries.</param>
    public TryDispatchPlan(
        ImmutableDictionary<int, BoundLabel> outerDispatchTargets,
        ImmutableDictionary<BoundTryStatement, BoundLabel> entryLabels,
        ImmutableDictionary<BoundTryStatement, ImmutableArray<TryDispatchEntry>> internalDispatch)
    {
        this.outerDispatchTargets = outerDispatchTargets;
        this.entryLabels = entryLabels;
        this.internalDispatch = internalDispatch;
    }

    /// <summary>
    /// Gets the label the outer dispatch should branch to for the given
    /// await state, or <see langword="null"/> if the await is not inside
    /// any user try (in which case the caller should jump directly to the
    /// resume label).
    /// </summary>
    /// <param name="state">The await suspension state number.</param>
    /// <returns>The entry-label target, or null.</returns>
    public BoundLabel GetOuterDispatchTarget(int state)
    {
        return outerDispatchTargets.TryGetValue(state, out var lbl) ? lbl : null;
    }

    /// <summary>
    /// Gets the entry label placed immediately before the given user try,
    /// or <see langword="null"/> if the try contains no awaits and needs
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
    /// try's body. Each entry pairs an await state with the label control
    /// should jump to (either a resume label or a nested try's entry).
    /// </summary>
    /// <param name="tryStmt">The user try statement (pre-rewrite identity).</param>
    /// <returns>The dispatch entries; empty if this try has no awaits inside.</returns>
    public ImmutableArray<TryDispatchEntry> GetInternalDispatchEntries(BoundTryStatement tryStmt)
    {
        return internalDispatch.TryGetValue(tryStmt, out var entries) ? entries : default;
    }
}
