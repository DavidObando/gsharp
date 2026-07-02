// <copyright file="RefKindDefiniteAssignmentAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0060 items #4 and #5: definite-assignment analysis specialized
/// for ref-kind parameters.
/// <list type="bullet">
///   <item>GS0238 — every <c>out</c> parameter must be definitely assigned on
///     every path that reaches a <c>return</c> (or falls off the function
///     end for <c>void</c> bodies).</item>
///   <item>GS0239 — a variable passed via <c>ref</c> (NOT <c>out</c>) at a
///     call site must be definitely assigned at that point.</item>
/// </list>
/// The analyzer builds a <see cref="ControlFlowGraph"/> for the function body
/// (and, recursively, for the body of every try/catch/finally, <c>select</c>
/// case, <c>scope</c>, and <c>fixed</c> block it contains — issue #1642: the
/// outer CFG treats those as single opaque statements, see
/// <see cref="ControlFlowGraph"/>'s <c>BasicBlockBuilder</c>) and runs a
/// forward "must be assigned" data-flow with intersect-meet over
/// predecessors. Reads are checked before writes apply within a basic block,
/// so a single statement that both writes and reads the same variable is
/// classified using the set at the start of that statement.
/// </summary>
internal static class RefKindDefiniteAssignmentAnalyzer
{
    public static void Analyze(BoundBlockStatement body, FunctionSymbol function, DiagnosticBag diagnostics)
    {
        if (body == null || function == null)
        {
            return;
        }

        // Seed: every non-out parameter (including ref/in) is assigned on entry.
        var initialAssigned = new HashSet<VariableSymbol>();
        foreach (var p in function.Parameters)
        {
            if (p.RefKind != RefKind.Out)
            {
                initialAssigned.Add(p);
            }
        }

        var outParams = function.Parameters.Where(p => p.RefKind == RefKind.Out).ToImmutableArray();

        // Best-effort `p = &v` / `var p = &v` alias tracking so `*p = expr`
        // (BoundIndirectAssignmentExpression) can count as an assignment to
        // `v`. Function-scoped and not part of the dataflow lattice — see
        // TrackPointerAlias/TryResolvePointerTarget for the (deliberately
        // narrow) semantics.
        var pointerAliases = new Dictionary<VariableSymbol, VariableSymbol>();

        try
        {
            AnalyzeRegion(body, initialAssigned, outParams, function, diagnostics, pointerAliases, isFunctionBody: true);
        }
        catch
        {
            // ponytail: fail-safe, not fail-open (issue #1642 secondary defect).
            // ControlFlowGraph.Create is already called unguarded against this
            // same lowered body a few lines above in Binder.cs
            // (ControlFlowGraph.AllPathsReturn) for every non-void function, so
            // this branch is realistically only reachable for void functions or
            // a genuine bug in this analyzer's own recursion. Either way,
            // silently returning (the previous behavior) would let a possibly-
            // unassigned `out` parameter compile with no diagnostic at all.
            // Report it instead of swallowing the failure; GS0239 (ref-read)
            // checks are best-effort and are simply skipped on this rare path.
            foreach (var op in outParams)
            {
                diagnostics.ReportOutParameterNotAssigned(function.Declaration?.Location ?? default(TextLocation), op.Name);
            }
        }
    }

