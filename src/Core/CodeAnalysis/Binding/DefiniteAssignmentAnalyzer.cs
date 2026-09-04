// <copyright file="DefiniteAssignmentAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Definite-assignment analysis. Two consumers share the same forward
/// "must be assigned" data-flow:
/// <list type="bullet">
///   <item>ADR-0060 items #4 and #5 (ref-kind parameters; formerly the
///     <c>RefKindDefiniteAssignmentAnalyzer</c>):
///     GS0238 — every <c>out</c> parameter must be definitely assigned on
///     every path that reaches a <c>return</c> (or falls off the function
///     end for <c>void</c> bodies); GS0239 — a variable passed via
///     <c>ref</c> (NOT <c>out</c>) at a call site must be definitely
///     assigned at that point.</item>
///   <item>ADR-0159 / issue #3316 (no-zero-value locals): GS0522 — a local
///     whose type has no usable zero value (today: a bare <c>chan T</c>
///     slot, see <see cref="MagicCollectionZeroValue.RequiresExplicitInitializer"/>)
///     may be declared without an initializer, but every USE reachable by
///     a path without a preceding assignment is an error — C#'s CS0165
///     model. Locals whose types have sound zero values (ints, maps and
///     the other magic collections post-ADR-0159, structs, …) keep their
///     documented zero-value initialization and are deliberately NOT
///     flow-checked.</item>
/// </list>
/// The analyzer builds a <see cref="ControlFlowGraph"/> for the function body
/// (and, recursively, for the body of every try/catch/finally, <c>select</c>
/// case, <c>scope</c>, <c>fixed</c>, and await-for-range block it contains —
/// issue #1642: the outer CFG treats those as single opaque statements, see
/// <see cref="ControlFlowGraph"/>'s <c>BasicBlockBuilder</c>) and runs a
/// forward "must be assigned" data-flow with intersect-meet over
/// predecessors. Reads are checked before writes apply within a basic block,
/// so a single statement that both writes and reads the same variable is
/// classified using the set at the start of that statement.
/// </summary>
internal static class DefiniteAssignmentAnalyzer
{
    public static void Analyze(BoundBlockStatement body, FunctionSymbol function, DiagnosticBag diagnostics)
        => AnalyzeWithCaptured(body, function, diagnostics, capturedAssigned: null, capturedTracked: null);

    private static void AnalyzeWithCaptured(
        BoundBlockStatement body,
        FunctionSymbol function,
        DiagnosticBag? diagnostics,
        IEnumerable<VariableSymbol>? capturedAssigned,
        IEnumerable<VariableSymbol>? capturedTracked)
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

        if (capturedAssigned != null)
        {
            initialAssigned.UnionWith(capturedAssigned);
        }

        var outParams = function.Parameters.Where(p => p.RefKind == RefKind.Out).ToImmutableArray();

        // Best-effort `p = &v` / `var p = &v` alias tracking so `*p = expr`
        // (BoundIndirectAssignmentExpression) can count as an assignment to
        // `v`. Function-scoped and not part of the dataflow lattice — see
        // TrackPointerAlias/TryResolvePointerTarget for the (deliberately
        // narrow) semantics.
        var pointerAliases = new Dictionary<VariableSymbol, VariableSymbol>();

        // Issue #3316: the no-zero-value locals subject to the GS0522
        // use-site check. Populated when a declared-without-initializer
        // channel local's BoundVariableDeclaration is simulated.
        // Function-scoped, like pointerAliases: the set only ever grows, and
        // reporting happens in the final diagnostics pass once every
        // declaration has been seen. A function literal's analysis is seeded
        // with the tracked locals it captures so a capture-before-assignment
        // use inside the literal reports against the state at the capture
        // point (the C# model).
        var tracked = new HashSet<VariableSymbol>();
        if (capturedTracked != null)
        {
            tracked.UnionWith(capturedTracked);
        }