    /// <summary>
    /// Runs the forward "must be assigned" fixpoint over the CFG of
    /// <paramref name="regionBody"/> (wrapping it in a synthetic block first
    /// if it isn't already one), seeded with <paramref name="initialAssigned"/>.
    /// When <paramref name="isFunctionBody"/> is true, every path reaching the
    /// region's end is an actual function exit and is checked against
    /// <paramref name="outParams"/> (mirrors the original top-level check).
    /// Otherwise, only paths ending in an internal <c>return</c>/<c>throw</c>
    /// are exits (checked here, since they leave the function from a point
    /// the outer CFG never sees — issue #1642); paths that fall off the end
    /// of the region normally are merged (intersected) and returned so the
    /// caller can keep propagating assignment state past the compound
    /// statement. Returns null when the region never completes normally.
    /// </summary>
    private static HashSet<VariableSymbol> AnalyzeRegion(
        BoundStatement regionBody,
        HashSet<VariableSymbol> initialAssigned,
        ImmutableArray<ParameterSymbol> outParams,
        FunctionSymbol function,
        DiagnosticBag diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
        bool isFunctionBody = false)
    {
        var graph = ControlFlowGraph.Create(AsBlock(regionBody));

        var entryAssigned = new Dictionary<ControlFlowGraph.BasicBlock, HashSet<VariableSymbol>>();
        var exitAssigned = new Dictionary<ControlFlowGraph.BasicBlock, HashSet<VariableSymbol>>();
        foreach (var b in graph.Blocks)
        {
            entryAssigned[b] = b.IsStart ? new HashSet<VariableSymbol>(initialAssigned) : null;
            exitAssigned[b] = null;
        }

        var changed = true;
        var safety = 0;
        while (changed && safety++ < 10000)
        {
            changed = false;
            foreach (var block in graph.Blocks)
            {
                if (block.IsEnd)
                {
                    continue;
                }

                HashSet<VariableSymbol> entry;
                if (block.IsStart)
                {
                    entry = new HashSet<VariableSymbol>(initialAssigned);
                }
                else
                {
                    entry = null;
                    foreach (var incoming in block.Incoming)
                    {
                        var predExit = exitAssigned[incoming.From];
                        if (predExit == null)
                        {
                            continue;
                        }

                        entry = entry == null ? new HashSet<VariableSymbol>(predExit) : Intersect(entry, predExit);
                    }

                    entry ??= new HashSet<VariableSymbol>(initialAssigned);
                }

                var prevEntry = entryAssigned[block];
                if (prevEntry == null || !SetsEqual(prevEntry, entry))
                {
                    entryAssigned[block] = entry;
                    changed = true;
                }

                var exit = SimulateBlock(block, new HashSet<VariableSymbol>(entryAssigned[block]), outParams, function, null, pointerAliases);
                var prevExit = exitAssigned[block];
                if (prevExit == null || !SetsEqual(prevExit, exit))
                {
                    exitAssigned[block] = exit;
                    changed = true;
                }
            }
        }

        // Final reporting pass — only performed once the caller actually wants
        // diagnostics (nested regions get re-analyzed without diagnostics
        // while probing a parent's dataflow; see e.g. ProcessTryStatement).
        if (diagnostics != null)
        {
            foreach (var block in graph.Blocks)
            {
                if (block.IsStart || block.IsEnd)
                {
                    continue;
                }

                var entry = entryAssigned[block] ?? new HashSet<VariableSymbol>(initialAssigned);
                SimulateBlock(block, new HashSet<VariableSymbol>(entry), outParams, function, diagnostics, pointerAliases);
            }
        }

        if (isFunctionBody)
        {
            if (diagnostics != null && !outParams.IsDefaultOrEmpty)
            {
                foreach (var endBranch in graph.End.Incoming)
                {
                    var exit = exitAssigned[endBranch.From] ?? new HashSet<VariableSymbol>(initialAssigned);
                    foreach (var op in outParams)
                    {
                        if (!exit.Contains(op))
                        {
                            diagnostics.ReportOutParameterNotAssigned(GetReportLocation(endBranch.From, function), op.Name);
                        }
                    }
                }
            }

            return null;
        }

        // Not the function body: classify each predecessor of this region's
        // end as either an internal exit (return/throw — leaves the function
        // right here, from a point the outer CFG can't see) or a normal
        // fall-through (continues past the compound statement).
        HashSet<VariableSymbol> normalExit = null;
        var anyNormal = false;
        foreach (var endBranch in graph.End.Incoming)
        {
            var fromBlock = endBranch.From;
            var exit = exitAssigned[fromBlock] ?? new HashSet<VariableSymbol>(initialAssigned);
            var lastStatement = fromBlock.Statements.LastOrDefault();
            var isInternalExit = lastStatement != null
                && (lastStatement.Kind == BoundNodeKind.ReturnStatement || lastStatement.Kind == BoundNodeKind.ThrowStatement);

            if (isInternalExit)
            {
                if (diagnostics != null && !outParams.IsDefaultOrEmpty)
                {
                    foreach (var op in outParams)
                    {
                        if (!exit.Contains(op))
                        {
                            diagnostics.ReportOutParameterNotAssigned(GetReportLocation(fromBlock, function), op.Name);
                        }
                    }
                }

                continue;
            }

            anyNormal = true;
            normalExit = normalExit == null ? new HashSet<VariableSymbol>(exit) : Intersect(normalExit, exit);
        }

        return anyNormal ? normalExit : null;
    }