        try
        {
            AnalyzeRegion(
                body,
                initialAssigned,
                outParams,
                function,
                diagnostics,
                pointerAliases,
                tracked,
                FindMethodExitLabel(body),
                isFunctionBody: true);
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
            // and GS0522 (no-zero-value local use) checks are best-effort and
            // are simply skipped on this rare path.
            foreach (var op in outParams)
            {
                diagnostics?.ReportOutParameterNotAssigned(function.Declaration?.Location ?? default(TextLocation), op.Name);
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
    /// Otherwise, internal returns are checked here because they leave the
    /// function from a point the outer CFG never sees (issue #1642), throw
    /// paths terminate without requiring assignment, and normal fall-through
    /// paths are merged and returned. Returns null when the region never
    /// completes normally.
    /// </summary>
    private static HashSet<VariableSymbol>? AnalyzeRegion(
        BoundStatement regionBody,
        HashSet<VariableSymbol> initialAssigned,
        ImmutableArray<ParameterSymbol> outParams,
        FunctionSymbol function,
        DiagnosticBag? diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
        HashSet<VariableSymbol> tracked,
        BoundLabel? methodExitLabel,
        bool isFunctionBody = false)
    {
        var graph = ControlFlowGraph.Create(AsBlock(regionBody));

        var entryAssigned = new Dictionary<ControlFlowGraph.BasicBlock, HashSet<VariableSymbol>?>();
        var exitAssigned = new Dictionary<ControlFlowGraph.BasicBlock, HashSet<VariableSymbol>?>();

        // ADR-0166 follow-on: a block that ends in a conditional goto has two
        // exits whose "definitely assigned" sets differ — `a && M(out x)`
        // assigns `x` on the true edge only (C# definite assignment "when
        // true" / "when false"). Recorded per block; EdgeExit selects the set
        // matching the branch's polarity.
        var conditionalExits = new Dictionary<ControlFlowGraph.BasicBlock, (HashSet<VariableSymbol> WhenTrue, HashSet<VariableSymbol> WhenFalse)>();
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

                HashSet<VariableSymbol>? entry;
                if (block.IsStart)
                {
                    entry = new HashSet<VariableSymbol>(initialAssigned);
                }
                else
                {
                    entry = null;
                    foreach (var incoming in block.Incoming)
                    {
                        var predExit = EdgeExit(incoming, exitAssigned, conditionalExits);
                        if (predExit == null)
                        {
                            continue;
                        }

                        entry = entry == null ? new HashSet<VariableSymbol>(predExit) : Intersect(entry, predExit);
                    }

                    // Wait until at least one reachable predecessor has been
                    // simulated. Seeding an unvisited loop cycle with the
                    // function-entry state can permanently intersect away
                    // assignments made before the loop.
                    if (entry == null)
                    {
                        continue;
                    }
                }

                var prevEntry = entryAssigned[block];
                if (prevEntry == null || !SetsEqual(prevEntry, entry))
                {
                    entryAssigned[block] = entry;
                    changed = true;
                }

                var currentEntry = entryAssigned[block];
                if (currentEntry is null)
                {
                    continue;
                }

                var exit = SimulateBlock(block, new HashSet<VariableSymbol>(currentEntry), outParams, function, null, pointerAliases, tracked, methodExitLabel);
                var prevExit = exitAssigned[block];
                if (prevExit == null || !SetsEqual(prevExit, exit))
                {
                    exitAssigned[block] = exit;
                    changed = true;
                }

                if (block.Statements.LastOrDefault() is BoundConditionalGotoStatement conditionalGoto)
                {
                    var beforeCondition = new HashSet<VariableSymbol>(currentEntry);
                    for (var i = 0; i < block.Statements.Count - 1; i++)
                    {
                        ProcessStatement(block.Statements[i], beforeCondition, outParams, function, null, pointerAliases, tracked, methodExitLabel);
                    }

                    var (whenTrue, whenFalse) = ClassifyConditionAssignments(
                        conditionalGoto.Condition,
                        beforeCondition,
                        pointerAliases,
                        tracked,
                        new ExpressionFlowContext(outParams, function, methodExitLabel));
                    if (!conditionalExits.TryGetValue(block, out var previous)
                        || !SetsEqual(previous.WhenTrue, whenTrue)
                        || !SetsEqual(previous.WhenFalse, whenFalse))
                    {
                        conditionalExits[block] = (whenTrue, whenFalse);
                        changed = true;
                    }
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
                SimulateBlock(block, new HashSet<VariableSymbol>(entry), outParams, function, diagnostics, pointerAliases, tracked, methodExitLabel);
            }
        }

        if (isFunctionBody)
        {
            if (diagnostics != null && !outParams.IsDefaultOrEmpty)
            {
                foreach (var endBranch in graph.End.Incoming)
                {
                    if (endBranch.From.Statements.LastOrDefault()?.Kind == BoundNodeKind.ThrowStatement)
                    {
                        continue;
                    }

                    var exit = EdgeExit(endBranch, exitAssigned, conditionalExits) ?? new HashSet<VariableSymbol>(initialAssigned);
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

        // Not the function body: discard throw paths, check function-return
        // paths, and merge normal fall-through paths.
        HashSet<VariableSymbol>? normalExit = null;
        var anyNormal = false;
        foreach (var endBranch in graph.End.Incoming)
        {
            var fromBlock = endBranch.From;
            var exit = EdgeExit(endBranch, exitAssigned, conditionalExits) ?? new HashSet<VariableSymbol>(initialAssigned);
            var lastStatement = fromBlock.Statements.LastOrDefault();
            if (lastStatement?.Kind == BoundNodeKind.ThrowStatement)
            {
                continue;
            }

            var exitsFunction = lastStatement?.Kind == BoundNodeKind.ReturnStatement
                || (lastStatement is BoundGotoStatement gotoStatement
                    && ReferenceEquals(gotoStatement.Label, methodExitLabel));
            if (exitsFunction)
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

    /// <summary>
    /// The predecessor's exit state along <paramref name="branch"/>: the
    /// polarity-specific set when the predecessor ends in a conditional goto
    /// (the CFG builder attaches the goto's own condition object to the true
    /// edge and a negation of it to the false edge), the plain exit otherwise.
    /// </summary>
    private static HashSet<VariableSymbol>? EdgeExit(
        ControlFlowGraph.BasicBlockBranch branch,
        Dictionary<ControlFlowGraph.BasicBlock, HashSet<VariableSymbol>?> exitAssigned,
        Dictionary<ControlFlowGraph.BasicBlock, (HashSet<VariableSymbol> WhenTrue, HashSet<VariableSymbol> WhenFalse)> conditionalExits)
    {
        if (branch.Condition != null
            && branch.From.Statements.LastOrDefault() is BoundConditionalGotoStatement conditionalGoto
            && conditionalExits.TryGetValue(branch.From, out var exits))
        {
            return ReferenceEquals(branch.Condition, conditionalGoto.Condition)
                ? exits.WhenTrue
                : exits.WhenFalse;
        }

        return exitAssigned[branch.From];
    }

    /// <summary>
    /// The definitely-assigned sets after <paramref name="condition"/> evaluates
    /// to true and to false, starting from <paramref name="assigned"/>. Mirrors
    /// C# §9.4.4: for <c>A &amp;&amp; B</c> the right operand runs in the
    /// when-true state of the left, and the whole is false when either was
    /// (intersection); dually for <c>||</c>; <c>!</c> swaps.
    /// </summary>
    private static (HashSet<VariableSymbol> WhenTrue, HashSet<VariableSymbol> WhenFalse) ClassifyConditionAssignments(
        BoundExpression condition,
        HashSet<VariableSymbol> assigned,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
        HashSet<VariableSymbol> tracked,
        ExpressionFlowContext flowContext)
    {
        switch (condition)
        {
            case BoundUnaryExpression unary when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation:
                {
                    var (whenTrue, whenFalse) = ClassifyConditionAssignments(unary.Operand, assigned, pointerAliases, tracked, flowContext);
                    return (whenFalse, whenTrue);
                }

            case BoundBinaryExpression binary when binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd:
                {
                    var (leftTrue, leftFalse) = ClassifyConditionAssignments(binary.Left, assigned, pointerAliases, tracked, flowContext);
                    var (rightTrue, rightFalse) = ClassifyConditionAssignments(binary.Right, leftTrue, pointerAliases, tracked, flowContext);
                    return (rightTrue, Intersect(leftFalse, rightFalse));
                }

            case BoundBinaryExpression binary when binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr:
                {
                    var (leftTrue, leftFalse) = ClassifyConditionAssignments(binary.Left, assigned, pointerAliases, tracked, flowContext);
                    var (rightTrue, rightFalse) = ClassifyConditionAssignments(binary.Right, leftFalse, pointerAliases, tracked, flowContext);
                    return (Intersect(leftTrue, rightTrue), rightFalse);
                }

            default:
                {
                    var after = new HashSet<VariableSymbol>(assigned);
                    ProcessExpression(condition, after, null, new Dictionary<VariableSymbol, VariableSymbol>(pointerAliases), tracked, flowContext);
                    return (after, after);
                }
        }
    }

    private static BoundLabel? FindMethodExitLabel(BoundBlockStatement body)
    {
        if (body.Statements.Length >= 2
            && body.Statements[^2] is BoundLabelStatement { Syntax: null } label
            && body.Statements[^1] is BoundReturnStatement { Syntax: null })
        {
            return label.Label;
        }

        return null;
    }

    private static BoundBlockStatement AsBlock(BoundStatement? statement)
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
    /// GS0239/GS0238/GS0522 at every detected violation (including ones
    /// nested inside try/select/scope/fixed bodies). Returns the exit set.
    /// </summary>
    private static HashSet<VariableSymbol> SimulateBlock(
        ControlFlowGraph.BasicBlock block,
        HashSet<VariableSymbol> assigned,
        ImmutableArray<ParameterSymbol> outParams,
        FunctionSymbol function,
        DiagnosticBag? diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
        HashSet<VariableSymbol> tracked,
        BoundLabel? methodExitLabel)
    {
        foreach (var statement in block.Statements)
        {
            ProcessStatement(statement, assigned, outParams, function, diagnostics, pointerAliases, tracked, methodExitLabel);
        }

        return assigned;
    }

    private static void ProcessStatement(
        BoundStatement statement,
        HashSet<VariableSymbol> assigned,
        ImmutableArray<ParameterSymbol> outParams,
        FunctionSymbol function,
        DiagnosticBag? diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
        HashSet<VariableSymbol> tracked,
        BoundLabel? methodExitLabel)
    {
        var flowContext = new ExpressionFlowContext(outParams, function, methodExitLabel);
        switch (statement)
        {
            case BoundExpressionStatement es:
                ProcessExpression(es.Expression, assigned, diagnostics, pointerAliases, tracked, flowContext);
                break;
            case BoundVariableDeclaration vd:
            {
                var definitelyAssigned = false;
                if (vd.Initializer != null)
                {
                    ProcessExpression(vd.Initializer, assigned, diagnostics, pointerAliases, tracked, flowContext);

                    // Synthesised default expressions (BoundDefaultExpression)
                    // emitted for `var x T` without an explicit initializer
                    // should NOT count as definite assignment — Roslyn DA
                    // treats `int x;` as unassigned for the same reason. An
                    // EXPLICIT `= default` initializer DOES count: the user
                    // opted into the CLR default (ADR-0159's honesty clause
                    // keeps `default`'s CLR meaning).
                    if (vd.Initializer is not BoundDefaultExpression
                        || vd.Syntax is VariableDeclarationSyntax { Initializer: not null })
                    {
                        assigned.Add(vd.Variable);
                        definitelyAssigned = true;
                    }

                    TrackPointerAlias(vd.Variable, vd.Initializer, pointerAliases);
                }

                // Issue #3316: a declared-without-initializer local whose type
                // has no usable zero value joins the GS0522 use-site check.
                // Only user-declared locals qualify — parameters are assigned
                // on entry, globals are static fields readable from any
                // function or REPL cell (they keep the GS0520 declaration-site
                // rule), and synthesized temps are the lowerer's business.
                if (!definitelyAssigned
                    && vd.Variable is LocalVariableSymbol
                    && MagicCollectionZeroValue.RequiresExplicitInitializer(vd.Variable.Type))
                {
                    tracked.Add(vd.Variable);
                }

                break;
            }

            case BoundReturnStatement rs:
                if (rs.Expression != null)
                {
                    ProcessExpression(rs.Expression, assigned, diagnostics, pointerAliases, tracked, flowContext);
                }

                break;
            case BoundThrowStatement th:
                ProcessExpression(th.Expression, assigned, diagnostics, pointerAliases, tracked, flowContext);
                break;
            case BoundRethrowStatement:
                // ADR-0176: no operand, so nothing is read here.
                break;
            case BoundConditionalGotoStatement cgs:
                ProcessExpression(cgs.Condition, assigned, diagnostics, pointerAliases, tracked, flowContext);
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
                ProcessTryStatement(tryStmt, assigned, outParams, function, diagnostics, pointerAliases, tracked, methodExitLabel);
                break;
            case BoundFixedStatement fixedStmt:
                ProcessFixedStatement(fixedStmt, assigned, outParams, function, diagnostics, pointerAliases, tracked, methodExitLabel);
                break;
            case BoundPatternSwitchStatement switchStmt:
                ProcessPatternSwitchStatement(switchStmt, assigned, outParams, function, diagnostics, pointerAliases, tracked, methodExitLabel);
                break;
            case BoundAwaitForRangeStatement awaitForRange:
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
                ProcessExpression(awaitForRange.Stream, assigned, diagnostics, pointerAliases, tracked, flowContext);
                AnalyzeRegion(awaitForRange.Body, new HashSet<VariableSymbol>(assigned), outParams, function, diagnostics, pointerAliases, tracked, methodExitLabel);
                break;
            default:
                // Other opaque statement kinds (go/channel-send/yield) fall
                // through to the next statement at the CFG level too, and
                // carry expressions but no conditionally-executed bodies. The
                // report-only walker visits their expression operands — value
                // reads of tracked no-zero-value locals (GS0522) — and any
                // nested function literals, which require their own analysis.
                new FunctionLiteralAndUseWalker(
                    assigned,
                    tracked,
                    diagnostics,
                    pointerAliases,
                    flowContext).VisitStatement(statement);
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
        DiagnosticBag? diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
        HashSet<VariableSymbol> tracked,
        BoundLabel? methodExitLabel)
    {
        var preTry = new HashSet<VariableSymbol>(assigned);

        var tryExit = AnalyzeRegion(tryStmt.TryBlock, preTry, outParams, function, diagnostics, pointerAliases, tracked, methodExitLabel);
        var meet = tryExit;
        var anyReachable = tryExit != null;

        foreach (var clause in tryStmt.CatchClauses)
        {
            var catchEntry = new HashSet<VariableSymbol>(preTry);
            if (clause.Variable != null)
            {
                catchEntry.Add(clause.Variable);
            }

            var catchExit = AnalyzeRegion(clause.Body, catchEntry, outParams, function, diagnostics, pointerAliases, tracked, methodExitLabel);

            // ADR-0174 D6: a scope's synthesized handler only records the body
            // exception for a finally that always rethrows it, so it never
            // completes normally and contributes no fall-through state.
            if (catchExit == null || clause.ExitsThroughFinally)
            {
                continue;
            }

            anyReachable = true;
            meet = meet == null ? catchExit : Intersect(meet, catchExit);
        }

        // If neither the try body nor any catch can complete normally, the
        // outer CFG's synthetic fall-through is unreachable. Unreachable is
        // the top state for a must analysis, so it cannot create a second,
        // false GS0238 at the function's synthetic final return.
        if (anyReachable && meet is not null)
        {
            assigned.Clear();
            assigned.UnionWith(meet);
        }
        else
        {
            assigned.UnionWith(outParams);
        }

        if (tryStmt.FinallyBlock != null)
        {
            var finallyExit = AnalyzeRegion(tryStmt.FinallyBlock, new HashSet<VariableSymbol>(assigned), outParams, function, diagnostics, pointerAliases, tracked, methodExitLabel);
            if (finallyExit != null)
            {
                assigned.Clear();
                assigned.UnionWith(finallyExit);
            }
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
        DiagnosticBag? diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
        HashSet<VariableSymbol> tracked,
        BoundLabel? methodExitLabel)
    {
        var flowContext = new ExpressionFlowContext(outParams, function, methodExitLabel);
        ProcessExpression(fixedStmt.PinnedSource, assigned, diagnostics, pointerAliases, tracked, flowContext);

        var entry = new HashSet<VariableSymbol>(assigned)
        {
            fixedStmt.PinnedVariable,
            fixedStmt.PointerVariable,
        };
        if (fixedStmt.SourceVariable != null)
        {
            entry.Add(fixedStmt.SourceVariable);
        }

        var exit = AnalyzeRegion(fixedStmt.Body, entry, outParams, function, diagnostics, pointerAliases, tracked, methodExitLabel);
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
        DiagnosticBag? diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
        HashSet<VariableSymbol> tracked,
        BoundLabel? methodExitLabel)
    {
        var flowContext = new ExpressionFlowContext(outParams, function, methodExitLabel);
        ProcessExpression(switchStmt.Discriminant, assigned, diagnostics, pointerAliases, tracked, flowContext);

        HashSet<VariableSymbol>? meet = null;
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
                ProcessExpression(arm.Guard, assigned, diagnostics, pointerAliases, tracked, flowContext);
            }

            var armExit = AnalyzeRegion(arm.Body, new HashSet<VariableSymbol>(assigned), outParams, function, diagnostics, pointerAliases, tracked, methodExitLabel);
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

        if (hasDefault && !any)
        {
            // Every exhaustive arm terminates inside its recursively analyzed
            // region. The outer CFG models pattern switches as opaque and still
            // carries a synthetic fall-through edge, so mark out parameters as
            // assigned on that unreachable continuation. Any real return missing
            // an assignment was already reported while analyzing its arm.
            assigned.UnionWith(outParams);
            return;
        }

        if (any && meet is not null)
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

        var address = rhs as BoundAddressOfExpression;
        var variable = address?.Operand as BoundVariableExpression;
        if (variable is not null)
        {
            pointerAliases[pointerVar] = variable.Variable;
        }
        else
        {
            pointerAliases.Remove(pointerVar);
        }
    }

    private static bool TryResolvePointerTarget(BoundExpression pointerExpr, Dictionary<VariableSymbol, VariableSymbol> pointerAliases, out VariableSymbol? target)
    {
        var address = pointerExpr as BoundAddressOfExpression;
        var variable = address?.Operand as BoundVariableExpression;
        if (variable is not null)
        {
            target = variable.Variable;
            return true;
        }

        var pointerVariable = pointerExpr as BoundVariableExpression;
        if (pointerVariable is not null
            && pointerAliases.TryGetValue(pointerVariable.Variable, out var aliasedTarget))
        {
            target = aliasedTarget;
            return true;
        }

        target = null;
        return false;
    }

    /// <summary>
    /// Issue #3316: reports GS0522 when a value read of a tracked
    /// no-zero-value local (a bare <c>chan T</c> local declared without an
    /// initializer) is reachable while the local may still be unassigned.
    /// Reporting happens only in the final diagnostics pass, once every
    /// declaration in the function has populated the tracked set.
    /// </summary>
    private static void CheckTrackedUse(
        BoundVariableExpression read,
        HashSet<VariableSymbol> assigned,
        HashSet<VariableSymbol> tracked,
        DiagnosticBag? diagnostics)
    {
        if (diagnostics == null
            || read.Variable == null
            || !tracked.Contains(read.Variable)
            || assigned.Contains(read.Variable))
        {
            return;
        }

        diagnostics.ReportChannelLocalUsedBeforeAssignment(
            read.Syntax?.Location ?? default(TextLocation),
            read.Variable.Name,
            read.Variable.Type.Name);
    }

    private static void ProcessExpression(
        BoundExpression? expression,
        HashSet<VariableSymbol> assigned,
        DiagnosticBag? diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
        HashSet<VariableSymbol> tracked,
        ExpressionFlowContext? flowContext = null)
    {
        if (expression == null)
        {
            return;
        }

        switch (expression)
        {
            case BoundBlockExpression block when flowContext is { } context:
            {
                var statements = block.Statements.Add(
                    new BoundExpressionStatement(block.Expression.Syntax, block.Expression));
                var exit = AnalyzeRegion(
                    new BoundBlockStatement(block.Syntax, statements),
                    new HashSet<VariableSymbol>(assigned),
                    context.OutParams,
                    context.Function,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    context.MethodExitLabel);
                assigned.Clear();
                if (exit != null)
                {
                    assigned.UnionWith(exit);
                }
                else
                {
                    // No normal completion: unreachable is top for this
                    // forward must analysis.
                    assigned.UnionWith(context.OutParams);
                    assigned.UnionWith(tracked);
                }

                break;
            }

            case BoundVariableExpression read:
                // Issue #3316: a direct value read of a tracked no-zero-value
                // local. (Reads nested inside expression kinds without an
                // explicit case here are found by FunctionLiteralAndUseWalker
                // via the default arm.)
                CheckTrackedUse(read, assigned, tracked, diagnostics);
                break;
            case BoundCallExpression call:
                ProcessCallArguments(call.Arguments, call.Function.Parameters, assigned, diagnostics, pointerAliases, tracked, call.Syntax, flowContext);
                break;
            case BoundImportedCallExpression call:
                ProcessCallArguments(call.Arguments, call.ArgumentRefKinds, assigned, diagnostics, pointerAliases, tracked, call.Syntax, flowContext);
                break;
            case BoundImportedInstanceCallExpression call:
                ProcessExpression(call.Receiver, assigned, diagnostics, pointerAliases, tracked, flowContext);
                ProcessCallArguments(call.Arguments, call.ArgumentRefKinds, assigned, diagnostics, pointerAliases, tracked, call.Syntax, flowContext);
                break;
            case BoundConstrainedStaticCallExpression call:
                if (call.InterfaceMethod != null)
                {
                    ProcessCallArguments(call.Arguments, call.InterfaceMethod.Parameters, assigned, diagnostics, pointerAliases, tracked, call.Syntax, flowContext);
                }
                else
                {
                    // Issue #3525: the imported-CLR-interface shape has no
                    // ParameterSymbol list, only reflection ArgumentRefKinds.
                    ProcessCallArguments(call.Arguments, call.ArgumentRefKinds, assigned, diagnostics, pointerAliases, tracked, call.Syntax, flowContext);
                }

                break;
            case BoundConstructorCallExpression call:
                var constructorParameters = call.SelectedConstructor != null
                    ? call.SelectedConstructor.Parameters
                    : call.StructType.PrimaryConstructorParameters;
                ProcessCallArguments(call.Arguments, constructorParameters, assigned, diagnostics, pointerAliases, tracked, call.Syntax, flowContext);
                break;
            case BoundConstructorChainingExpression call:
                ProcessCallArguments(call.Arguments, call.SelectedConstructor.Parameters, assigned, diagnostics, pointerAliases, tracked, call.Syntax, flowContext);
                break;
            case BoundUserInstanceCallExpression call:
                ProcessExpression(call.Receiver, assigned, diagnostics, pointerAliases, tracked, flowContext);
                ProcessCallArguments(call.Arguments, call.Method.Parameters, assigned, diagnostics, pointerAliases, tracked, call.Syntax, flowContext);
                break;
            case BoundBaseInterfaceCallExpression call:
                ProcessExpression(call.Receiver, assigned, diagnostics, pointerAliases, tracked, flowContext);
                ProcessCallArguments(call.Arguments, call.Method.Parameters, assigned, diagnostics, pointerAliases, tracked, call.Syntax, flowContext);
                break;
            case BoundBaseClassCallExpression call:
                ProcessExpression(call.Receiver, assigned, diagnostics, pointerAliases, tracked, flowContext);
                ProcessCallArguments(
                    call.Arguments,
                    call.Method?.Parameters ?? ImmutableArray<ParameterSymbol>.Empty,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    call.Syntax,
                    flowContext);
                break;
            case BoundIndirectCallExpression call:
                ProcessExpression(call.Target, assigned, diagnostics, pointerAliases, tracked, flowContext);
                ProcessCallArguments(call.Arguments, call.ArgumentRefKinds, assigned, diagnostics, pointerAliases, tracked, call.Syntax, flowContext);
                break;
            case BoundClrConstructorCallExpression call:
                ProcessCallArguments(call.Arguments, call.ArgumentRefKinds, assigned, diagnostics, pointerAliases, tracked, call.Syntax, flowContext);
                break;
            case BoundClrConversionCallExpression call:
                ProcessExpression(call.Source, assigned, diagnostics, pointerAliases, tracked, flowContext);
                break;
            case BoundAssignmentExpression assign:
                ProcessExpression(assign.Expression, assigned, diagnostics, pointerAliases, tracked, flowContext);
                assigned.Add(assign.Variable);
                TrackPointerAlias(assign.Variable, assign.Expression, pointerAliases);
                break;
            case BoundIndirectAssignmentExpression indirect:
                ProcessExpression(indirect.Value, assigned, diagnostics, pointerAliases, tracked, flowContext);
                ProcessExpression(indirect.Pointer, assigned, diagnostics, pointerAliases, tracked, flowContext);
                if (TryResolvePointerTarget(indirect.Pointer, pointerAliases, out var indirectTarget))
                {
                    if (indirectTarget is not null)
                    {
                        assigned.Add(indirectTarget);
                    }
                }

                break;
            case BoundBinaryExpression bin
                when bin.Op.Kind is BoundBinaryOperatorKind.LogicalAnd
                    or BoundBinaryOperatorKind.LogicalOr
                    or BoundBinaryOperatorKind.NullCoalesce:
            {
                ProcessExpression(bin.Left, assigned, diagnostics, pointerAliases, tracked, flowContext);
                var rightAssigned = new HashSet<VariableSymbol>(assigned);
                var rightAliases = new Dictionary<VariableSymbol, VariableSymbol>(pointerAliases);
                ProcessExpression(bin.Right, rightAssigned, diagnostics, rightAliases, tracked, flowContext);
                break;
            }

            case BoundBinaryExpression bin:
                ProcessExpression(bin.Left, assigned, diagnostics, pointerAliases, tracked, flowContext);
                ProcessExpression(bin.Right, assigned, diagnostics, pointerAliases, tracked, flowContext);
                break;
            case BoundConditionalExpression conditional:
            {
                ProcessExpression(conditional.Condition, assigned, diagnostics, pointerAliases, tracked, flowContext);
                var whenTrueAssigned = new HashSet<VariableSymbol>(assigned);
                var whenTrueAliases = new Dictionary<VariableSymbol, VariableSymbol>(pointerAliases);
                ProcessExpression(
                    conditional.WhenTrue,
                    whenTrueAssigned,
                    diagnostics,
                    whenTrueAliases,
                    tracked,
                    flowContext);
                var whenFalseAssigned = new HashSet<VariableSymbol>(assigned);
                var whenFalseAliases = new Dictionary<VariableSymbol, VariableSymbol>(pointerAliases);
                ProcessExpression(
                    conditional.WhenFalse,
                    whenFalseAssigned,
                    diagnostics,
                    whenFalseAliases,
                    tracked,
                    flowContext);
                MergeConditionalFlow(
                    assigned,
                    pointerAliases,
                    [whenTrueAssigned, whenFalseAssigned],
                    [whenTrueAliases, whenFalseAliases]);
                break;
            }

            case BoundConditionalAddressExpression conditionalAddress:
            {
                ProcessExpression(
                    conditionalAddress.Condition,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    flowContext);
                var whenTrueAssigned = new HashSet<VariableSymbol>(assigned);
                var whenTrueAliases = new Dictionary<VariableSymbol, VariableSymbol>(pointerAliases);
                ProcessExpression(
                    conditionalAddress.WhenTrueOperand,
                    whenTrueAssigned,
                    diagnostics,
                    whenTrueAliases,
                    tracked,
                    flowContext);
                var whenFalseAssigned = new HashSet<VariableSymbol>(assigned);
                var whenFalseAliases = new Dictionary<VariableSymbol, VariableSymbol>(pointerAliases);
                ProcessExpression(
                    conditionalAddress.WhenFalseOperand,
                    whenFalseAssigned,
                    diagnostics,
                    whenFalseAliases,
                    tracked,
                    flowContext);
                MergeConditionalFlow(
                    assigned,
                    pointerAliases,
                    [whenTrueAssigned, whenFalseAssigned],
                    [whenTrueAliases, whenFalseAliases]);
                break;
            }

            case BoundSwitchExpression switchExpression:
            {
                ProcessExpression(
                    switchExpression.Discriminant,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    flowContext);
                var armAssigned = new List<HashSet<VariableSymbol>>(switchExpression.Arms.Length);
                var armAliases = new List<Dictionary<VariableSymbol, VariableSymbol>>(switchExpression.Arms.Length);
                foreach (var arm in switchExpression.Arms)
                {
                    var currentAssigned = new HashSet<VariableSymbol>(assigned);
                    var currentAliases = new Dictionary<VariableSymbol, VariableSymbol>(pointerAliases);
                    ProcessExpression(
                        arm.Guard,
                        currentAssigned,
                        diagnostics,
                        currentAliases,
                        tracked,
                        flowContext);
                    ProcessExpression(
                        arm.Result,
                        currentAssigned,
                        diagnostics,
                        currentAliases,
                        tracked,
                        flowContext);
                    armAssigned.Add(currentAssigned);
                    armAliases.Add(currentAliases);
                }

                if (armAssigned.Count > 0)
                {
                    MergeConditionalFlow(assigned, pointerAliases, armAssigned, armAliases);
                }

                break;
            }

            case BoundNullConditionalAccessExpression nullConditional:
            {
                ProcessExpression(
                    nullConditional.Receiver,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    flowContext);
                var whenNotNullAssigned = new HashSet<VariableSymbol>(assigned);
                var whenNotNullAliases = new Dictionary<VariableSymbol, VariableSymbol>(pointerAliases);
                ProcessExpression(
                    nullConditional.WhenNotNull,
                    whenNotNullAssigned,
                    diagnostics,
                    whenNotNullAliases,
                    tracked,
                    flowContext);
                break;
            }

            case BoundUnaryExpression un:
                ProcessExpression(un.Operand, assigned, diagnostics, pointerAliases, tracked, flowContext);
                break;
            case BoundAddressOfExpression aof:
                ProcessExpression(aof.Operand, assigned, diagnostics, pointerAliases, tracked, flowContext);
                break;
            case BoundDereferenceExpression deref:
                ProcessExpression(deref.Operand, assigned, diagnostics, pointerAliases, tracked, flowContext);
                break;
            case BoundConversionExpression conv:
                ProcessExpression(conv.Expression, assigned, diagnostics, pointerAliases, tracked, flowContext);
                break;
            default:
                new FunctionLiteralAndUseWalker(
                    assigned,
                    tracked,
                    diagnostics,
                    pointerAliases,
                    flowContext).VisitExpression(expression);
                break;
        }
    }

    private static void MergeConditionalFlow(
        HashSet<VariableSymbol> assigned,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
        IReadOnlyList<HashSet<VariableSymbol>> branchAssigned,
        IReadOnlyList<Dictionary<VariableSymbol, VariableSymbol>> branchAliases)
    {
        assigned.Clear();
        assigned.UnionWith(branchAssigned[0]);
        for (var i = 1; i < branchAssigned.Count; i++)
        {
            assigned.IntersectWith(branchAssigned[i]);
        }

        pointerAliases.Clear();
        foreach (var pair in branchAliases[0])
        {
            if (branchAliases.Skip(1).All(aliases =>
                aliases.TryGetValue(pair.Key, out var target)
                && ReferenceEquals(target, pair.Value)))
            {
                pointerAliases.Add(pair.Key, pair.Value);
            }
        }
    }

    private static void ProcessCallArguments(
        ImmutableArray<BoundExpression> arguments,
        ImmutableArray<ParameterSymbol> parameters,
        HashSet<VariableSymbol> assigned,
        DiagnosticBag? diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
        HashSet<VariableSymbol> tracked,
        SyntaxNode? callSyntax,
        ExpressionFlowContext? flowContext)
    {
        for (var i = 0; i < arguments.Length; i++)
        {
            var refKind = i < parameters.Length ? parameters[i].RefKind : RefKind.None;
            ProcessCallArgument(arguments[i], refKind, assigned, diagnostics, pointerAliases, tracked, callSyntax, flowContext);
        }
    }

    private static void ProcessCallArguments(
        ImmutableArray<BoundExpression> arguments,
        ImmutableArray<RefKind> refKinds,
        HashSet<VariableSymbol> assigned,
        DiagnosticBag? diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
        HashSet<VariableSymbol> tracked,
        SyntaxNode? callSyntax,
        ExpressionFlowContext? flowContext)
    {
        for (var i = 0; i < arguments.Length; i++)
        {
            var refKind = !refKinds.IsDefault && i < refKinds.Length ? refKinds[i] : RefKind.None;
            ProcessCallArgument(arguments[i], refKind, assigned, diagnostics, pointerAliases, tracked, callSyntax, flowContext);
        }
    }

    private static void ProcessCallArgument(
        BoundExpression argument,
        RefKind refKind,
        HashSet<VariableSymbol> assigned,
        DiagnosticBag? diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
        HashSet<VariableSymbol> tracked,
        SyntaxNode? callSyntax,
        ExpressionFlowContext? flowContext)
    {
        if (refKind != RefKind.None
            && argument is BoundAddressOfExpression address
            && TryGetSingleAddressedVariable(address.Operand, out var variable))
        {
            ProcessAddressEvaluation(
                address.Operand,
                assigned,
                diagnostics,
                pointerAliases,
                tracked,
                flowContext);

            if (refKind == RefKind.Ref && !assigned.Contains(variable))
            {
                diagnostics?.ReportVariableNotAssignedBeforeRef(
                    argument.Syntax?.Location ?? callSyntax?.Location ?? default(TextLocation),
                    variable.Name);
            }

            if (refKind == RefKind.Ref || refKind == RefKind.Out)
            {
                assigned.Add(variable);
            }

            return;
        }

        ProcessExpression(argument, assigned, diagnostics, pointerAliases, tracked, flowContext);
    }

    private static bool TryGetSingleAddressedVariable(
        BoundExpression expression,
        [NotNullWhen(true)] out VariableSymbol? variable)
    {
        switch (expression)
        {
            case BoundBlockExpression block:
                return TryGetSingleAddressedVariable(block.Expression, out variable);
            case BoundVariableExpression variableExpression:
                variable = variableExpression.Variable;
                return true;
            case BoundConditionalExpression conditional
                when TryGetSingleAddressedVariable(conditional.WhenTrue, out var whenTrue)
                    && TryGetSingleAddressedVariable(conditional.WhenFalse, out var whenFalse)
                    && ReferenceEquals(whenTrue, whenFalse):
                variable = whenTrue;
                return true;
            default:
                variable = null;
                return false;
        }
    }

    private static void ProcessAddressEvaluation(
        BoundExpression expression,
        HashSet<VariableSymbol> assigned,
        DiagnosticBag? diagnostics,
        Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
        HashSet<VariableSymbol> tracked,
        ExpressionFlowContext? flowContext)
    {
        switch (expression)
        {
            case BoundBlockExpression block when flowContext is { } context:
            {
                var exit = AnalyzeRegion(
                    new BoundBlockStatement(block.Syntax, block.Statements),
                    new HashSet<VariableSymbol>(assigned),
                    context.OutParams,
                    context.Function,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    context.MethodExitLabel);
                assigned.Clear();
                if (exit != null)
                {
                    assigned.UnionWith(exit);
                    ProcessAddressEvaluation(
                        block.Expression,
                        assigned,
                        diagnostics,
                        pointerAliases,
                        tracked,
                        flowContext);
                }
                else
                {
                    assigned.UnionWith(context.OutParams);
                    assigned.UnionWith(tracked);
                }

                break;
            }

            case BoundConditionalExpression conditional:
            {
                ProcessExpression(
                    conditional.Condition,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    flowContext);
                var whenTrueAssigned = new HashSet<VariableSymbol>(assigned);
                var whenTrueAliases = new Dictionary<VariableSymbol, VariableSymbol>(pointerAliases);
                ProcessAddressEvaluation(
                    conditional.WhenTrue,
                    whenTrueAssigned,
                    diagnostics,
                    whenTrueAliases,
                    tracked,
                    flowContext);
                var whenFalseAssigned = new HashSet<VariableSymbol>(assigned);
                var whenFalseAliases = new Dictionary<VariableSymbol, VariableSymbol>(pointerAliases);
                ProcessAddressEvaluation(
                    conditional.WhenFalse,
                    whenFalseAssigned,
                    diagnostics,
                    whenFalseAliases,
                    tracked,
                    flowContext);
                MergeConditionalFlow(
                    assigned,
                    pointerAliases,
                    [whenTrueAssigned, whenFalseAssigned],
                    [whenTrueAliases, whenFalseAliases]);
                break;
            }

            case BoundVariableExpression:
                break;

            default:
                ProcessExpression(
                    expression,
                    assigned,
                    diagnostics,
                    pointerAliases,
                    tracked,
                    flowContext);
                break;
        }
    }

    /// <summary>
    /// Fallback walker for expression/statement kinds the linear simulation
    /// has no explicit case for (channel receive/send/close, index and member
    /// access, interpolated strings, …). It routes nested flow-sensitive block
    /// and branch expressions back through <see cref="ProcessExpression"/> and:
    /// <list type="bullet">
    ///   <item>recursively analyzes nested function literals against the
    ///     assignment state at their capture point (the C# model: a use of a
    ///     captured local inside the literal is an error unless the local was
    ///     definitely assigned before the literal, or is assigned inside
    ///     it);</item>
    ///   <item>reports GS0522 for value reads of tracked no-zero-value
    ///     locals (issue #3316);</item>
    ///   <item>skips <c>&amp;v</c> subtrees: an address-of operand is a
    ///     ref/out argument position, not a value read — unassigned
    ///     ref-reads are GS0239/GS9003 territory, and reporting them here
    ///     would double-report against the ref-kind checks.</item>
    /// </list>
    /// </summary>
    private readonly record struct ExpressionFlowContext(
        ImmutableArray<ParameterSymbol> OutParams,
        FunctionSymbol Function,
        BoundLabel? MethodExitLabel);

    private sealed class FunctionLiteralAndUseWalker : BoundTreeWalker
    {
        private readonly HashSet<VariableSymbol> assigned;
        private readonly HashSet<VariableSymbol> tracked;
        private readonly DiagnosticBag? diagnostics;
        private readonly Dictionary<VariableSymbol, VariableSymbol> pointerAliases;
        private readonly ExpressionFlowContext? flowContext;

        public FunctionLiteralAndUseWalker(
            HashSet<VariableSymbol> assigned,
            HashSet<VariableSymbol> tracked,
            DiagnosticBag? diagnostics,
            Dictionary<VariableSymbol, VariableSymbol> pointerAliases,
            ExpressionFlowContext? flowContext)
        {
            this.assigned = assigned;
            this.tracked = tracked;
            this.diagnostics = diagnostics;
            this.pointerAliases = pointerAliases;
            this.flowContext = flowContext;
        }

        public override void VisitExpression(BoundExpression? node)
        {
            if (node == null)
            {
                return;
            }

            switch (node)
            {
                case BoundFunctionLiteralExpression literal:
                {
                    if (diagnostics == null)
                    {
                        return;
                    }

                    var lowered = (BoundBlockStatement)Lowerer.Lower(literal.Body);
                    AnalyzeWithCaptured(
                        lowered.PreEmitAnalysisBody ?? lowered,
                        literal.Function,
                        diagnostics,
                        literal.CapturedVariables.Where(variable => assigned.Contains(variable)),
                        literal.CapturedVariables.Where(variable => tracked.Contains(variable)));
                    return;
                }

                case BoundVariableExpression read:
                    CheckTrackedUse(read, assigned, tracked, diagnostics);
                    return;
                case BoundAddressOfExpression:
                    return;
                case BoundBlockExpression:
                case BoundBinaryExpression:
                case BoundConditionalExpression:
                case BoundConditionalAddressExpression:
                case BoundSwitchExpression:
                case BoundNullConditionalAccessExpression:
                    ProcessExpression(
                        node,
                        assigned,
                        diagnostics,
                        pointerAliases,
                        tracked,
                        flowContext);
                    return;
                default:
                    base.VisitExpression(node);
                    return;
            }
        }
    }
}