    private static BoundBlockStatement AsBlock(BoundStatement statement)
    {
        if (statement is BoundBlockStatement block)
        {
            return block;
        }

        var statements = statement == null ? ImmutableArray<BoundStatement>.Empty : ImmutableArray.Create(statement);
        return new BoundBlockStatement(statement?.Syntax, statements);
    }

    private static TextLocation GetReportLocation(ControlFlowGraph.BasicBlock block, FunctionSymbol function)
    {
        for (var i = block.Statements.Count - 1; i >= 0; i--)
        {
            var stmt = block.Statements[i];
            if (stmt?.Syntax is { } syn)
            {
                return syn.Location;
            }
        }

        return function.Declaration?.Location ?? default(TextLocation);
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

    private static HashSet<VariableSymbol> Intersect(HashSet<VariableSymbol> a, HashSet<VariableSymbol> b)
    {
        var result = new HashSet<VariableSymbol>(a);
        result.IntersectWith(b);
        return result;
    }

    /// <summary>
    /// Walks a basic block linearly, updating <paramref name="assigned"/>
    /// in place. When <paramref name="diagnostics"/> is non-null, reports
    /// GS0239/GS0238 at every detected violation (including ones nested
    /// inside try/select/scope/fixed bodies). Returns the exit set.
    /// </summary>
    private static HashSet<VariableSymbol> SimulateBlock(
        ControlFlowGraph.BasicBlock block,
        HashSet<VariableSymbol> assigned,
        ImmutableArray<ParameterSymbol> outParams,
        FunctionSymbol function,
        DiagnosticBag diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases)
    {
        foreach (var statement in block.Statements)
        {
            ProcessStatement(statement, assigned, outParams, function, diagnostics, pointerAliases);
        }

        return assigned;
    }

    private static void ProcessStatement(
        BoundStatement statement,
        HashSet<VariableSymbol> assigned,
        ImmutableArray<ParameterSymbol> outParams,
        FunctionSymbol function,
        DiagnosticBag diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases)
    {
        switch (statement)
        {
            case BoundExpressionStatement es:
                ProcessExpression(es.Expression, assigned, diagnostics, pointerAliases);
                break;
            case BoundVariableDeclaration vd:
                if (vd.Initializer != null)
                {
                    ProcessExpression(vd.Initializer, assigned, diagnostics, pointerAliases);

                    // Synthesised default expressions (BoundDefaultExpression)
                    // emitted for `var x T` without an explicit initializer
                    // should NOT count as definite assignment — Roslyn DA
                    // treats `int x;` as unassigned for the same reason.
                    if (vd.Initializer is not BoundDefaultExpression)
                    {
                        assigned.Add(vd.Variable);
                    }

                    TrackPointerAlias(vd.Variable, vd.Initializer, pointerAliases);
                }

                break;
            case BoundReturnStatement rs:
                if (rs.Expression != null)
                {
                    ProcessExpression(rs.Expression, assigned, diagnostics, pointerAliases);
                }

                break;
            case BoundThrowStatement th:
                ProcessExpression(th.Expression, assigned, diagnostics, pointerAliases);
                break;
            case BoundConditionalGotoStatement cgs:
                ProcessExpression(cgs.Condition, assigned, diagnostics, pointerAliases);
                break;
            case BoundLabelStatement:
            case BoundGotoStatement:
                break;

            // Issue #1642: the following compound statements are opaque to
            // the outer ControlFlowGraph (treated as single fall-through
            // statements — see ControlFlowGraph.BasicBlockBuilder), so their
            // nested bodies must be recursively analyzed here or assignments
            // inside them are invisible to this analyzer.
            case BoundTryStatement tryStmt:
                ProcessTryStatement(tryStmt, assigned, outParams, function, diagnostics, pointerAliases);
                break;
            case BoundSelectStatement selectStmt:
                ProcessSelectStatement(selectStmt, assigned, outParams, function, diagnostics, pointerAliases);
                break;
            case BoundScopeStatement scopeStmt:
            {
                var exit = AnalyzeRegion(scopeStmt.Body, new HashSet<VariableSymbol>(assigned), outParams, function, diagnostics, pointerAliases);
                if (exit != null)
                {
                    assigned.Clear();
                    assigned.UnionWith(exit);
                }

                break;
            }

            case BoundFixedStatement fixedStmt:
                ProcessFixedStatement(fixedStmt, assigned, outParams, function, diagnostics, pointerAliases);
                break;
            case BoundPatternSwitchStatement switchStmt:
                ProcessPatternSwitchStatement(switchStmt, assigned, outParams, function, diagnostics, pointerAliases);
                break;
            default:
                // Other opaque statement kinds (go/channel-send/await-for-range/
                // yield) fall through to the next statement at the CFG level
                // too, but their bodies either don't run unconditionally
                // (a loop body may run zero times) or don't affect the
                // enclosing function's locals, so no-op here is correct.
                break;
        }
    }

    /// <summary>
    /// try/catch/finally semantics (mirrors C# definite assignment):
    /// <list type="bullet">
    ///   <item>Each <c>catch</c> clause is analyzed as if entered at the very
    ///     top of the try statement — an exception can occur before any
    ///     try-body statement runs — so catch bodies never see try-body
    ///     assignments.</item>
    ///   <item>An assignment made only in the try body (with no matching
    ///     unconditional assignment in every catch) is NOT guaranteed after
    ///     the statement, because an exception could have skipped it.</item>
    ///   <item>An assignment in <c>finally</c> IS guaranteed, because
    ///     <c>finally</c> always runs before control can continue past the
    ///     try statement.</item>
    /// </list>
    /// </summary>
    private static void ProcessTryStatement(
        BoundTryStatement tryStmt,
        HashSet<VariableSymbol> assigned,
        ImmutableArray<ParameterSymbol> outParams,
        FunctionSymbol function,
        DiagnosticBag diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases)
    {
        var preTry = new HashSet<VariableSymbol>(assigned);

        var tryExit = AnalyzeRegion(tryStmt.TryBlock, preTry, outParams, function, diagnostics, pointerAliases);
        var meet = tryExit;
        var anyReachable = tryExit != null;

        foreach (var clause in tryStmt.CatchClauses)
        {
            var catchEntry = new HashSet<VariableSymbol>(preTry);
            if (clause.Variable != null)
            {
                catchEntry.Add(clause.Variable);
            }

            var catchExit = AnalyzeRegion(clause.Body, catchEntry, outParams, function, diagnostics, pointerAliases);
            if (catchExit == null)
            {
                continue;
            }

            anyReachable = true;
            meet = meet == null ? catchExit : Intersect(meet, catchExit);
        }

        // If neither the try body nor any catch can complete normally (every
        // path always returns/throws), the code after this try statement is
        // unreachable. Leave `assigned` untouched — ponytail: dead code, any
        // choice here is equally "correct" since it can never execute.
        if (anyReachable)
        {
            assigned.Clear();
            assigned.UnionWith(meet);
        }

        if (tryStmt.FinallyBlock != null)
        {
            var finallyExit = AnalyzeRegion(tryStmt.FinallyBlock, new HashSet<VariableSymbol>(assigned), outParams, function, diagnostics, pointerAliases);
            if (finallyExit != null)
            {
                assigned.Clear();
                assigned.UnionWith(finallyExit);
            }
        }
    }

    /// <summary>
    /// <c>select</c> always blocks until exactly one arm becomes ready and
    /// runs its body (there is no "no arm matched" fallthrough, unlike a
    /// pattern switch), so whatever is assigned on every arm that completes
    /// normally is guaranteed to be assigned afterward.
    /// </summary>
    private static void ProcessSelectStatement(
        BoundSelectStatement selectStmt,
        HashSet<VariableSymbol> assigned,
        ImmutableArray<ParameterSymbol> outParams,
        FunctionSymbol function,
        DiagnosticBag diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases)
    {
        HashSet<VariableSymbol> meet = null;
        var any = false;

        foreach (var c in selectStmt.Cases)
        {
            if (c.Channel != null)
            {
                ProcessExpression(c.Channel, assigned, diagnostics, pointerAliases);
            }

            if (c.Value != null)
            {
                ProcessExpression(c.Value, assigned, diagnostics, pointerAliases);
            }

            var caseEntry = new HashSet<VariableSymbol>(assigned);
            if (c.Variable != null)
            {
                caseEntry.Add(c.Variable);
            }

            var caseExit = AnalyzeRegion(c.Body, caseEntry, outParams, function, diagnostics, pointerAliases);
            if (caseExit == null)
            {
                continue;
            }

            any = true;
            meet = meet == null ? caseExit : Intersect(meet, caseExit);
        }

        if (any)
        {
            assigned.Clear();
            assigned.UnionWith(meet);
        }
    }

    /// <summary>The <c>fixed</c> body always runs (no branching), so its
    /// assignments flow through unconditionally once its synthetic pinned
    /// and pointer locals are seeded as assigned.</summary>
    private static void ProcessFixedStatement(
        BoundFixedStatement fixedStmt,
        HashSet<VariableSymbol> assigned,
        ImmutableArray<ParameterSymbol> outParams,
        FunctionSymbol function,
        DiagnosticBag diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases)
    {
        ProcessExpression(fixedStmt.PinnedSource, assigned, diagnostics, pointerAliases);

        var entry = new HashSet<VariableSymbol>(assigned)
        {
            fixedStmt.PinnedVariable,
            fixedStmt.PointerVariable,
        };
        if (fixedStmt.SourceVariable != null)
        {
            entry.Add(fixedStmt.SourceVariable);
        }

        var exit = AnalyzeRegion(fixedStmt.Body, entry, outParams, function, diagnostics, pointerAliases);
        if (exit != null)
        {
            assigned.Clear();
            assigned.UnionWith(exit);
        }
    }

    /// <summary>
    /// A pattern switch, unlike <c>select</c>, can complete having matched no
    /// arm at all when there's no exhaustive <c>default</c> — that "nothing
    /// matched" path must also be in the meet (it contributes the untouched
    /// incoming <paramref name="assigned"/> set).
    /// </summary>
    private static void ProcessPatternSwitchStatement(
        BoundPatternSwitchStatement switchStmt,
        HashSet<VariableSymbol> assigned,
        ImmutableArray<ParameterSymbol> outParams,
        FunctionSymbol function,
        DiagnosticBag diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases)
    {
        ProcessExpression(switchStmt.Discriminant, assigned, diagnostics, pointerAliases);

        HashSet<VariableSymbol> meet = null;
        var any = false;
        var hasDefault = false;

        foreach (var arm in switchStmt.Arms)
        {
            if (arm.IsDefault)
            {
                hasDefault = true;
            }

            if (arm.Guard != null)
            {
                ProcessExpression(arm.Guard, assigned, diagnostics, pointerAliases);
            }

            var armExit = AnalyzeRegion(arm.Body, new HashSet<VariableSymbol>(assigned), outParams, function, diagnostics, pointerAliases);
            if (armExit == null)
            {
                continue;
            }

            any = true;
            meet = meet == null ? armExit : Intersect(meet, armExit);
        }

        if (!hasDefault)
        {
            meet = meet == null ? new HashSet<VariableSymbol>(assigned) : Intersect(meet, assigned);
            any = true;
        }

        if (any)
        {
            assigned.Clear();
            assigned.UnionWith(meet);
        }
    }

    /// <summary>
    /// Best-effort `pointerVar = &amp;localVar` alias tracking for
    /// <see cref="BoundIndirectAssignmentExpression"/> (issue #1642): records
    /// (or drops, on reassignment to something else) which local variable a
    /// pointer variable's address-of assignment targets. Intentionally
    /// narrow — no aliasing through arithmetic, field access, or indirection
    /// chains — and not merged across CFG joins (best-effort, shared per
    /// function rather than tracked per-path); this only needs to catch the
    /// common straight-line `var p = &amp;v; *p = expr` pattern.
    /// </summary>
    private static void TrackPointerAlias(VariableSymbol pointerVar, BoundExpression rhs, Dictionary<VariableSymbol, VariableSymbol> pointerAliases)
    {
        if (pointerVar == null)
        {
            return;
        }

        if (rhs is BoundAddressOfExpression addr && addr.Operand is BoundVariableExpression bve)
        {
            pointerAliases[pointerVar] = bve.Variable;
        }
        else
        {
            pointerAliases.Remove(pointerVar);
        }
    }

    private static bool TryResolvePointerTarget(BoundExpression pointerExpr, Dictionary<VariableSymbol, VariableSymbol> pointerAliases, out VariableSymbol target)
    {
        if (pointerExpr is BoundAddressOfExpression addr && addr.Operand is BoundVariableExpression bve)
        {
            target = bve.Variable;
            return true;
        }

        if (pointerExpr is BoundVariableExpression pve && pointerAliases.TryGetValue(pve.Variable, out target))
        {
            return true;
        }

        target = null;
        return false;
    }

    private static void ProcessExpression(BoundExpression expression, HashSet<VariableSymbol> assigned, DiagnosticBag diagnostics, Dictionary<VariableSymbol, VariableSymbol> pointerAliases)
    {
        if (expression == null)
        {
            return;
        }

        switch (expression)
        {
            case BoundCallExpression call:
                // Process arguments; for ref/out arguments, the read/write
                // semantics interact with definite assignment.
                for (var i = 0; i < call.Arguments.Length; i++)
                {
                    var arg = call.Arguments[i];
                    ParameterSymbol parameter = i < call.Function.Parameters.Length ? call.Function.Parameters[i] : null;

                    if (parameter != null && parameter.RefKind != RefKind.None
                        && arg is BoundAddressOfExpression addr
                        && addr.Operand is BoundVariableExpression bve)
                    {
                        if (parameter.RefKind == RefKind.Ref && !assigned.Contains(bve.Variable))
                        {
                            diagnostics?.ReportVariableNotAssignedBeforeRef(arg.Syntax?.Location ?? call.Syntax?.Location ?? default(TextLocation), bve.Variable.Name);
                        }

                        // Both ref and out arg-positions count as writes (the
                        // callee may overwrite). 'in' is a read only.
                        if (parameter.RefKind == RefKind.Ref || parameter.RefKind == RefKind.Out)
                        {
                            assigned.Add(bve.Variable);
                        }
                    }
                    else
                    {
                        ProcessExpression(arg, assigned, diagnostics, pointerAliases);
                    }
                }

                break;
            case BoundAssignmentExpression assign:
                ProcessExpression(assign.Expression, assigned, diagnostics, pointerAliases);
                assigned.Add(assign.Variable);
                TrackPointerAlias(assign.Variable, assign.Expression, pointerAliases);
                break;
            case BoundIndirectAssignmentExpression indirect:
                ProcessExpression(indirect.Value, assigned, diagnostics, pointerAliases);
                ProcessExpression(indirect.Pointer, assigned, diagnostics, pointerAliases);
                if (TryResolvePointerTarget(indirect.Pointer, pointerAliases, out var indirectTarget))
                {
                    assigned.Add(indirectTarget);
                }

                break;
            case BoundBinaryExpression bin:
                ProcessExpression(bin.Left, assigned, diagnostics, pointerAliases);
                ProcessExpression(bin.Right, assigned, diagnostics, pointerAliases);
                break;
            case BoundUnaryExpression un:
                ProcessExpression(un.Operand, assigned, diagnostics, pointerAliases);
                break;
            case BoundAddressOfExpression aof:
                ProcessExpression(aof.Operand, assigned, diagnostics, pointerAliases);
                break;
            case BoundDereferenceExpression deref:
                ProcessExpression(deref.Operand, assigned, diagnostics, pointerAliases);
                break;
            case BoundConversionExpression conv:
                ProcessExpression(conv.Expression, assigned, diagnostics, pointerAliases);
                break;
            default:
                break;
        }
    }
}
